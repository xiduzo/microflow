# ADR-0048 — A message reaches each matching subscription once, by subscription identifier and one filter table in both hosts

- **Status:** accepted (2026-11-19); amended (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander
- **Refines:** [ADR-0035](0035-desktop-cloud-performer-owns-subscriptions.md), [ADR-0036](0036-browser-host-owns-subscription-state.md)

> **Decision:** both Runtime Hosts route an inbound MQTT message the same way.
> Both speak MQTT 5 and subscribe each topic filter with a subscription
> identifier of its own. A message goes to exactly the filters whose
> identifiers it carries, so each subscription gets it once. One matching rule,
> held to one shared case table
> (`packages/design-bridge/fixtures/topic-filter.json`), guards that delivery
> and routes a message that carries no identifier. A retained replay goes only
> to a subscription that has not had a message on that topic since it joined.
> A topic that cannot be published on is refused before it reaches the broker.

## Context

One connection holds many topic filters: several Mqtt nodes, the design
variable node, and on the desktop the Connection Console beside the flow. A
PUBLISH from the broker says which subscription it is for only through MQTT 5
subscription identifiers. Without them the client has to decide again what the
broker decided. Four faults followed from deciding it in two places, twice.

- **Wildcards reached nothing in the browser.** A browser broker session handed
  a message to the handler of its exact topic, so a node on `sensors/#` was
  subscribed and never heard a message.
- **The two hosts matched differently.** The desktop matcher disagreed with the
  browser one on 20 of the table's first 76 cases: `sport/#` did not match
  `sport`, `$share/…` and `$queue/…` filters never matched, a `#` in the middle
  of a filter matched, and a leading wildcard matched a `$SYS` topic.
- **A broker may send one copy per matching subscription.** MQTT 3.1.1 §3.3.5
  allows it, mosquitto 2 and EMQX do it, HiveMQ sends one copy for all. A
  client that delivers every copy to every matching filter makes `sensors/#`
  and `sensors/kitchen` each fire twice.
- **A retained value was replayed to a node that had it.** Adding an
  overlapping filter asks the broker for its retained messages again, and the
  browser ignored the RETAIN flag: a Counter behind the older filter counted
  the same value twice. The desktop already had a rule for that.

A wildcard in a PUBLISH topic is a protocol error: the broker closes the
connection, which drops every subscription on it.

## Decision

**D1 — One filter table, one TypeScript matcher.** `topic-filter.json`
(`packages/design-bridge/fixtures/`) holds `[filter, topic, matches]` cases
(95). There is one TypeScript `topicMatches`, in `@microflow/design-bridge`
(`src/topic-filter.ts`). The design-tool plugins' three brokers route by it
(`memory-broker.ts`, `mqtt-broker.ts`, `packet-broker.ts`), and Studio's
browser host re-exports it (`apps/web/src/cloud/topic-filter.ts`) for its
broker sessions and the Connection Console. The desktop's
`MqttBroker::topic_matches` (`src-tauri/src/mqtt/broker.rs`) is the Rust
twin. All are tested against the table (`design-bridge/src/topic-filter.test.ts`,
`apps/web/src/cloud/topic-filter.test.ts`, `src-tauri/tests/mqtt_routing.rs`).
Its rules: `x/#` matches `x`; a shared subscription (`$share/<group>/…`,
`$queue/…`) matches by the filter behind its prefix; a `#` anywhere but last
makes the filter invalid; a leading `+` or `#` does not match a topic that
starts with `$`; an invalid filter or topic name matches nothing.

**D2 — One delivery per subscription and message, by subscription
identifier.** Both hosts connect with MQTT 5 (the desktop's
`mqtt-endpoint-tokio` client, and `mqtt.js` with `protocolVersion: 5` in the
browser). Each distinct filter a client holds gets a client-assigned
subscription identifier (1 to 268 435 455) that stays the filter's for as long
as it is held: across a reconnect, a link renewed for a will
([ADR-0049](0049-a-broker-session-leaves-its-goodbye-with-the-pool.md)) and,
on the desktop, a client that takes over from another (`MqttBroker::adopt`).
The broker tags each PUBLISH with the identifiers of the subscriptions it is
for (MQTT 5 §3.3.4): one copy with all of them, or one copy per subscription
with its own. A message goes to the filters it names, each once, and only when
the filter also matches its topic. An identifier that names a filter the topic
does not match delivers nothing there.

- **A PUBLISH with no identifier** (a broker fault) goes to every filter its
  topic matches, once per copy. That is logged once per connection.
- **A broker that announces no subscription identifiers** in its CONNACK
  (`Subscription Identifiers Available` = 0) is sent none, and every message
  on that link is routed by topic, as above.

The desktop keeps the identifiers in `Subscriptions` (`mqtt/broker.rs`), and
`route` delivers by them; the browser keeps them per `Subscription` in
`BrokerConnections` (`cloud/mqtt-client.ts`).

**D3 — The retained-seen rule, in both hosts.** A client sends a SUBSCRIBE
whenever a subscriber joins a filter, so the joiner gets the retained value. A
message flagged RETAIN goes to a subscription only if it has had no message on
that exact topic since it joined; an unflagged message goes to everyone. Each
subscription keeps the set of topics it has had (`seen`); the set is emptied
when the subscriber subscribes again and when the link is re-subscribed after
a reconnect.

**D4 — Only a topic name is published.** The browser performer drops a publish
whose topic holds a wildcard or is empty (`isTopicName`), with one warning; the
desktop packet builder refuses it. A topic filter whose Bridge ID level holds a
wildcard names no Bridge ID (`bridge_uid` in core, `bridgeUid` in
`@microflow/design-bridge`), so Studio never announces on a wildcard topic.

## Considered options

- **A copy window.** Up to `n - 1` more messages on a topic with the same
  payload within 50 ms of the first are taken for its copies and dropped. It
  works on MQTT 3.1.1 too, but at QoS 0 nothing tells a copy from a new
  message: a publisher that repeats a payload within the window loses the
  repeat, and a copy that arrives later is delivered again.
- **A 3.1.1 fallback** next to MQTT 5. It would keep the copy window alive for
  the brokers that need it, and two routing rules to test in each host.
- **One filter per topic in the client**, refusing an overlap. A user who adds
  `sensors/#` beside `sensors/kitchen` has done nothing wrong.
- **Two matchers, each tested on its own.** That is how the hosts came to
  disagree.

## Consequences

- An Mqtt node on a wildcard filter receives its messages in both hosts, with
  the topic each was published on.
- A repeated payload is a new message, however soon it follows, and a copy for
  another filter is no message for this one.
- **Both hosts and the Connection Console need an MQTT 5 broker.** A broker
  that speaks only MQTT 3.1.1 refuses the link, and Studio cannot use it. The
  design-tool plugins still connect with MQTT 3.1.1.
- **A broker that announces no subscription identifiers is routed by topic.**
  There a message that matches several of the client's filters reaches each of
  them once per copy the broker sends.
- The `seen` set only grows while a subscription lives: one topic string per
  distinct topic that had a message. Forgetting earlier would replay an old
  retained value.
- The design-tool plugins and Studio's browser host share one matcher, so a
  change to the table reaches both at once. The plugins drop a publish on a
  topic that is not a topic name, as Studio does.

## What this does NOT decide

- Which node owns a topic two nodes want: core's `reconcile_desired`
  ([ADR-0010](0010-subscription-diff-stays-per-host.md)).
- Which topics a broker holds for the flow, and when they are asked for again
  ([ADR-0035](0035-desktop-cloud-performer-owns-subscriptions.md),
  [ADR-0036](0036-browser-host-owns-subscription-state.md)).

## References

- `packages/design-bridge/fixtures/topic-filter.json` — the case table.
- `packages/design-bridge/src/topic-filter.ts`, `topic-filter.test.ts` — `topicMatches`, `isTopicName`.
- `apps/web/src/cloud/topic-filter.ts`, `topic-filter.test.ts` — the browser host's re-export, held to the table.
- `apps/web/src/cloud/mqtt-client.ts` — `BrokerConnections`, its subscription identifiers.
- `apps/web/src-tauri/src/mqtt/broker.rs` — `Subscriptions`, `route`, `MqttBroker::topic_matches`.
- `apps/web/src-tauri/tests/mqtt_routing.rs` — the desktop against the table.
- `CONTEXT.md` § Broker session, MQTT Brokers, Browser CloudPerformer.
