# ADR-0049 — Studio leaves its goodbye with every broker link: last words, one will per link, and every new link told again

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander
- **Refines:** [ADR-0035](0035-desktop-cloud-performer-owns-subscriptions.md), [ADR-0036](0036-browser-host-owns-subscription-state.md), [ADR-0028](0028-design-tool-bridge-protocol.md)

> **Decision:** on both Runtime Hosts, the first goodbye a broker is owed (the
> `disconnected` of the first Bridge ID announced there, in uid order) is the
> MQTT will of every link to that broker, so the broker says it when a link
> ends without a goodbye. A link carries one will, fixed when it is opened;
> when the will changes, the host opens a new link that carries it, moves the
> subscriptions there, and then closes the old link with a DISCONNECT (make
> before break). Every new link is told again that Studio is there and asked
> for the variables. A connection ended on purpose says its goodbyes itself
> first; on the desktop the pool says them, as the session's last words.

## Context

Studio tells the design-tool plugins it is there with a retained `connected`
on `microflow/{uid}/app/status` ([ADR-0011](0011-figma-announce-protocol-in-core.md)).
Whatever ends Studio's presence on a broker has to replace it with
`disconnected`, or the plugins show a Studio that is gone.

- **A session ended on purpose said nothing on the desktop.** A broker that was
  removed, disconnected or given other settings ended its session in the pool;
  the performer heard of that afterwards, with no link left to publish on.
- **A link that ended without a goodbye said nothing in either host.** The app
  or tab crashing, the machine losing power or the network going left the
  retained `connected` behind ([ADR-0028](0028-design-tool-bridge-protocol.md)).
- **MQTT gives one will per link, fixed at CONNECT.** The flow, and with it the
  Bridge IDs to announce, reaches the host after the broker is connected, and
  changes while the link is up.
- **A broker may forget what a link told it.** A broker that restarted loses the
  retained status it did not persist, and what the plugins sent while a link was
  down never reached Studio.

## Decision

**D1 — Last words, per desktop session.** The desktop performer keeps, per
broker, the goodbyes core's `figma_announce_actions` gives for its announced
Bridge IDs leaving that broker, plus the `disconnected` it owes there
(`leave_last_words` in `runtime/cloud_performer.rs`). It hands a broker the
list when it changes, tagged with the session it is for; a list for a session
that has ended is ignored. The pool carries the messages without knowing what
they are. When it ends a session on purpose (disconnect, remove, other
settings, the app quitting) it publishes them first, if the link is up,
bounded by `LAST_WORDS_TIMEOUT` (2 s, all of them) and with the pool unlocked;
then it says DISCONNECT. The browser says its goodbyes itself before it closes
a connection on purpose (dispose, an engine fault, a broker removed or given
other settings, `pagehide`), from the `farewells` it asked the policy for at
announce time ([ADR-0036](0036-browser-host-owns-subscription-state.md)). A
link that is down gets nothing.

**D2 — The first goodbye is the will.** On the desktop
`MqttManager::set_last_words` makes the first message of the list the
session's will (`MqttBroker::set_will`). In the browser the performer gives
each broker's first goodbye in `farewells` to `BrokerConnections.setWill`. A
message no CONNECT can carry (a wildcard or empty topic, a topic or payload
over 65 535 bytes) is no will. A deliberate exit ends with a DISCONNECT, which
tells the broker to drop the will; `pagehide` says the goodbyes and leaves the
will in place.

**D3 — A changed will renews the link, make before break.** When the link
that is up carries another will, the host opens a new link with a new random
client id and the new will, moves every subscription there, and then sends
DISCONNECT on the old link. The connection stays up to its callers throughout.
What each subscription has seen moves with it, so the new link's retained
replay is not news ([ADR-0048](0048-routing-overlapping-subscriptions.md)). A
link that is down carries the new will when it is back. On the desktop
`MqttBroker::renew_link` gives up, leaving the old link as it is, when the new
link cannot be opened, the old one dropped meanwhile, the client was
disconnected, or the will changed again. In the browser a renewal that has not
connected within `RENEW_MS` (5 s) is closed, and the old link keeps its will.

**D4 — Every new link is told again.** Each host numbers a broker's links: the
desktop `BrokerSession.link`, the browser `BrokerConnections.link()`. A new
number, the first link or a reconnect (`mqtt.js`'s own included), is told
again that Studio is there: `connected` and the variables request for every
Bridge ID announced on that broker. A link renewed for a will keeps its
number: it is the same link to the plugins.

**D5 — Quitting the desktop app ends every session at once.** On
`RunEvent::Exit` the app runs `MqttManager::disconnect_all` within
`QUIT_GRACE` (2.5 s): every session says its last words and DISCONNECT at the
same time. A link that is not through by then is left to the operating system
to close, and its broker publishes the will.

## Considered options

- **Open the link with the will and connect late, once the flow is known.** The
  Connection Console and the status dots need the link before any flow exists,
  and the will changes with the flow while the link is up.
- **Break before make**: DISCONNECT the old link, then open one with the new
  will. Every message in the gap would be lost and every subscription made
  again from nothing.
- **One link per Bridge ID**, so every Bridge ID has its own will. A connection
  per announced Bridge ID for a goodbye only one of them is likely to need.

## Consequences

- A broker that is removed, disconnected or given other settings, and the app
  or page going away, replace the retained `connected` with `disconnected` for
  every Bridge ID announced there, if the link is up.
- **One will per link covers one Bridge ID.** A crash leaves `disconnected` for
  the first Bridge ID on the list and the retained `connected` for any other
  Bridge ID announced on that broker.
- A broker publishes a will only once it notices the link is gone: for a frozen
  tab or a lost network that is about one and a half keepalive periods (about
  90 s in the browser).
- A will change costs a second link for a moment. Messages published on the
  broker between the swap and the new link's SUBACK are lost, as ones published
  while a link is down are.
- A page reload on the desktop says no goodbye: the actor keeps running the
  flow, and its sessions stay.

## What this does NOT decide

- What a goodbye says: core's policy ([ADR-0011](0011-figma-announce-protocol-in-core.md)).
- The plugins' own presence, which has a will of its own
  ([ADR-0040](0040-plugin-bridge-session.md)).

## References

- `apps/web/src-tauri/src/runtime/cloud_performer.rs` — `leave_last_words`, `OwedGoodbye`, `Said::link`.
- `apps/web/src-tauri/src/runtime/services/mqtt.rs` — `MqttBrokers::set_last_words`.
- `apps/web/src-tauri/src/mqtt/manager.rs` — `MqttManager::set_last_words`, `BrokerSession`, `LAST_WORDS_TIMEOUT`, `QUIT_GRACE`, `disconnect_all`.
- `apps/web/src-tauri/src/mqtt/broker.rs` — `LastWord`, `MqttBroker::set_will`, `MqttBroker::renew_link`.
- `apps/web/src/cloud/cloud-performer.ts` — `farewells`, the will each broker is given.
- `apps/web/src/cloud/mqtt-client.ts` — `BrokerConnections.setWill`, `link`, `RENEW_MS`.
- `apps/web/src-tauri/src/lib.rs` — the exit handler.
- `CONTEXT.md` § Broker session, Browser CloudPerformer.
