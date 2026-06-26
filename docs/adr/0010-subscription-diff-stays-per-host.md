# ADR-0010 — Subscription diff stays per-host; only winner-selection is core policy

- **Status:** accepted (2026-06-26) — records a deliberate non-change
- **Date:** 2026-06-26
- **Deciders:** sander

> **Decision: keep the split.** Winner-selection (`reconcile_desired`) is core
> policy, shared by both **Runtime Host**s. The desired→live subscription diff
> and the broker I/O stay per-host. An architecture review proposed hoisting the
> diff into core too; **rejected** — it operates on host-local state and the gain
> is marginal. The rationale already lives at `subscriptions.rs:13`; this ADR
> records it so future reviews don't re-suggest the hoist.

## Context

Subscription reconciliation has two parts:

1. **Winner-selection** — collapse many subscribe-nodes to one *desired*
   subscription per `(broker, topic)`, picking a deterministic winner on
   collisions (routing kinds beat display-echo; ties break on the lower node id).
2. **Diff-against-live** — compare the desired set to what the broker is
   *currently* subscribed to, and issue the subscribe / unsubscribe / announce
   calls.

Part 1 is drift-dangerous: if the desktop and browser picked different winners
they would disagree on which node owns a topic. It previously lived in two
languages (desktop `DesiredSub::beats`, browser `beats`/`reconcileDesired`) kept
in lockstep only by a comment, and is now single-sourced in core as
`microflow_core::runtime::reconcile_desired` ([ADR-0009](0009-cloud-sans-io-capability.md);
commit 67b05b9).

An architecture review then proposed extending the same move to part 2 — a core
`reconcile_plan(desired, live) → Plan { subscribe, unsubscribe, announce }` that
both hosts apply — so each host shrinks to a thin applier, mirroring how
[ADR-0008](0008-effects-apply-policy.md) hoisted the `Effects` apply-order.

## Decision

**No. Part 2 stays per-host.** The split is:

- **Winner-selection → core** (`reconcile_desired`). Shared, because divergence
  between hosts is a correctness bug.
- **Diff-against-live + broker I/O → per-host.** The diff operates on each host's
  *live* subscription set, which lives inside its broker client (`rumqttc` on the
  desktop, `mqtt.js` in the browser) — host-local state core does not, and should
  not, hold. Centralizing the diff would marshal that live set across the wasm
  boundary on every `flow_update` to run a ~10-line set difference. The
  determinism that made part 1 worth sharing has no analogue in a set diff.

This is already the documented rationale at
`crates/microflow-core/src/runtime/subscriptions.rs:13`; this ADR promotes that
comment to a recorded decision.

## Consequences

**Positive**

- Core stays sans-IO and holds no per-host live subscription state.
- Effort matched to risk: the dangerous policy (winner-selection) is shared; the
  trivial one (set diff) is not.

**Negative**

- A ~10-line set-diff exists in both languages (`commands.rs` desktop,
  `mqtt-subscriptions.ts` browser). Accepted: low risk, no determinism concern,
  no cross-host contract to break if they diverge superficially.

**Revisit if**

- A host's live subscription set must cross into core for some *other* reason —
  then the marshalling cost is already paid and folding the diff in becomes cheap.

## References

- `crates/microflow-core/src/runtime/subscriptions.rs:13` — the in-code rationale this ADR formalizes.
- `apps/web/src-tauri/src/runtime/commands.rs` — desktop diff-against-live (`rumqttc`).
- `apps/web/src/lib/firmata/cloud/mqtt-subscriptions.ts` — browser diff-against-live (`mqtt.js`).
- [ADR-0008](0008-effects-apply-policy.md) — the policy-in-core / primitives-per-host pattern that deliberately does **not** extend to the subscription diff.
- [ADR-0009](0009-cloud-sans-io-capability.md) — single-sourced `reconcile_desired`.
