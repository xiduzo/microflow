# ADR-0008 — `Effects` apply-policy: canonical order behind a typed `EffectsSink`

- **Status:** implemented (2026-06-21)
- **Date:** 2026-06-21
- **Deciders:** sander

> **Implemented.** Core: `EffectsSink` trait + `Effects::apply` (canonical order
> `outbound_bytes → cancellations → wakeups → component_events`) in
> `runtime/context.rs`, exported from `runtime/mod.rs`. Desktop: `Actor`'s `apply`
> now delegates to `Effects::apply(self)` with `impl EffectsSink for Actor`
> supplying the four primitives (`host.rs`). Browser: `applyEffects` + `EffectsSink`
> extracted to `apps/web/src/lib/firmata/effects-sink.ts`; `FlowReactor` implements
> it (its prior inline loop was already in canonical order). Conformance: the
> cancel + re-arm + emit + bytes scenario runs as `context::apply_tests` (Rust) and
> `__tests__/effects-sink.test.ts` (`bun:test`), both asserting order + no
> double-fire. Verified: core 365 pass, desktop `cargo check`/clippy clean, browser
> 2 pass, `tsc --noEmit` clean.

## Context

ADR-0006 made the runtime sans-IO: each turn folds into one
`Effects { outbound_bytes, component_events, wakeups, cancellations }`
(`crates/microflow-core/src/runtime/context.rs:38`, `#[serde(rename_all =
"camelCase")]`) that a **Runtime Host** applies. That seam is what makes the
engine testable — feed input, assert on the returned `Effects`.

But `Effects` is a **passive DTO**. *How* a host applies it — the order and
semantics of the four fields — is written down nowhere, and the two hosts have
**already diverged**:

- Desktop (`apps/web/src-tauri/src/runtime/host.rs:451` `apply`):
  `outbound_bytes → component_events → wakeups → cancellations`.
- Browser (`apps/web/src/lib/firmata/flow-reactor.ts:81` `apply`):
  `outbound_bytes → cancellations → wakeups → component_events`.

This is benign **today** — within one turn `wakeups` carry freshly-allocated
`WakeupId`s and `cancellations` carry previously-issued ones, so they cannot
collide on the same id regardless of order. But it is an unguarded latent
hazard: the testability seam stops at the runtime boundary, the host's
*application* of effects is unspecified and unconformance-tested, and a future
field or ordering rule (e.g. "a cancellation and a re-arm of the same logical
timer in one turn must cancel-then-arm") would have to be re-implemented in two
languages with nothing asserting they agree. ADR-0009 is about to add a fifth
`Effects` field (`cloud_requests`); doing this first means that field lands
behind a policy rather than as a third ad-hoc loop.

## Decision

Make the apply **policy** a deep module in core, distinct from the platform
**primitives** (which are genuinely divergent — Tokio `abort_handle` vs
`clearTimeout` — and stay per-host).

- **D1 — One canonical order, defined once:**
  `outbound_bytes → cancellations → wakeups → cloud_requests (ADR-0009) →
  component_events`. Bytes first (wire latency); cancel-before-arm (the safe
  default, browser's current order); UI events last (they leave the runtime and
  do not feed back this turn).

- **D2 — A typed sink the order calls into.** In core,
  `Effects::apply(&self, sink: &mut impl EffectsSink)` iterates in the canonical
  order, calling one hook per field: `write_bytes(&[u8])`,
  `cancel_wakeup(WakeupId)`, `arm_wakeup(&Wakeup)`, `dispatch_event(&ComponentEvent)`
  (and `perform_cloud(&CloudRequest)` once ADR-0009 lands). The desktop host
  implements `EffectsSink`; its `apply` shrinks to the four platform primitives
  and no longer owns the order. **A new `Effects` field forces a new trait hook
  → compile error**, not a silently-unhandled field.

- **D3 — Browser mirrors the order, conformance-tested.** The browser host is
  TypeScript and cannot call the Rust `apply`; the reactor implements the same
  four-hook shape in the same canonical order. A shared conformance scenario
  (cancel + re-arm + emit in one turn ⇒ no double-fire, all fields observed,
  order preserved) runs in both `cargo test` (core, against a recording sink) and
  `vitest` (browser). The win is a **named, tested ordering contract**, not DRY
  code — the Rust↔TS boundary caps reuse, and this ADR states that honestly.

### Rollout

1. Core: `EffectsSink` trait + `Effects::apply`; desktop `apply` reimplemented
   over it; order unit-tested in core against a recording sink.
2. Browser: reactor reordered to canonical + the four-hook shape; conformance
   test added on both sides.

## Consequences

**Positive**

- The ordering contract lives in one place (core), not smeared across two hosts
  in two languages.
- New-field safety: adding `cloud_requests` (ADR-0009) is a compile error on the
  desktop sink until handled, instead of a dropped field.
- Deletion test: removing `EffectsSink`/`apply` re-inlines the iteration order
  into both hosts, where it already drifted once.

**Negative**

- A core method the desktop calls but the browser only mirrors — partial reuse.
  Accepted: the alternative (no core method, just a documented order + tests)
  gives the contract but not the compile-time new-field guard. The typed sink is
  chosen for that guard; the browser is a mirror either way.
- One more indirection on the desktop apply path (a sink struct + trait
  dispatch). Zero-cost in release; the explicitness is the point.

**Neutral**

- The browser reactor's reorder is observably equivalent today (the order
  difference is benign per Context); this ADR makes the equivalence intentional
  and tested rather than accidental.

## Glossary

New term recorded in `CONTEXT.md`:

- **EffectsSink** — the typed per-field hook surface (`write_bytes`,
  `cancel_wakeup`, `arm_wakeup`, `dispatch_event`, `perform_cloud`) that
  `Effects::apply` drives in canonical order. Implemented by each **Runtime
  Host**; a new `Effects` field adds a hook.

## References

- `crates/microflow-core/src/runtime/context.rs:38` — `Effects`; gains `apply` + `EffectsSink`.
- `apps/web/src-tauri/src/runtime/host.rs:451` — desktop `apply` (reimplemented over the sink).
- `apps/web/src/lib/firmata/flow-reactor.ts:81` — browser `apply` (reordered + four-hook).
- [ADR-0006](0006-rehost-runtime-on-core.md) — the `Effects` seam this deepens.
- [ADR-0009](0009-cloud-sans-io-capability.md) — adds `cloud_requests`, the field this policy will absorb.
