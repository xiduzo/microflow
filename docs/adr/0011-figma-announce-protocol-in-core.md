# ADR-0011 — Figma announce protocol is core policy; uid extraction stays per-host

- **Status:** accepted (2026-06-26); amended by [ADR-0028](0028-design-tool-bridge-protocol.md); amended (2026-11-19)
- **Date:** 2026-06-26
- **Deciders:** sander

> **Decision: hoist the Figma plugin-handshake protocol into core.** The
> connect/disconnect *protocol* — which topics, payloads, and retain flags a host
> publishes when the live Figma plugin-uid set changes — moves into
> `microflow_core::runtime::figma_announce_actions`, shared by both **Runtime
> Host**s. The uid *extraction* (parsing `microflow/{uid}` topics out of a host's
> own subscription set) stays per-host, exactly as the desired→live subscription
> set-diff does ([ADR-0010](0010-subscription-diff-stays-per-host.md)).

## Context

The Figma plugin handshake had the same shape in both hosts, duplicated: when a
plugin uid appears in the reconciled subscription set, publish
`microflow/{uid}/app/status = "connected"` (retained) and request its current
variable values (`microflow/{uid}/app/variables/request`); when a uid vanishes,
publish `"disconnected"` (retained). It lived in two languages —
`apps/web/src/runtime/flow-reactor.ts` `figmaLifecycle` and the desktop
`apps/web/src-tauri/src/runtime/commands.rs` `flow_update` tail — kept in lockstep
only by a "mirrors the desktop tail" comment. The two had already drifted in a
small but real way: the desktop announced the disconnect *before* the
unsubscribe diff, the browser did both *after* it.

This is the **Port/Emit** problem ([ADR-0007](0007-node-wire-interface-emit-contract.md))
and the winner-selection problem ([ADR-0009](0009-cloud-sans-io-capability.md),
[ADR-0010](0010-subscription-diff-stays-per-host.md)) again: a *policy* both hosts
must apply identically, mirrored by hope. An architecture review surfaced it as a
deepening opportunity.

The tension is with ADR-0010, which deliberately **kept** the subscription
set-diff per-host. Why hoist this and not that?

## Decision

Add a pure `figma_announce_actions(prev, next) -> Vec<FigmaPublish>` to
`crates/microflow-core/src/runtime/subscriptions.rs` — the Figma-side counterpart
of `reconcile_desired`. `prev`/`next` are `uid -> broker_id` maps; the function
returns the ordered publishes (`{ broker_id, topic, payload, retain }`). The
handshake protocol — topic shape, payloads, retain — lives there, once.

- **Desktop** calls the core fn directly in its `CloudPerformer`
  (`apps/web/src-tauri/src/runtime/cloud_performer.rs`), then performs the
  publishes through the `MqttBrokers` pool (only on a broker whose link is up).
- **Browser** calls it through a new wasm binding `figmaAnnounceActions(prevJson,
  nextJson)`, injected into the [Browser CloudPerformer](../../CONTEXT.md#browser-cloudperformer)
  as a `FigmaAnnounce` callback (so the performer stays host-free / unit-testable),
  then publishes over WSS via `mqtt.js`.
- The drift is gone: both hosts now announce *after* the (un)subscribe diff, in
  the order core returns (disconnects first).

**Why this differs from ADR-0010.** ADR-0010 kept the set-diff per-host because it
operates on each host's **live** subscription state — state that is irreducibly
host-local and never crosses into core, so hoisting it would mean marshalling live
state in only to diff it. The Figma announce runs on the **desired** uid set,
which core *already* computes (`reconcile_desired`); core has the input in hand.
And unlike a ~10-line set-diff with no cross-host contract, the announce encodes a
**protocol** (exact topics/payloads/retain a third party — the Figma plugin —
depends on), so divergence is a real interop bug, not a cosmetic one. Effort
matched to risk, the same calculus as ADR-0010 — it just lands on the other side
for this case. (The announce's input is each host's live set: see the
amendment below. The protocol argument is what carries the decision.)

The uid *extraction* (`bridge_uids` desktop / `uidBrokers` browser) stays
per-host: it is trivial parsing of a host's own subscription set, the direct
analog of the per-host set-diff ADR-0010 kept.

## Consequences

**Positive**

- One source for the handshake protocol; the hosts shrink to "extract uids → call
  core → publish." Parity by construction, not by comment.
- The browser cloud path gains a test seam (the injected `FigmaAnnounce` stub) and
  core gains direct unit tests of the protocol (`subscriptions.rs`).
- Deletion test: removing `figma_announce_actions` re-spreads the topic/payload
  knowledge back into both hosts.

**Negative**

- A second wasm binding to keep (`figmaAnnounceActions`), and the browser must
  serialize its uid maps to JSON to cross it. Marginal, and symmetric with the
  existing `reconcileSubscriptions` binding.
- One intentional behaviour alignment: the desktop disconnect publish moved from
  *before* the unsubscribe diff to *after* it, matching the browser. Equivalent
  for a retained status on an independent topic.

**Revisit if**

- The handshake grows host-specific branches (it has none today); then the shared
  fn would need a host discriminant and the hoist's value would shrink.

## References

- [ADR-0010](0010-subscription-diff-stays-per-host.md) — the symmetric decision for
  the subscription set-diff (kept per-host); this ADR is its deliberate mirror.
- [ADR-0009](0009-cloud-sans-io-capability.md) — cloud sans-IO; the CloudPerformer
  that performs these publishes.
- `CONTEXT.md` § Figma Announce Policy, § Browser CloudPerformer.

---

## Amendment (2026-11-19): a Bridge ID is on one broker, and a move is a departure and an arrival

`figma_announce_actions(prev, next)` reads its two `uid -> broker_id` maps as
"which broker each Bridge ID is on". Three rules complete the policy.

**A Bridge ID that moves broker leaves the old one and arrives on the new one.**
A uid whose broker differs between `prev` and `next` publishes `disconnected`
(retained) on the old broker, and `connected` (retained) plus the variables
request on the new one. A uid that vanished only leaves; a new one only
arrives.

**Every departure precedes every arrival.** Two broker ids can name one server,
where both status publishes of a move land on the same retained topic. The
later one has to be `connected`, for a Studio that is still there. Within each
group the order is the `BTreeMap`'s, by uid.

**The maps come from each host's live set, and a Bridge ID stays where it was
announced.** The input is not the desired set. Each host derives `uid ->
broker_id` from the subscriptions its brokers hold (`bridge_uids` on the
desktop, `uidBrokers` in the browser), after the (un)subscribes of the same
reconcile, so a Bridge ID is announced once a subscription is in place to catch
the plugins' answer. A Bridge ID whose topics are on several brokers is on one
of them: the broker it was announced on, for as long as that broker holds one
of its topics. Only when that broker holds none does it leave, and arrive on
another broker that holds it, if there is one. So `connected` and
`disconnected` for one Studio reach the same broker.

Deriving the maps stays per-host, as the uid extraction did. What a host may
not decide is the output: topics, payloads, retain flags and order are core's.

**A link that is down.** On the desktop nothing is announced on a broker whose
link is down. An arrival waits: the Bridge ID is on no broker until the link is
back. A departure does not hold back the arrival elsewhere: the `disconnected`
is owed to the old broker and sent when its link is back, unless the Bridge ID
returned there first or the broker's session ended
([ADR-0035](0035-desktop-cloud-performer-owns-subscriptions.md)). In the
browser a subscription is live only on an open link, so an arrival is always
announced on one; a connection that is replaced or closed says `disconnected`
first for every Bridge ID announced on it, while its link is up
([ADR-0036](0036-browser-host-owns-subscription-state.md)).

**One table holds the transitions.** `FIGMA_ANNOUNCE_CASES`
(`apps/web/src/lib/figma-announce-cases.ts`) lists each `prev`/`next` pair with
the publishes it must give, in order. The compiled policy is checked against it
through the wasm binding (`apps/web/src/runtime/figma-announce.wasm.test.ts`),
and so is the TypeScript stand-in the browser performer's tests run on
(`apps/web/src/cloud/cloud-performer.test.ts`). A stand-in that drifts from
core, in content or in order, fails a test.

A host that crashes, or a connection that closes while its link is down, says
no goodbye. Every Bridge ID announced on the broker is covered by a will
instead: the first by the connection's link, each other by a will link of its
own, which both hosts keep
([ADR-0049](0049-a-broker-session-leaves-its-goodbye-with-the-pool.md)).
