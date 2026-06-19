# ADR-0002 — Extract FlowRouter as the routing seam inside FlowExecutor

- **Status:** accepted
- **Date:** 2026-05-17
- **Deciders:** sander

> **⚠ Relocated (2026-06 · [ADR-0006](0006-rehost-runtime-on-core.md)):** this ADR
> predates the re-host of the Live Flow Runtime onto `microflow-core`. The FlowRouter
> seam still holds, but `apps/web/src-tauri/src/runtime/router.rs` now lives at
> `crates/microflow-core/src/runtime/router.rs`, and `FlowExecutor` / `executor.rs`
> are folded into `crates/microflow-core/src/runtime/mod.rs` (`FlowRuntime`). See ADR-0006.

## Context

`FlowExecutor` (`apps/web/src-tauri/src/runtime/executor.rs`) interleaved four
distinct concerns inside `process_event`:

1. **Stale-event gating** — discard `ComponentEvent`s carrying an explicit
   `sequence` older than `current_sequence` (leftover board-reader events
   from a previous flow version).
2. **Internal/Hardware Callback branching** — `source_handle.starts_with('_')`
   routes back to the source component (`dispatch_internal`,
   `on_pin_change`, `on_i2c_reply`). Source == target; no edge involvement.
   Already typed by [ADR-0001](0001-component-trait-flow-separation.md).
3. **Source value echo** — `component.set_value(event.value.clone())` so a
   subsequent snapshot delivery to an aggregating target reads the
   just-emitted value rather than stale state. Load-bearing invariant.
4. **Fanout** — `edge_map.get(source, handle)` produces `&[EdgeTarget]`,
   then per-target check `aggregates_inputs()`. If true, call private
   `collect_input_values(target_id, target_handle)` (linear scan over
   `self.edges`, reading each source's `Component::value()`) and pass as
   `ComponentValue::Array`; if false, pass `event.value` straight through.
   Then invoke `Component::dispatch(target_handle, args)`.

The smearing produced concrete friction:

- **Two indices over the same data, two access patterns.** `edge_map`
  (FxHashMap, hot-path) and `self.edges` (linear scan in
  `collect_input_values`) both indexed `Vec<FlowEdge>`, with no shared
  owner. Adding a third access pattern meant editing `FlowExecutor`
  again.
- **Aggregation is a routing concern but lived as a `process_event`
  branch.** `aggregates_inputs()` decides whether the delivery shape is
  one value or an Array snapshot. Today that is two real adapters of the
  delivery seam — not future, not hypothetical — but they were not named
  as such.
- **Tests couldn't exercise routing without instantiating real
  Components.** Verifying "two sources feed an aggregating target, the
  Array contains both values" required constructing `ThreadEmitter`,
  `Calculate`, `Sink`, wiring an event sender, and running through
  `process_event`. The thing being tested — the routing decision — was
  buried under three component lifecycles.
- **Future routing modes (conditional edges, value-routed switches,
  broker-typed edges) all needed to edit `FlowExecutor`.** No place to
  add them without growing `process_event` further.

`EdgeTarget` and `EdgeMap` were already `pub` in `executor.rs` but had no
callers outside that file — the pub-ness was speculative, not load-bearing.

The recent **WiringRegistry** refactor (`runtime/wiring_registry.rs`,
`CONTEXT.md` § Wiring) moved hardware-listener bookkeeping to its own
module, leaving `FlowExecutor` as the largest remaining
multi-responsibility module in the runtime.

## Decision

Extract a `FlowRouter` module (`runtime/router.rs`) that owns the edge
index and the per-target delivery decision. `FlowExecutor` reduces to an
event pump: gate stale, branch internal/hardware, echo `set_value`, ask
the router for the `DispatchCall` plan, invoke each call.

```rust
pub struct FlowRouter { /* edges, edge_map (both private) */ }

impl FlowRouter {
    pub fn set_edges(&mut self, edges: Vec<FlowEdge>);
    pub fn clear(&mut self);
    pub fn route(&self, event: &ComponentEvent, lookup: &dyn ComponentLookup)
        -> Vec<DispatchCall>;
}

pub trait ComponentLookup {
    fn aggregates(&self, id: &str) -> bool;
    fn value_of(&self, id: &str) -> Option<ComponentValue>;
}

pub struct DispatchCall {
    pub target_id: Arc<str>,
    pub target_handle: Arc<str>,
    pub args: ComponentValue,
}
```

Three sub-decisions:

- **D1 — Concrete struct, not a trait, for `FlowRouter`.** One Router
  implementation exists today. The two-adapter rule says no trait
  promotion until a second concrete router shape arrives (e.g.
  conditional-edge router that filters fanout by predicate). The seam is
  real because of the *delivery adapters* (Direct, Snapshot) inside the
  one router, not because two `Router` impls exist.

- **D2 — `ComponentLookup` is a 2-method trait, not `&HashMap<…>` or
  `&FlowExecutor`.** The router asks exactly two questions of the
  component map: "does this target aggregate?" and "what's this
  component's current value?" A scoped trait makes that explicit and
  lets router tests mock with `HashMap<String, (bool, ComponentValue)>`
  instead of real Components. The executor implements it via a thin
  `ComponentMapLookup<'a>` adapter living only for the scope of one
  `route` call.

- **D3 — Delivery strategies (Direct, Snapshot) live as private
  functions inside `FlowRouter`, not as a public `Delivery` trait.** The
  per-target switch lives in one place and the two strategies share
  setup. Splitting them into a separate seam buys nothing today and
  doubles the layers a reader walks.

Internal Events, Hardware Callbacks, and stale-sequence gating stay in
`FlowExecutor::process_event`. They sit upstream of routing — the router
should never see them.

## Consequences

**Positive**

- **Routing is testable in isolation.** Seven new unit tests in
  `router.rs::tests` cover direct delivery, fanout, snapshot aggregation,
  handle-scoped snapshot filtering, clear, edge replacement, and empty
  plans — all with a `HashMap<String, (bool, ComponentValue)>` mock, no
  real Components, no event channels.
- **`FlowExecutor::process_event` is now readable end-to-end as a
  pump.** Stale gate, internal branch, value echo, plan, dispatch loop.
  Each step is named and the smearing is gone.
- **Adding routing modes is local.** Conditional edges,
  value-routed switches, broker-typed edges all land in `router.rs`
  without touching `FlowExecutor`.
- **The naming reflects the architecture.** "Wiring" stays the
  hardware-listener bookkeeping it always was (`WiringRegistry`,
  `ListenerWiring`); "Router" is the flow-edge fanout. Two distinct
  concepts no longer share the word.
- **Deletion test passes.** Removing `router.rs` re-inlines `EdgeMap`,
  `set_edges`, `rebuild_edge_map`, `collect_input_values`, and the
  per-target aggregation branch all into `FlowExecutor` — roughly 120
  LOC of behaviour reappears in one place. The seam concentrates real
  complexity, not just a renamed type.

**Negative**

- **One extra hop on the hot path.** `process_event` now calls
  `router.route(...)` which returns a `Vec<DispatchCall>` instead of
  iterating `&[EdgeTarget]` directly. The previous code already
  `t.to_vec()`'d for the same borrow reason, so the allocation count is
  unchanged; the extra `DispatchCall` per target is a few words on the
  stack vector. No measurable regression in `benches/event_routing.rs`.
- **`ComponentLookup` adds a tiny layer of indirection.** The executor
  builds a `ComponentMapLookup` wrapper struct per `process_event`
  call. Zero-cost in release builds (the wrapper carries one borrow);
  the explicitness is the point.
- **One more module to learn.** `router.rs` is ~300 LOC including
  tests; the executor lost ~80 LOC. Net: split, not growth.

**Neutral**

- The `FlowRouter` trait promotion can happen later in a single commit
  when a second Router shape (e.g. `ConditionalRouter`) appears. Today
  it would be speculative.

## Glossary

New term recorded in `CONTEXT.md`:

- **FlowRouter** — given an outgoing `ComponentEvent`, produces the list
  of `DispatchCall`s to invoke. Owns the (source, source_handle) →
  target index and the per-target delivery decision (Direct or
  Snapshot).

## References

- `apps/web/src-tauri/src/runtime/router.rs` — `FlowRouter`,
  `ComponentLookup`, `DispatchCall`, `EdgeTarget`, unit tests.
- `apps/web/src-tauri/src/runtime/executor.rs` — `FlowExecutor` as the
  event pump after the extraction; `ComponentMapLookup` adapter.
- `CONTEXT.md` § FlowRouter, § Wiring, § Port.
- [ADR-0001](0001-component-trait-flow-separation.md) — the prior split
  of Port / Internal Event / Hardware Callback flows on the trait side.
  This ADR extracts the routing seam on the executor side; the two are
  orthogonal.
