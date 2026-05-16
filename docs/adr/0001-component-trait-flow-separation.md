# ADR-0001 — Component trait separates Port, Internal Event, and Hardware Callback flows

- **Status:** accepted
- **Date:** 2026-05-16
- **Deciders:** sander

## Context

The `Component` trait (`apps/web/src-tauri/src/runtime/component.rs`) has a single
dispatch method:

```rust
fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), RuntimeError>;
```

Empirically, three semantically distinct flows enter this method through the same
stringly-typed door:

1. **Port** — edge inputs delivered from a flow edge. The executor reads
   `edge.target_handle` (a `&str`) and passes it as `method`. Examples:
   `Led` accepts `"true"/"false"/"toggle"/"value"`; `Stepper` accepts
   `"value"/"to"/"stop"/"zero"`.

2. **Internal Event** — self-routed methods. When a Component emits a
   `ComponentEvent` whose `source_handle` starts with `_`, the executor
   (`runtime/executor.rs::process_event`) strips the leading underscore and
   calls `call_method` back on the source Component. Used for internally
   scheduled state transitions (e.g. `Led` blink cycle).

3. **Hardware Callback** — board-reader-driven events from the **Board IO
   Loop** (`PinChangeCallback`, `I2cReplyCallback`, stepper feedback). The
   runtime synthesizes a `ComponentEvent` with a reserved magic-string method
   name (`"pin_change"`, `"i2c_reply"`, `"stepper_reply"`) and delivers it
   through `call_method`. These names are not Ports — no flow edge may use
   them as `target_handle`.

All three share one open namespace, with no compile-time enforcement of who
may produce which names. The pains this creates:

- **Frontend/Rust drift:** a TS handle ID and a Rust match arm are linked only
  by string convention. Typos fail silently at runtime (logged as warn, event
  dropped).
- **"What does this Component accept?":** the match arm in each impl is the
  only spec. Edge ports, internal events, and hardware reserved names are
  interleaved in the same arm.
- **Hardware callbacks ride the wrong door:** delivering pin-change to a
  Button via `call_method("pin_change", …)` makes a runtime concern look like
  a flow-edge concern. Tests can't fire a real pin-change without forging the
  whole `ComponentEvent` shape.
- **No typed link to the catalog:** `node-components.json` knows the
  Component's `name`, `category`, and `requiresHardware`, but says nothing
  about which Ports it accepts. The frontend codegen can't emit a typed
  handle-ID union.

## Decision

Split the dispatch flows into separate trait methods, named after the
distinctions already present in the code.

```rust
pub trait Component: Send + Sync {
    /// Edge-input dispatch. `port` is the edge's `target_handle`.
    /// Implementors match against their declared `PORTS` set.
    fn dispatch(&mut self, port: &str, value: ComponentValue) -> Result<(), RuntimeError>;

    /// Self-routed internal event. Implementors define their own
    /// internal-method namespace; never observable on edges.
    fn dispatch_internal(&mut self, method: &str, value: ComponentValue) -> Result<(), RuntimeError> {
        Ok(())
    }

    /// Declared set of Port names this Component accepts. Validated against
    /// `node-components.json impls[].ports[]` at build time.
    const PORTS: &'static [&'static str] where Self: Sized = &[];
}

pub trait HardwareComponent: Component {
    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), RuntimeError>;

    fn on_pin_change(&mut self, _pin: u8, _value: PinValue) -> Result<(), RuntimeError> { Ok(()) }
    fn on_i2c_reply(&mut self, _event: I2cReplyEvent) -> Result<(), RuntimeError> { Ok(()) }
    fn on_stepper_reply(&mut self, _event: StepperReplyEvent) -> Result<(), RuntimeError> { Ok(()) }
}
```

Three sub-decisions:

- **D1 — Per-flavor Hardware Callback methods, not a unified `HardwareEvent`
  enum.** Locality wins: Button mentions `on_pin_change` only, no awareness
  of I²C or stepper variants. Cost: three default no-op methods on
  `HardwareComponent` (paid only by the 14 hardware components).

- **D2 — Ports declared in `node-components.json`, mirrored as `const PORTS`
  on each Component impl, validated at build time.** Catalog stays the single
  manifest (consistent with existing `Generation` pattern in `CONTEXT.md`).
  Frontend codegen emits typed handle-ID unions from `ports[]`. Build-time
  validation enforces Rust ↔ JSON agreement.

- **D3 — Internal Events get their own trait method (`dispatch_internal`).**
  Edges can never reach internal methods, since the executor's `_`-prefix
  routing path is the only caller. Implementors define a private internal
  enum next to their `PORTS` if desired.

Roll out incrementally:

1. **Phase 1** — add Hardware Callback methods; rewire pin-change / i2c-reply
   / stepper-reply paths to call typed methods directly. Reserved magic
   strings removed from `call_method`.
2. **Phase 2** — add `dispatch_internal`; rewire the `_`-prefix path in the
   executor.
3. **Phase 3** — rename `call_method` to `dispatch`; add `const PORTS`; grow
   `node-components.json impls[].ports`; build.rs validates; frontend codegen
   consumes ports.

Each phase compiles and ships independently.

## Consequences

**Positive**

- Renaming a Port → compile errors in `dispatch` match arm and in the catalog
  build-time check; no more silent failures.
- "What does this Component accept?" answered by `<Impl>::PORTS` and by the
  catalog `ports[]` field — one declaration, two sources kept in sync by
  codegen.
- Hardware callbacks traverse a typed seam: tests fire
  `Button::on_pin_change(2, PinValue::Digital(true))` directly. No
  synthesizing of `ComponentEvent` with reserved source handles.
- `dispatch` namespace shrinks to Ports only; reading any impl's `dispatch`
  match arm gives the complete edge interface.
- WiringRegistry's pin-change callback dispatches via typed method on the
  Component, not via the event channel — fewer queue hops for hardware
  events.
- New integration tests become possible without `MockComponent` exclusivity:
  exercise `Led::dispatch("value", …)` and `Button::on_pin_change(…)` against
  real impls.

**Negative**

- `HardwareComponent` gains three default no-op methods. This is the
  dead-weight pattern audit §3.5 removed from `Component::initialize`,
  reintroduced in narrower scope (hardware only, 14 impls vs all 27).
  Accepted as a trade for per-flavor locality.
- Codegen between JSON and Rust grows a validation step. `build.rs` must
  introspect each impl's `PORTS`. Practical mechanism: each impl exposes
  `PORTS` as a `const`, and a `tests/catalog_consistency.rs` integration
  test (or a `build.rs` codepath reading via `syn`) asserts equality.
- Migration touches ~30 component files. Mitigated by phased rollout.
- The catalog grows a new field. Existing consumers (frontend codegen) must
  learn it. Mitigated by making `ports: []` optional during Phase 1 + 2.

**Neutral**

- `ComponentBuilder` is unaffected. Its config-deserialization role and
  hardware-bound enforcement remain.

## Glossary

New terms recorded in `CONTEXT.md`:

- **Port** — a named edge-input slot on a Component.
- **Internal Event** — a self-routed method, never observable as a Port.
- **Hardware Callback** — a board-reader-driven event delivered to a
  HardwareComponent.

## References

- `apps/web/src-tauri/src/runtime/component.rs` — current Component trait.
- `apps/web/src-tauri/src/runtime/executor.rs` — `call_method` call sites and
  `_`-prefix routing.
- `apps/web/src-tauri/src/runtime/wiring_registry.rs` — pin/i2c listener
  bookkeeping.
- `docs/RUNTIME_AUDIT_APRIL_2026.md` §3.5 / §3.3 — earlier trait-split work.
- `CONTEXT.md` § Component (Rust trait), Port, Internal Event, Hardware
  Callback.
