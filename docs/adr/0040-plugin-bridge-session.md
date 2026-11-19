# ADR-0040 — One plugin bridge session owns a plugin UI's settings, connection and presence

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander

> **Decision:** everything a design-tool plugin's UI does between its sandbox
> and the broker is one framework-free module, the **plugin bridge session**
> (`createPluginBridgeSession`, `packages/design-bridge/src/session.ts`). It
> owns the settings, the broker connection, the plugin's presence, the
> `DesignBridge` engine and the snapshot polling. A plugin's views read its
> state and call `saveSettings`. The broker sits behind a seam with two
> adapters, the plugins' MQTT client lives inside `@microflow/design-bridge`
> (there is no `@microflow/mqtt` package), and presence corrects itself from
> the status topic instead of relying on a pause.

## Context

[ADR-0028](0028-design-tool-bridge-protocol.md) gave the Figma and Penpot
plugins one protocol and one bridge engine. What ran that engine was still
spread out. A plugin UI mounted four hooks at its root (`usePluginStartup`,
`useMqttAutoConnect`, `useDesignBridge`, `useMqttSettingsForm`, all in
`packages/design-bridge/src/react.ts`), which passed state through two zustand
stores: the settings in `useAppStore`, the connection in `useMqttStore` from a
separate package, `@microflow/mqtt`. The order of the steps (say hello to the
sandbox, load the settings when it answers, connect, start the engine, poll)
was held by which effect ran first, and a listener that waited for a component
to mount could miss the sandbox's reply. The hooks did not run without a React
renderer and a live broker, so the order of the steps was not tested.

`@microflow/mqtt` was a shared package in name only: its three importers were
the two plugins and `packages/design-bridge`. Studio's broker client is its
own module in `apps/web/src/cloud/`. The package kept one callback per topic,
so a second subscriber replaced the first, and it replaced a connection by
ending the old one, waiting 500 ms and opening the new one. Nothing but that
pause stood between the old connection's last will (`disconnected`, retained)
and the new connection's `connected`. When the will arrived later than the
pause, or a second editor with the same Bridge ID closed, the plugin stayed
retained as `disconnected` on the broker while it was connected.

## Decision

**D1 — One session per plugin window.** `createPluginBridgeSession({ tool,
sandbox, storage, onInvalid, broker })` says hello to the sandbox, loads the
stored settings when it answers, connects with them, and polls the sandbox for
snapshots every `POLL_INTERVAL_MS` (250 ms). Its state is `{ settings,
settingsErrors, connection, studio, entries }`, read through `getState` and
`subscribe`; `useBridgeSession` and `useBridgeSettingsForm`
(`packages/design-bridge/src/react.ts`) are the React bindings and hold no
logic of their own. Each plugin builds exactly one session when its UI script
loads (`apps/figma-plugin/src/ui/channel.ts`,
`apps/penpot-plugin/src/ui/channel.ts`), and it lives as long as the window.
`saveSettings` validates (a parseable broker URL, a valid Bridge ID), replaces
the connection and stores the settings; stored settings that fail the rules
are shown with their errors and are not connected with. `settingsProblems`
gives those errors one line per setting, for a screen that shows the
connection but not the settings form.

**D2 — The broker is a seam with two adapters.** The session reaches a broker
through a `BrokerConnector` (`broker.ts`). `mqttBroker` (`mqtt-broker.ts`) is
mqtt.js over the platform WebSocket: it turns mqtt.js's own resubscribe off and
sends every filter in one SUBSCRIBE on each connect, lets a filter have several
subscribers, and drops a publish while the connection is down.
`createMemoryBroker` (`memory-broker.ts`) is the test adapter: retained
messages, last wills, per-level wildcards, and delivery in the order one
connection sent. The mqtt.js adapter is tested against `startPacketBroker`
(`packet-broker.ts`), a local MQTT 3.1.1 broker that logs every packet.

**D3 — The plugins' MQTT client is part of design-bridge.** The package
depends on `mqtt` directly. The broker URL grammar is `parseBrokerUrl`
(`broker-url.ts`), the topic matcher is `topicMatches` (`topic-filter.ts`),
which all three brokers in the package route by. It is the package's own
matcher, checked against its own cases (`topic-filter.test.ts`), not against
the shared table Studio's two hosts route by
(`apps/web/src/cloud/fixtures/topic-filter.json`).
The session is exported on its own subpath, `@microflow/design-bridge/session`;
the package root exports the protocol, the codec, the engine, the messages,
the sandbox routing and the pairing rule, none of which import mqtt.js, so
Studio's web code takes the protocol without the client.

**D4 — Presence heals itself; a replacement has no pause.** A new connection
replaces the old one at once: the old one is dropped without a goodbye, so the
broker publishes its last will. On every connect the session publishes
`connected` (retained) on `{tool}/status` and restarts the engine from
nothing. It also subscribes to every status topic of its Bridge ID and watches
its own: until the broker has sent its `connected` back, a `disconnected`
there is older than the announcement and is ignored; after that, a
`disconnected` means something else declared the plugin gone (the late will of
the connection it replaced, or of a second editor with the same Bridge ID),
and the session announces `connected` again.

**D5 — The sandbox side is one adapter per tool behind shared routing.** A
design tool implements `SandboxAdapter` (`readSnapshot`, `writeValue`;
`sandbox.ts`): `createFigmaAdapter` (`apps/figma-plugin/src/plugin/variables.ts`)
and `createPenpotAdapter` (`apps/penpot-plugin/src/plugin/tokens.ts`).
`createSandboxBridge(adapter, host, glue)` routes the UI's hello, snapshot
requests and writes to the adapter; `glue` carries what only that tool's host
can do (storage, toasts, links, resizing).

## Considered options

- **Keep `@microflow/mqtt` and build the session on top of it.** A package
  boundary with one consumer. The one-callback-per-topic store and the pause
  would have stayed where the session could not see them.
- **Keep the pause, or lengthen it.** A timer guesses how long a broker takes
  to publish a will. The status topic says what the broker did.
- **Keep the logic in hooks, behind a React context.** The order of the steps
  would still depend on mount order, and tests would still need a renderer.
- **Share Studio's broker client.** It serves a Runtime Host's subscription
  reconcile ([ADR-0036](0036-browser-host-owns-subscription-state.md)) and lives in the web app. A plugin needs one connection
  with a last will, in an iframe.

## Consequences

- A plugin is a sandbox adapter, host glue, a `SettingsStorage` and its views.
  A third design tool adds those four and nothing else.
- The session runs under `bun test` with the in-memory broker and no React
  (`session.test.ts`): the hello and settings order, replacing a connection, a
  retained will from an earlier window, a late will, a second editor.
- `packages/design-bridge` carries mqtt.js and two test brokers. The repo has
  two MQTT clients, this one and Studio's (`apps/web/src/cloud/mqtt-client.ts`),
  and a fix to one does not reach the other. The same holds for the topic
  matcher: the design-bridge `topicMatches` disagrees with 18 of the 95 cases
  in the shared table (`$`-topics, invalid filters and topic names, `$share`
  filters). The plugins subscribe only to `microflow/{bridgeId}/…` filters
  built from a validated Bridge ID, so none of those cases arises on their own
  subscriptions.
- The in-memory broker is a model. Where it differs from a real broker, the
  session tests prove the wrong thing; the packet broker covers the mqtt.js
  adapter only.
- The stored settings keep their shape, `{ state: { mqttConfig: { url,
  uniqueId, … } } }` under `SETTINGS_KEY`, because installed plugins hold it.
  The session's own name for `uniqueId` is `bridgeId`.
- Accepted residue: the session polls, because neither tool has a change event
  for variables. Two editors with the same tool and Bridge ID both publish the
  same topics; each announces again when the other closes. A publish while the
  connection is down is dropped; the engine publishes everything again on the
  next connect.

## What this does NOT decide

- The wire protocol: topics, wire IDs, values and the Bridge ID rule stay with
  [ADR-0028](0028-design-tool-bridge-protocol.md).
- Studio's side of presence, the announce policy of
  [ADR-0011](0011-figma-announce-protocol-in-core.md) and the hosts that
  perform it ([ADR-0035](0035-desktop-cloud-performer-owns-subscriptions.md), [ADR-0036](0036-browser-host-owns-subscription-state.md)).
- Certificate checking: `mqttBroker` connects over the platform's own
  WebSocket (`forceNativeWebSocket: true`) and passes no TLS option, so the
  browser's own check applies.
- Whether a design tool should push changes instead of being polled.

## References

- `packages/design-bridge/src/session.ts` — `createPluginBridgeSession`, `PluginBridgeState`, `SettingsStorage`, `POLL_INTERVAL_MS`.
- `packages/design-bridge/src/broker.ts`, `mqtt-broker.ts`, `memory-broker.ts`, `packet-broker.ts` — the broker seam, its adapters and the packet-level test broker.
- `packages/design-bridge/src/broker-url.ts`, `topic-filter.ts` — the URL grammar and the topic matcher.
- `packages/design-bridge/src/sandbox.ts` — `SandboxAdapter`, `createSandboxBridge`.
- `packages/design-bridge/src/react.ts` — `useBridgeSession`, `useBridgeSettingsForm`.
- `apps/figma-plugin/src/ui/channel.ts`, `apps/penpot-plugin/src/ui/channel.ts` — where each plugin builds its session.
- `CONTEXT.md` § Plugin bridge session, Sandbox adapter.
