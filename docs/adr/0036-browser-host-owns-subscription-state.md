# ADR-0036 — The browser host owns its subscription state and settles broker settings

- **Status:** accepted (2026-11-19); amended (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander

> **Decision:** in the browser, which topics a broker holds for the flow is
> state the host keeps, not state `mqtt.js` keeps. A subscription is live once
> the broker's SUBACK accepted it; whatever is wanted and not live is asked for
> again at every reconcile and on every connect. A broker's connection follows
> its settled settings ([ADR-0046](0046-connection-settings-settle-in-their-store.md))
> for as long as the flow uses the broker. Before a connection is replaced or
> closed it says `disconnected` for every Bridge ID announced on it, as the
> policy gave it when the Bridge ID was announced.

## Context

The browser [CloudPerformer](../../CONTEXT.md#browser-cloudperformer) reconciles
the flow's subscriptions over MQTT-over-WebSocket. It did so by recording the
desired set as live the moment it asked: `reconcile` called `subscribe` and
then stored `desired` as the live set, whatever the broker answered.

- **A subscribe that did not happen was never retried.** A broker that was not
  configured yet, a URL still being typed, a refused topic: each was logged and
  recorded as live. The next `reconcile` diffed against that set and found
  nothing to do. The editor does not send an unchanged flow again, so only a
  reload repaired it.
- **`mqtt.js` kept a second copy.** With its default `resubscribe`, the client
  re-made its own list of topics after a reconnect, without a callback, so a
  refusal went unseen, and it answered a later subscribe for a topic it
  remembered without asking the broker.
- **A connection never followed its settings.** `BrokerConnections` created one
  client per broker id, lazily, and reused it. Editing a broker's URL or
  password changed nothing until reload, and a broker deleted from the settings
  stayed connected.
- **The announce ran on the wanted set.** Studio said `connected` for a Bridge
  ID whose subscription had not been made, and a connection that was dropped
  left a retained `connected` behind.

Making the connection follow the settings exposed a further force. The MQTT
configuration form changes a field at every keystroke, and most prefixes of a
URL being typed are URLs a WebSocket can be opened to. Following what is typed
would open a connection per keystroke and announce a Bridge ID to whatever
answered. The settings therefore settle before anything connects
([ADR-0046](0046-connection-settings-settle-in-their-store.md)).

The desktop host has a broker pool with a change signal to hang its retries on
([ADR-0035](0035-desktop-cloud-performer-owns-subscriptions.md)). A browser has
no pool: the stored broker settings are the only thing that changes.

## Decision

**D1 — Three sets, each with one meaning.** `CloudPerformer`
(`apps/web/src/cloud/cloud-performer.ts`) keeps `wanted` (the last reconciled
set), `live` (what the brokers hold, always a part of `wanted`) and `announced`
(Bridge ID to the broker it was announced on). Unsubscribes are diffed against
`wanted`; subscribes are diffed against `live`, so a topic a broker does not
hold is asked for again at every `reconcile`.

**D2 — Live means the broker accepted it.** `BrokerConnections`
(`apps/web/src/cloud/mqtt-client.ts`) keeps, per broker, the topics asked of it
and whether each is held. It reports through a `SubscriptionWatcher`: `true`
once the SUBACK accepted the topic, `false` when the broker refused it. A link
lost before the answer changes nothing. On every `connect` event it sends a
SUBSCRIBE for every topic of the session, held or not, because a broker forgets
a clean session's subscriptions when the link drops. `mqtt.js` is a transport
only: the client is created with `clean: true` and `resubscribe: false`.

**D3 — A connection follows its broker's settings.** `reach(brokerId)` resolves
the broker through `CloudDeps.resolveBroker` and calls
`BrokerConnections.configure`: open when there is no connection, replace when
the URL or credentials differ, close when the broker is gone or its URL is not
one a browser can open (`isBrowserReachableBroker`,
`apps/web/src/cloud/broker-url.ts`). A replaced or closed connection takes its
subscriptions out of `live`; a new one is asked for everything the flow wants
on that broker. `reach` runs at every publish and for every broker of a
`reconcile`, including the brokers the flow just stopped using.

**D4 — A connection follows the settled settings, at once.** The performer
watches the stored settings through `CloudDeps.watchBrokers`
(`onBrokerSettingsChange` in `apps/web/src/cloud/mqtt-broker.ts`), which
reports the ids of brokers whose settled settings were added, changed or
removed. What is typed into the settings form reaches neither `watchBrokers`
nor `resolveBroker` until it settles in the store
([ADR-0046](0046-connection-settings-settle-in-their-store.md)), so the
performer keeps no wait of its own: a reported broker in use is made to follow
its settings at once. This is the browser's counterpart of the desktop pool's
change signal.

**D5 — A connection lasts as long as the flow uses its broker.** A broker is
in use while the flow wants a topic on it, and for `BROKER_IDLE_MS` (60 s)
after something was published on it; only a broker in use has a connection.
`reconcile` is given subscriptions, not the brokers that publishing nodes
refer to, so a publish-only broker stays connected while publishes keep coming
and is let go of once idle. A broker the flow stops subscribing on is reached
once more after the announce said `disconnected` there; without another use
its connection closes, so the wire ends UNSUBSCRIBE, `disconnected`,
DISCONNECT. An edit to a broker the flow does not use causes no traffic.

**D6 — A flow's publish is for now; a status publish waits.** A flow's
publish (`mqttPublish`) is sent on a link that is up and dropped on one that
is down, with one warning per outage, as on the desktop. The publishes that
open a broker's connection are kept for its first connect, for
`OPENING_PUBLISH_MS` (5 s) at most. A status publish of the handshake
(`connected`, the variables request, `disconnected`) is handed to the
connection whatever its link: `mqtt.js` stores it and sends it when the link
is back. A connection with a stored `disconnected` and no other use is kept
for `BROKER_IDLE_MS` for its link to return. A closing connection drops its
handlers at once and waits for its outstanding answers for `CLOSE_GRACE_MS`
(2 s) at most before the socket is cut.

**D7 — Announce on the live set, and say goodbye before leaving.** The
design-tool handshake ([ADR-0011](0011-figma-announce-protocol-in-core.md))
runs after every change to `live`, on the connections as they are. Each time
the announce changes something, the performer also asks the policy what each
broker's goodbye is, the publishes for the Bridge IDs announced there
vanishing, and keeps them (`farewells`). Before `BrokerConnections` replaces or
closes a connection whose link is up, or disposes all of them, it calls back
into the performer (`sayGoodbye`), which publishes what the policy gave at
announce time. A goodbye therefore needs no engine: a dispose after an engine
fault, whose policy cannot be asked any more, still says `disconnected`. The
client sends what was published before its DISCONNECT. `announced` is updated
only after the publishes were handed to a connection. The page going away
(`pagehide`) says every goodbye and leaves the connections as they are (best
effort: it reaches the broker if the socket gets it out); a page that comes
back from the back/forward cache (`pageshow` with `persisted`) announces
again. The policy is reached through the
[RuntimeBridge](../../CONTEXT.md#runtimebridge) like every call into the
engine ([ADR-0017](0017-wasm-fault-seam.md)).

## Considered options

- **Leave subscription state to `mqtt.js`.** Its resubscribe has no callback
  per topic, so a refusal is invisible, and its memory of a topic answers a
  later subscribe without the broker being asked. The host could not say what
  is live.
- **Keep the settings' settle wait in the performer.** Only the browser
  performer would wait; the desktop sync, the status probe and the console
  would still follow every keystroke. Where the wait lives is
  [ADR-0046](0046-connection-settings-settle-in-their-store.md).

## Consequences

- A flow whose broker is configured after the flow loaded, whose broker URL is
  corrected, or whose topic was refused once, subscribes without a reload.
- The same broker is asked for a topic once per connect: a topic asked between
  the CONNACK and the `connect` event is not asked twice, so retained messages
  are not replayed twice.
- **A pause while typing connects to what was typed.** After a pause longer
  than the settle time the settings settle, and the performer connects to the
  URL so far, with the broker's stored credentials. If that is a broker, the
  flow's topics are subscribed there and a Bridge ID announced, and taken back
  when the URL is typed on.
- A flow's publish to a broker without a connection, or on a link that is
  down, is dropped, not queued: a minute of LED commands replayed when a broker
  comes back is worse than none, and nothing piles up for a broker that stays
  away.
- A connection whose link is down cannot be told `disconnected`. Every goodbye
  is a will instead: the first on the connection's link, each other on a will
  link of its own. A tab that crashes has the broker say `disconnected` for
  every Bridge ID there
  ([ADR-0049](0049-a-broker-session-leaves-its-goodbye-with-the-pool.md)).
- A `pagehide` goodbye is best effort: a browser may close the socket before
  the publishes are out.
- The Connection Console's browser transport opens its own `mqtt.js`
  connection and is outside this state: testing a broker by hand does not
  touch the flow's subscriptions.

## What this does NOT decide

- The desired set and the diff rule: core's `reconcile_desired` and the
  per-host diff ([ADR-0010](0010-subscription-diff-stays-per-host.md)).
- The announce protocol ([ADR-0011](0011-figma-announce-protocol-in-core.md)).
- A broker status dot that shows the flow's connections in the browser. The
  dots are filled by a reachability probe (`apps/web/src/cloud/cloud-capabilities.ts`)
  and, on the configuration page, by the Connection Console's own connection.
- A relay for brokers a browser cannot reach. Browser cloud stays direct-only
  ([ADR-0009](0009-cloud-sans-io-capability.md)).

## References

- `apps/web/src/cloud/cloud-performer.ts` — `CloudPerformer`, `CloudDeps`, `BROKER_IDLE_MS`, `reach`, `sayGoodbye`, `farewells`, `leave`, `rejoin`.
- `apps/web/src/cloud/mqtt-client.ts` — `BrokerConnections`, `MqttClientFactory`, `SubscriptionWatcher`, `defaultMqttClientFactory`, `OPENING_PUBLISH_MS`, `CLOSE_GRACE_MS`.
- `apps/web/src/cloud/mqtt-broker.ts` — `resolveStoredBroker`, `onBrokerSettingsChange`, `BROKER_SETTINGS_SETTLE_MS`.
- `apps/web/src/runtime/flow-reactor.ts` — `pagehide` / `pageshow` to `leave` / `rejoin`.
- `apps/web/src/cloud/mqtt-subscriptions.ts` — `diffSubscriptions`, `uidBrokers`.
- `apps/web/src/cloud/broker-url.ts` — `isBrowserReachableBroker`.
- `apps/web/src/cloud/cloud-performer.test.ts` — the performer on a fake client; `mqtt-client.real.test.ts` with `scripted-broker.ts` — the real `mqtt.js` client against a scripted broker on a loopback WebSocket.
- `apps/web/src/board/board-controller.ts` — where `resolveBroker` and `watchBrokers` are supplied.
- `CONTEXT.md` § Browser CloudPerformer.
