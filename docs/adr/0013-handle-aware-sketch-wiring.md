# 0013 — Sketch generation wires by handle, typed, in dataflow order

Status: accepted (2026-07); amended (2026-11-13, 2026-11-19, 2026-11-19); refined by [ADR-0050](0050-on-device-emission-timing-follows-the-live-node.md)

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

- **`CppExpr { code, ty: Bool | Double | Str | Opaque }`** — every source
  expression is typed; consumers coerce through `as_bool` / `as_double(_or)` /
  `as_u8_or` / `as_string`, transcribing `ComponentValue`'s conversions
  (strings carry no number and fall back to the dispatch-site default; `as_u8`
  clamps 0..=255). `Opaque` is a colour or a list, held as a version (see the
  amendment below).
- **`SourceExpr`** — what a Node exposes on one emit handle:
  `output_expression(node, handle)` in `codegen/mod.rs` mirrors each
  component's `emits()` list. A handle is an **event** or a **level**, by how
  the live Node emits on it ([ADR-0050](0050-on-device-emission-timing-follows-the-live-node.md)):
  an event (Delay/Interval `event`, Trigger `bang`, Compare/Gate and
  Button/Switch `true`/`false`) carries an explicit `fired` flag that is true
  on exactly the loop iterations the live Node emits; a level (a `value` the
  live Node emits through `set_value`) has none, and a pulse-consuming port
  detects its changes.
- **`NodeInputs`** — per target, every wired source grouped by the edge's real
  `target_handle`, in deterministic order. Emitters bind their actual ports
  (`emit(node, &NodeInputs)`): pulse ports consume firings via
  `bind_pulses` (the shared edge/change-detector primitive that Counter, Delay
  and the I2C trigger previously hand-rolled), level ports sample coerced
  values (an output that drives hardware from a level port acts when the
  value changes, see the amendment below), and aggregating Nodes (Calculate,
  Gate — the only
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
  led.toggle` toggles on press; `compare.true → counter.reset` resets on each
  check that passes; `map.to + constant.value → calculate.value` sums both inputs.
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

An analog-reading Node's pin label resolves the way the live runtime reads it
(a `firmata::PinLabel` held by the Node's config and resolved against the
target by `codegen::emit::resolve_analog`): `A<n>` is the board's `n`-th analog input, and a number is
that pin — `15` is the Uno's `A1`, never `A15`. A number that is not an analog
input is a demand on that pin, and both readers flag it as such.

Two readers judge the same demands:

- **Sketch validation** (`codegen/validate.rs`) reads the pins each Node emits
  onto from it, and warns when the selected board target lacks a pin, a PWM pin
  or an analog input. Board-fit problems are warnings and never block emission.
- **The live pin check** (`runtime/pin_check.rs`) judges them against the
  connected board's `PinProfile` and puts the verdict on the Node's badge
  through the runtime's node-health ledger: an error when the Node cannot work
  (a servo on a pin that is not even digital, an analog read on a digital-only
  pin, a pin the board does not have), a warning when it works degraded (brightness
  on a pin without PWM is rounded to on/off at 128, as Arduino's `analogWrite`
  does). A servo is allowed on any digital pin, `A0` included: Microflow's
  bundled StandardFirmata attaches a servo to any pin its `IS_PIN_DIGITAL`
  accepts, so the limit is how many servos are attached at once, not which pin.

A second table in the runtime was the alternative. It would have been the same
list of Node types and pin fields, kept in step by hand, and the first place the
live behaviour and the exported sketch disagreed would have been a pin. The
runtime depends on the ungated `codegen` module for this, and the dependency runs
one way: codegen knows nothing of the runtime.

## Amendment (2026-11-19): an emitter can refuse a Node

An emitter that has settings reads them through `config::resolve` and returns
`Result<NodeEmission, UnreadableConfig>`: `emit(node, &NodeInputs)` either
yields the Node's C++ or says which setting could not be read. `emit_node`
passes the refusal up, and generation turns each one into an error-severity
`ValidationProblem` (`validate::unreadable_config`) next to the flow's other
problems. One such problem means no sketch, the same gate that refuses
colliding identifier tokens. A Node whose settings cannot be read has no
`pin_demands`, so neither sketch validation nor the live pin check judges a pin
it does not have. Unmodelled *wiring* still generates with a `// note:`; only
unreadable *settings* refuse. The decision and its reasons are [ADR-0033](0033-one-node-config-resolution.md).

## Amendment (2026-11-19): every declared Emit has a value on the board, or a reasoned refusal

A flow that works live and does nothing once uploaded is the fault this
amendment closes: an output Node (Led, Relay, Piezo, Servo, Rgb, Matrix,
Pixel, Monitor) carried no value in the sketch, so an edge from it produced
only a `// note:`.

- **Output Nodes carry their live value.** `output_expression` gives each one
  the value its runtime twin emits: a Led's or Vibration's level (one byte,
  read as `byte / 255`), a Relay's open state, whether a Piezo is sounding, a
  Servo's position or continuous speed (it starts at the centre of its range,
  and a continuous Servo reads 0 after `stop`), a Trigger's triggered state,
  and a Pixel's `event` as a flag on the tick a port acted.
- **`CppType::Opaque`** — a colour or a list (an Rgb, a Matrix, a Pixel strip)
  has no number and no text on the board. Its expression is a `uint8_t`
  version that its producer moves on, never to 0, each time the value changes,
  exactly when the runtime emits it. A consumer can count and detect changes
  on it; `as_number` is `None`, and a payload renders it as nothing. Version 0
  is the plain number 0 an output holds before it shows anything.
- **`SourceExpr::starting_at(initial)`** — a source whose runtime twin holds a
  value other than its type's zero before it first emits (a Servo starts
  centred) says so, and a change detector starts from that value, so a source
  that has not moved does not fire on the first tick.
- **A Monitor hands on what it shows, in its source's type.** Its output
  depends on the flow, so `Outputs` (`codegen/mod.rs`) resolves it through any
  chain of Monitors and remembers it, so every consumer and the Monitor's own
  declaration agree on one type. A chain that comes back round to its Monitor
  shows nothing along that path.
- **A level port that drives hardware acts on a change.** A Led's `value` and a
  Servo's `value` / `rotate` write when their source changes, not on every
  `loop()` pass. A standard Servo's `stop` is refused with a note, as it is
  live. Calculate leaves out colour and list inputs.
- **Every declared Emit has a value or a reasoned refusal.** An Emit with no
  on-device value is listed in `codegen::no_value_reason` with the reason the
  sketch's note gives (Music, the Pn532, an Llm's `thinking` / `done` /
  `error`). The guard
  `every_declared_emit_has_an_on_device_value_or_a_reasoned_refusal`
  (`codegen/parity.rs`), driven from the live registry, fails on a declared
  Emit with neither, and on a listed Emit that has a value under every setting,
  so the list cannot go stale.

Mqtt's `direction` is read the same way on both sides: exactly `publish`
publishes, any other value subscribes (`nodes/mqtt/config.rs`).

