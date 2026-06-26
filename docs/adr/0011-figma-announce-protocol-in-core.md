# ADR-0011 — Figma announce protocol is core policy; uid extraction stays per-host

- **Status:** accepted (2026-06-26)
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
`apps/web/src/lib/firmata/flow-reactor.ts` `figmaLifecycle` and the desktop
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

- **Desktop** calls the core fn directly in `apply_flow`, then performs the
  publishes through its `MqttManager` (gated on a live broker).
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
for this case.

The uid *extraction* (`uid_brokers` desktop / `uidBrokers` browser) stays
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
