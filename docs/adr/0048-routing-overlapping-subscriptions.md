# ADR-0048 — A message reaches each matching subscription once, by one filter table in both hosts

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander
- **Refines:** [ADR-0035](0035-desktop-cloud-performer-owns-subscriptions.md), [ADR-0036](0036-browser-host-owns-subscription-state.md)

> **Decision:** both Runtime Hosts route an inbound MQTT message the same way.
> A client decides again which of its own topic filters a message matches,
> with one matching rule held to one shared case table
> (`apps/web/src/cloud/fixtures/topic-filter.json`). Each subscription that
> matches gets the message once: the copies a broker may send for overlapping
> filters are dropped within a short window, and a retained replay goes only to
> a subscription that has not had a message on that topic since it joined. A
> topic that cannot be published on is refused before it reaches the broker.

## Context

One connection holds many topic filters: several Mqtt nodes, the design
variable node, and on the desktop the Connection Console beside the flow. A
PUBLISH from the broker does not say which subscription it is for, so the
client has to decide again what the broker decided. Four faults followed from
deciding it in two places, twice.

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

**D1 — One filter table.** `topic-filter.json` holds `[filter, topic,
matches]` cases (95). The browser's `topicMatches` (`cloud/topic-filter.ts`)
and the desktop's `MqttBroker::topic_matches` (`src-tauri/src/mqtt/broker.rs`)
are tested against it (`topic-filter.test.ts`, `src-tauri/tests/mqtt_routing.rs`).
Its rules: `x/#` matches `x`; a shared subscription (`$share/<group>/…`,
`$queue/…`) matches by the filter behind its prefix; a `#` anywhere but last
makes the filter invalid; a leading `+` or `#` does not match a topic that
starts with `$`; an invalid filter or topic name matches nothing.

**D2 — One delivery per subscription and message.** The first copy of a live
message goes to every filter it matches. When `n` filters match, up to `n - 1`
more live messages on that topic with the same payload within the copy window
(`COPY_WINDOW` on the desktop, `COPY_WINDOW_MS` in the browser, both 50 ms) are
taken for its copies and go to nobody. Any other message on the topic ends the
wait.

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

- **MQTT 5 subscription identifiers.** The broker tags each PUBLISH with the
  ids of the subscriptions it is for, which makes D2 exact. The desktop client
  speaks MQTT 5; the browser client connects with `mqtt.js`'s default, MQTT
  3.1.1, and not every broker a user points Microflow at speaks 5. Each host
  would also have to carry an id per filter through every reconnect. The
  heuristic works on both versions. It stays the exact alternative.
- **One filter per topic in the client**, refusing an overlap. A user who adds
  `sensors/#` beside `sensors/kitchen` has done nothing wrong.
- **Two matchers, each tested on its own.** That is how the hosts came to
  disagree.

## Consequences

- An Mqtt node on a wildcard filter receives its messages in both hosts, with
  the topic each was published on.
- **The copy window is a heuristic.** At QoS 0 nothing tells a copy from a new
  message. On a broker that sends one copy, a publisher that repeats a payload
  within 50 ms, while two of the client's filters overlap, loses the repeat. A
  copy that arrives later than 50 ms is delivered again.
- The `seen` set only grows while a subscription lives: one topic string per
  distinct topic that had a message. Forgetting earlier would replay an old
  retained value.
- The design-tool plugins match topics with their own `topicMatches`
  (`packages/design-bridge/src/topic-filter.ts`), which is not held to the
  table. They subscribe only to filters built from a validated Bridge ID.

## What this does NOT decide

- Which node owns a topic two nodes want: core's `reconcile_desired`
  ([ADR-0010](0010-subscription-diff-stays-per-host.md)).
- Which topics a broker holds for the flow, and when they are asked for again
  ([ADR-0035](0035-desktop-cloud-performer-owns-subscriptions.md),
  [ADR-0036](0036-browser-host-owns-subscription-state.md)).

## References

- `apps/web/src/cloud/fixtures/topic-filter.json` — the case table.
- `apps/web/src/cloud/topic-filter.ts`, `topic-filter.test.ts` — `topicMatches`, `isTopicName`.
- `apps/web/src/cloud/mqtt-client.ts` — `BrokerConnections`, `COPY_WINDOW_MS`.
- `apps/web/src-tauri/src/mqtt/broker.rs` — `route`, `COPY_WINDOW`, `MqttBroker::topic_matches`.
- `apps/web/src-tauri/tests/mqtt_routing.rs` — the desktop against the table.
- `CONTEXT.md` § Broker session, MQTT Brokers, Browser CloudPerformer.
