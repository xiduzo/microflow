# ADR-0035 — The desktop CloudPerformer owns the flow's subscriptions, on broker sessions

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander

> **Decision:** on the desktop, one module owns the flow's MQTT subscriptions:
> the `CloudPerformer`. A single task holds the live set, applies reconciles one
> at a time in the order the runtime actor asked for them, and keeps the set a
> mirror of what the brokers hold. Each entry is keyed on the **broker session**
> that holds it, and the broker pool's change signal drives the retries. The
> pool lets the flow and the Connection Console hold the same topic filter side
> by side, and a broker connect is bounded and waits under no lock.

## Context

The desktop diffed the flow's subscriptions in a free function behind the
`flow_update` command, against a set kept in app state
(`AppState.figma_subscriptions`). It took a snapshot of that set, released the
lock for the broker I/O, and wrote the result back at the end. Four things
followed from that shape.

- **Overlapping reconciles lost updates.** Two `flow_update`s, or a
  `flow_update` and a runtime respawn ([ADR-0017](0017-wasm-fault-seam.md)),
  each read the same snapshot and the later write replaced the earlier one. The
  set then described a flow the runtime was not running.
- **The set described intent, not the brokers.** A subscribe that failed on the
  wire was recorded as made, and a failed unsubscribe was dropped from the set
  while the broker kept the topic. A topic whose broker was offline was skipped
  and left for "a later `flow_update`", which the editor does not send for an
  unchanged flow. A broker that was disconnected and connected again had
  forgotten every subscription while the set still listed them.
- **The handshake ran on what the flow wanted.** The design-tool announce
  ([ADR-0011](0011-figma-announce-protocol-in-core.md)) was computed from the
  desired topics, so Studio said `connected` for a Bridge ID whose subscription
  had not been made, and a `disconnected` for an offline broker was lost.
- **The pool had one callback per topic and an unbounded connect.**
  `MqttBroker` kept `HashMap<String, MessageCallback>`, so the Connection
  Console subscribing a topic a flow node held replaced the node's callback.
  `MqttManager::connect` held the pool's write lock while it dialled, with no
  timeout: a broker that accepted the TCP connection and then said nothing
  blocked every other broker and every flow update behind it.

The browser host had the same class of fault in its own shape
([ADR-0036](0036-browser-host-owns-subscription-state.md)).

## Decision

**D1 — One owner, behind two entry points.** `CloudPerformer`
(`apps/web/src-tauri/src/runtime/cloud_performer.rs`) is the cloud half of the
desktop [Runtime Host](../../CONTEXT.md#runtime-host). `perform(request)`
publishes what a turn recorded. `reconcile(wirings)` takes the runtime's
subscriber wirings and returns a `Reconciled` to wait on. No command, and no
other module, subscribes for the flow or holds its subscription set.

**D2 — One task applies reconciles in order.** `reconcile` only queues. A
single Tokio task owns the live set (`Subscriptions`) and applies one reconcile
at a time, in the order of the calls. The runtime actor makes those calls from
its own thread, after a flow update and after a respawn, so the subscriptions
converge on the flow the runtime is running however many updates overlap. The
task alone holds the set: there is no lock and no snapshot to go stale.

**D3 — The live set mirrors the brokers, per broker session.** A broker in the
pool is in one `BrokerSession { id, online, link }`
(`apps/web/src-tauri/src/mqtt/manager.rs`). The session starts when the broker
is first connected and ends when it is disconnected or connected with a
different URL or credentials. A connect with the same config repairs the
session: the new client adopts what the old one held, under the same id.
`link` is a new number each time the session's link comes up and the same for
as long as that link lasts; the performer tells every new link again that
Studio is there ([ADR-0011](0011-figma-announce-protocol-in-core.md)), because
a broker may have lost on the way what an earlier link told it. An
entry enters the live set only when `MqttBrokers::subscribe` returned the
session id (the SUBSCRIBE was written to the link), and leaves it only when the
unsubscribe was written or its session ended. A subscribe that failed, an
unsubscribe that failed, and a topic whose broker is offline or not connected
yet all stay a difference between the desired and the live set, and the next
reconcile acts on that difference.

**D4 — The pool drives the retries.** The task keeps the wirings it was last
given. `MqttBrokers::changes()` ticks when a session starts, ends or gets its
link back, and the task reconciles the kept wirings on every tick. Nothing has
to send the flow again, and nothing that connects or disconnects a broker has
to tell the performer. A reconcile that finds nothing to do touches no broker.

**D5 — Subscribers share a topic filter.** A subscription in the pool belongs
to a `Subscriber`: `Flow` or `Console` (`apps/web/src-tauri/src/mqtt/broker.rs`).
Each has its own callback and its own delivery on the same filter. A flow
subscription ends with its session; a console subscription stands for the
broker id and the pool makes it again on every session for that id, until the
console unsubscribes or the broker is removed from the settings. The client
sends a SUBSCRIBE every time a subscriber joins a filter, so the joiner gets
the retained value. Which subscriber hears which message, retained replays and
a broker's copies included, is the routing rule of
[ADR-0048](0048-routing-overlapping-subscriptions.md). The UNSUBSCRIBE goes out
when the last subscriber leaves. A console's unsubscribe ends its hold at once,
whatever the link does, and the UNSUBSCRIBE goes out when the link takes it; a
webview that starts loading a page drops every console subscription
(`MqttManager::forget_console`), since a reload runs no cleanup on the page.

**D6 — The announce follows the live set.** After the (un)subscribes of a
reconcile, `bridge_uids` reads which broker holds each Bridge ID from the live
set, and core's `figma_announce_actions` turns the change into publishes. A
Bridge ID is announced once its subscription is in place, and is announced on
a broker once the broker took its `connected`: a `connected` that did not get
through arrives again with a later reconcile, and a link coming back is one.
Nothing is announced on a link that is down: an arrival waits for the link,
and a `disconnected` is owed to its broker (`OwedGoodbye`) until the link is
back, the Bridge ID returns there, or the session ends. A `disconnected` that
failed on a link that is up is owed the same way. Right after an owed
`disconnected` goes out, `connected` is said once more on the broker the
Bridge ID is on now, because two broker ids can name one server. What a
session says when it is ended on purpose, and what the broker says for a link
that ends without a goodbye, is
[ADR-0049](0049-a-broker-session-leaves-its-goodbye-with-the-pool.md). The
policy itself is in ADR-0011.

**D7 — A connect is bounded, and a flow update does not wait for it.** One
connection attempt, from opening the transport to the broker's CONNACK, has
`CONNECT_TIMEOUT` (30 s, also `mqtt.js`'s default, so both hosts give up
together). The pool is not locked while an attempt runs, and a second `connect`
for the same connection joins the first instead of opening another link. Every
write to a link (SUBSCRIBE, UNSUBSCRIBE, PUBLISH, DISCONNECT) is bounded by
`WRITE_TIMEOUT` (10 s, `mqtt/broker.rs`); a write that is not through in time
fails, and its link is treated as dropped.
`flow_update` connects the flow's brokers that are not up, all at once, and
waits for them together for `BROKER_GRACE` (2 s,
`apps/web/src-tauri/src/runtime/commands.rs`). Then it applies the flow
whatever the brokers did; a late broker carries on in the background and gets
the flow's subscriptions through D4. The command returns after
`Reconciled::applied()`, so it resolves with every subscription that could be
made in place.

**D8 — The last settings win, and flow updates apply in the order they
arrive.** The pool keeps the settings it was last given per broker id, with a
generation. `connect` makes its config the broker's settings at the call;
`disconnect` and `remove` withdraw them. An attempt goes into the pool only if
its generation is still the broker's, checked under the pool lock; an attempt
whose settings were replaced or withdrawn is given up and its link closed.
`MqttManager::sync` takes the whole broker list: lists are numbered at the
call, applied one at a time, and a list that is no longer the newest is not
applied. Flow updates follow the same rule (`FlowUpdates`, `commands.rs`): they
are numbered as they arrive and handed to the runtime actor only while they are
the newest. An update still waiting for its brokers when a newer one arrives is
replaced: it is never applied and answers as the newer one does. A broker gets
one grace for each stretch of being down (`MqttManager::stretch`): updates
inside that stretch wait for what is left of it, later ones do not wait, and a
new grace starts once the broker came up or got other settings. Without the
single grace, a run of edits that each replaced the last and each waited a
full grace would keep the runtime from ever getting the flow.

**D9 — The status dots follow the pool.** The pool ticks whenever a broker's
status may have changed. `report_broker_statuses` (`mqtt/commands.rs`) turns
the ticks into the `mqtt-broker-status` event, sent only when the list differs
from the last one sent. Each list is a numbered **Status snapshot**
(`BrokerStatuses { seq, brokers }`); the event and the answer of
`mqtt_sync_brokers` can arrive in either order, and the webview keeps the one
with the higher `seq`.

## Considered options

- **Keep the set in app state and put a lock around the whole reconcile.** The
  lock would be held across broker I/O, and a respawn on the actor thread would
  wait behind a slow broker. Order would follow lock acquisition, not the order
  the runtime changed its wirings in.
- **Let the broker client own the flow's subscriptions across sessions**, as it
  does for the console. The pool would then decide which node a topic belongs
  to after a config change, which is the flow's knowledge, not the pool's.
- **Track retained replays with a "replay is over" marker.** MQTT has no such
  signal: a filter with no retained message, or a wildcard with several, never
  says the replay ended.

## Consequences

- A flow's subscriptions heal by themselves: a broker that comes up late, a
  link that bounces, a broker edited in the settings and a runtime respawn all
  end in the same reconcile.
- `MqttBrokers` (`runtime/services/mqtt.rs`) is the seam, with two adapters:
  `MqttManager` and `RecordingMqttBrokers`, an in-memory pool that keeps
  sessions and scripts failures. The performer's order, retry and announce
  rules are tested against it without a broker.
- **Live means sent, not granted.** On the desktop a subscription is live once
  the SUBSCRIBE is on the wire. A broker that refuses it in the SUBACK is
  logged by the client and not reported to the performer, so that topic stays
  in the live set and is not retried. The browser host reads the SUBACK.
- **The per-subscriber `seen` set only grows** while a subscription lives: one
  topic string per distinct topic that had a message under a wildcard. It is
  emptied on a re-subscribe after a reconnect and when the subscriber
  subscribes again. Forgetting earlier would deliver an old retained value
  twice.
- A flow update that meets an unreachable broker takes up to 2 s longer, once
  per stretch of that broker being down; the updates after that grace do not
  wait. A broker that answers after the grace is subscribed late, and messages
  published in between are missed unless retained.
- A replaced flow update answers `Ok` when the newer one was applied. The
  webview sends a flow again only on an error, and it has already sent the
  newer one.
- A `disconnected` owed to a broker is said as one of the session's last words
  when the session is ended on purpose with its link up
  ([ADR-0049](0049-a-broker-session-leaves-its-goodbye-with-the-pool.md)). A
  session that ends with its link down says nothing; the broker publishes the
  link's will, which covers one Bridge ID.
- A halted runtime reconciles an empty set of wirings: the flow's
  subscriptions go and the plugins hear that Studio left, without asking
  anything of the runtime that panicked. A page reload says no goodbye: the
  actor keeps running the flow.

## What this does NOT decide

- The desired set and its winner per topic. That is core's `reconcile_desired`
  ([ADR-0010](0010-subscription-diff-stays-per-host.md)); this host only diffs.
- The announce protocol: topics, payloads, retain flags and order are core's
  ([ADR-0011](0011-figma-announce-protocol-in-core.md)).
- The browser host, which owns its subscription state in its own way
  ([ADR-0036](0036-browser-host-owns-subscription-state.md)).
- The last words and the will of a broker session
  ([ADR-0049](0049-a-broker-session-leaves-its-goodbye-with-the-pool.md)).
- How an inbound message is routed to overlapping subscriptions
  ([ADR-0048](0048-routing-overlapping-subscriptions.md)).
- Reading the SUBACK on the desktop.

## References

- `apps/web/src-tauri/src/runtime/cloud_performer.rs` — `CloudPerformer`, `Reconciled`, `Subscriptions`, `bridge_uids`, `OwedGoodbye`.
- `apps/web/src-tauri/src/runtime/services/mqtt.rs` — `MqttBrokers`, `MqttError`, `RecordingMqttBrokers`.
- `apps/web/src-tauri/src/mqtt/manager.rs` — `MqttManager`, `BrokerSession`, `stretch`, `sync`, `StatusSnapshot`, the console's standing subscriptions.
- `apps/web/src-tauri/src/mqtt/broker.rs` — `Subscriber`, `route`, `CONNECT_TIMEOUT`, `WRITE_TIMEOUT`.
- `apps/web/src-tauri/src/mqtt/commands.rs` — `BrokerStatuses`, `report_broker_statuses`.
- `apps/web/src-tauri/src/runtime/commands.rs` — `flow_update`, `FlowUpdates`, `BROKER_GRACE`.
- `apps/web/src-tauri/src/runtime/host.rs` — the actor's two `reconcile` calls (flow update, respawn).
- `apps/web/src-tauri/tests/mqtt_pool.rs`, `tests/flow_update.rs`, `tests/support/fake_broker.rs` — the pool and `update_flow` over TCP against an in-process broker.
- `CONTEXT.md` § CloudPerformer, Broker session, MQTT Brokers.
