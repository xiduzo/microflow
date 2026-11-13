# 0013 — Sketch generation wires by handle, typed, in dataflow order

Status: accepted (2026-07)

## Context

The live runtime routes an event by `(source, source_handle)` and dispatches it
to `(target, target_handle)` — the Port/Emit contract of
[ADR-0007](0007-node-wire-interface-emit-contract.md). Sketch generation
(`crates/microflow-core/src/codegen/`) originally used a *single-driver value
model*: every target Node received at most one anonymous C++ "driver"
expression, chosen as the wired source with the smallest id, with both edge
handles ignored.

That model could not represent the wire contract:

- Multi-port Nodes were unreachable: an edge into a Led's `toggle`, a Relay's
  `true`/`false` (Relay has no `value` port at all), a Counter's
  `decrement`/`reset`/`set`, or an Rgb channel generated either wrong code
  (level write regardless of port) or nothing.
- Multi-input Nodes collapsed: Calculate's folds and Gate's truthy-count
  reduced to single-input passthroughs (recorded as a limitation in
  `codegen/parity.rs`).
- Expressions were untyped strings: a `String`-valued source (Llm response,
  Mqtt payload) cast with `(double)(…)` produced C++ that does not compile,
  breaking the "generated sketches always compile" invariant.
- `loop()` bodies ran in an id-derived order, so a producer whose id sorted
  after its consumer introduced a one-tick delay per hop — behavior depended
  on node ids the author never sees.

## Decision

Codegen resolves every edge through a typed, handle-aware wiring model
(`codegen/wire.rs`), the static twin of the runtime router:

- **`CppExpr { code, ty: Bool | Double | Str }`** — every source expression is
  typed; consumers coerce through `as_bool` / `as_double(_or)` / `as_u8_or` /
  `as_string`, transcribing `ComponentValue`'s conversions (strings carry no
  number and fall back to the dispatch-site default; `as_u8` clamps 0..=255).
- **`SourceExpr`** — what a Node exposes on one emit handle:
  `output_expression(node, handle)` in `codegen/mod.rs` mirrors each
  component's `emits()` list. Event-shaped handles (Delay/Interval `event`,
  Trigger `bang`) carry an explicit `fired` flag variable that is true only on
  the emitting loop iteration; level handles carry a `Detector` — `Change` for
  `value`-style handles (the runtime emits on every update, both button edges)
  and `RisingEdge` for `true`/`false` state handles (emitted only on entry).
- **`NodeInputs`** — per target, every wired source grouped by the edge's real
  `target_handle`, in deterministic order. Emitters bind their actual ports
  (`emit(node, &NodeInputs)`): pulse ports consume firings via
  `bind_pulses` (the shared edge/change-detector primitive that Counter, Delay
  and the I2C trigger previously hand-rolled), level ports sample coerced
  values, and aggregating Nodes (Calculate, Gate — the only
  `aggregates_inputs` components) fold over *all* sources like the runtime
  snapshot delivery.
- **Dataflow loop order** — `loop()` fragments are concatenated in topological
  order (Kahn, smallest-id tie-break; nodes on a cycle append in id order), so
  a value produced this tick is consumed this tick. Declarations/`setup()`
  stay in id order.
- **Nothing drops silently.** An edge codegen cannot honor — missing source
  node, source handle with no on-device value, an unmodelled port (Figma's
  typed-variable mutations, Pixel `color`/`set`, I2C `write`), or extra
  sources on a single-source port — emits a `// note:` comment on the target
  Node in the sketch. Two node ids that sanitize to the same C++ identifier
  token are refused by validation (the emitted globals would collide), keeping
  the never-emit-unrunnable-code gate honest. User-authored strings are
  escaped into C++ literals (`emit::cpp_string_literal`).

The interpret↔emit parity guards (`codegen/parity.rs`) now pin every
Calculate/Gate variant to its emitted fold token and every Counter port to its
emitted action — the "single-driver limitation" classifications are gone.

## Consequences

- Generated behavior matches the runtime router per handle: `button.true →
  led.toggle` toggles on press; `compare.true → counter.reset` resets on the
  crossing; `map.to + constant.value → calculate.value` sums both inputs.
- A String source wired into a numeric port compiles (and reproduces the
  runtime's fallback) instead of producing invalid C++.
- Mqtt publish and Llm request emission is pulse-driven — one message/request
  per source firing — instead of publishing every loop tick.
- Sketches for flows with unmodelled wiring still generate, with the gap
  named in the sketch text rather than silently absent.
- Emitters take `&NodeInputs` instead of `Option<&str>`; new node emitters
  declare their ports by binding them, and `codegen/parity.rs` +
  `catalog_parity.rs` fail CI when the two sides drift.

## Amendment (2026-11-13): one pin table for the sketch and the live runtime

Which pins a Node uses, and what it needs from each, is written once:
`codegen::validate::pin_demands(node, edges) -> Vec<PinDemand>`, a
`PinDemand { field, pin, uses }` with `uses` one of `Digital`, `Pwm`, `Servo`,
`AnalogIn`. Pins are resolved by the Node's own emitter helpers, and the demand
can depend on the wiring (a Led's `value` port demands PWM only when an edge
feeds it), which is why `edges` is an argument.

Two readers judge the same demands:

- **Sketch validation** (`codegen/validate.rs`) reads the pins each Node emits
  onto from it, and warns when the selected board target lacks a pin, a PWM pin
  or an analog input. Board-fit problems are warnings and never block emission.
- **The live pin check** (`runtime/pin_check.rs`) judges them against the
  connected board's `PinProfile` and puts the verdict on the Node's badge
  through the runtime's node-health ledger: an error when the Node cannot work
  (a servo on a pin without servo support, an analog read on a digital-only pin,
  a pin the board does not have), a warning when it works degraded (brightness
  on a pin without PWM is rounded to on/off at 128, as Arduino's `analogWrite`
  does).

A second table in the runtime was the alternative. It would have been the same
list of Node types and pin fields, kept in step by hand, and the first place the
live behaviour and the exported sketch disagreed would have been a pin. The
runtime depends on the ungated `codegen` module for this, and the dependency runs
one way: codegen knows nothing of the runtime.
