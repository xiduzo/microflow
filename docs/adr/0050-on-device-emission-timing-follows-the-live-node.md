# ADR-0050 — On-device emission timing follows the live node

- **Status:** accepted (2026-11-19); amended (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander
- **Refines:** [ADR-0013](0013-handle-aware-sketch-wiring.md)

> **Decision:** a node in the exported sketch emits on the same occasions, and
> carries the same value, as the live node. Each emit handle is an **event**
> (an explicit fired flag, true on exactly the loop iterations the live node
> emits) or a **level** (a value the live node emits through `set_value`,
> whose changes a consumer detects). A boolean node's handles all carry its
> state. Every transform runs by one rule, `NodeEmission::transform`: once per
> loop iteration a source fires, and never before its first input. Where a
> live node bounds, samples, settles or compares, the sketch does it with the
> same constant. Two registry-driven guards hold the rule for every node.

## Context

[ADR-0013](0013-handle-aware-sketch-wiring.md) wires the sketch by handle and
types every expression, and its amendment gives every declared Emit a value on
the board. *When* a handle fires was still each emitter's own guess, and the
guesses differed from the live node in ways a user sees once a flow is
uploaded:

- **Change detectors where the live node repeats.** A Compare emits `true` on
  every check that passes; the sketch fired it only when the result changed,
  so a Counter behind it counted once where live it counted every value. The
  same held for a RangeMap's `to`, a Monitor's output, an Mqtt or design
  variable message repeated with the same payload, and a Midi note.
- **`true` and `false` as rising edges of a negated state.** A Compare's,
  Gate's or Button's `false` carried `true` (the negation it fired on) where
  the live node carries `false`, and a Button's `false` fired at boot.
- **Transforms that ran on every loop pass.** Calculate, Function, Smooth,
  Compare and Gate recomputed on every iteration, and a Compare checked before
  its first input arrived. Smooth then averaged one reading many times over.
- **Constants the two halves held apart.** Equality in Compare, the contact
  debounce of Button and Switch, a Sensor's threshold, and an Oscillator's
  sample period were each live-only or had their own value in the sketch.

## Decision

**D1 — An event or a level, per handle.** A `SourceExpr` is an event when the
live node emits on that handle per input or per occurrence, whatever it
carries: Compare and Gate `true`/`false` (each check), Button and Switch
`true`/`false`/`event` (each new level), Delay and Interval `event`, Trigger
`bang`, RangeMap `to` (each mapped value), Monitor's output, an Mqtt subscribe
or design variable `value`/`change` (each message, repeats included), Midi in
note mode, an Oscillator's `value` (each sample) and a Constant's one emission
at the start. It carries an explicit fired flag. A level is a `value` the live
node emits through `set_value`, when it changes; it has no fired flag, and a
pulse-consuming port synthesizes a change detector over it (`bind_pulses`),
starting from the value the live node holds before it first emits
(`SourceExpr::starting_at`).

A Function's `value` is an event. The live Function emits through `set_value`
only when an evaluation changes the value it holds, so the sketch fires
`value` on exactly those evaluations. The node starts at the number 0, so a
first boolean result is a change. An evaluation that throws keeps the value
and sends nothing. The type of `value` follows the code the Function runs on
its input, so the sketch resolves the Function's input against the flow, as
it does a Monitor's.

**D2 — A boolean node's handles all carry its state.** A boolean node is its
state plus an emitted flag (`bool_state(state, emitted, handle)` in
`codegen/mod.rs`): `event` fires when it emits, `true` when it emits with the
state true, `false` when it emits with the state false, and each carries the
state, so `false` carries `false` (0). `value` is a level. Nothing fires at
boot: a Button's `false` waits for a release.

**D3 — One transform rule.** `NodeEmission::transform(prefix, sources, step)`
(`codegen/emit.rs`) runs a transform's step only on the loop iterations one of
its sources fires, and declares `{prefix}_fired`, the transform's own emission
tick. With no source the step never runs. An aggregating node (Gate,
Calculate) runs once on an iteration any source fires and reads every source's
current value, as the live snapshot does. Compare, Gate, Calculate, Function,
Smooth and RangeMap run by it; a Stepper's `to` moves once per value.

**D4 — One constant per bound, read by both halves.**

- Equality: `compare::config::EQUALITY_TOLERANCE`, through
  `CompareConfig::equals` live and the same comparison in the sketch.
- Contact debounce: `config::DEBOUNCE_MS` (50 ms) for Button and Switch, live
  and through `codegen::emit::debounced_read`. A Button's `hold` fires once
  after `holdtime`, on both.
- A Sensor hands on a reading once it is `threshold` or more from the one it
  holds, on both.
- An Oscillator samples every `SAMPLE_MS` (16 ms) and emits every sample, moved
  or not, on both.
- A Proximity converts by its controller's `ProximityConfig::ranging()` and
  hands on a move of more than `MIN_MOVE_CM`, on both.
- A Midi control change rounds and clamps its value to 0–127, as
  `Midi::encode` does.
- Mqtt and design-variable payloads are written as the live node writes them
  (`codegen::cloud::payload`): a number as Rust's `f64` Display
  (`mf_number_text`: shortest round-trip digits, no exponent), a boolean as
  `true`/`false`, text as itself, and a design variable's value coerced to its
  type as `design_bridge::coerce` and `encode` do. A Monitor publishes what it
  shows the same way. A number literal in the sketch (`cpp_double`) that is a
  whole number of 1e15 or more is written with an exponent.

**D5 — A Constant emits once at the start.** The live Constant emits its value
when the flow starts, 0 included; the sketch fires it once on the first loop
iteration, so a pulse-consuming port downstream fires once.

**D6 — Two guards, driven from the live registry.** In
`crates/microflow-core/src/codegen/parity.rs`, over every declared Port of
every node (but a Port the sketch refuses):

- `an_emit_the_live_node_repeats_for_a_repeated_input_is_an_event_in_the_sketch`:
  an Emit the live node sends again when the same value reaches it again is an
  event in the sketch.
- `an_emit_that_carries_the_nodes_value_carries_the_same_value_in_the_sketch`:
  an Emit that carries the node's own value (a boolean node's `true` and
  `false`, a Pixel's `event`) carries the same on-device value as its `value`.

A new node or handle whose sketch timing or value departs from the live node
fails one of them.

## Considered options

- **Change detectors everywhere.** One shape for every handle, but a repeated
  value is invisible to it, and a repeated value is what a Counter, an Mqtt
  publish or a Midi note exists to count or send.
- **Fire every transform on every loop pass.** Simple to emit, but an average,
  a count or a publish would follow the loop's speed instead of the inputs.
- **Per-node timing written by hand, held by golden sketches.** That is what
  produced the differences above: a golden file pins what a sketch says, not
  whether it agrees with the live node.

## Consequences

- An uploaded flow counts, publishes and averages what the live flow does.
- Stored flows: on the board, a Compare's, Gate's, Button's, Switch's or
  Motion's `false` carries 0; Compare and Gate fire `true`/`false` on every
  check and do not check before their first input; a Button's `false` does not
  fire at boot; Calculate and Function compute only when a source fires; a
  Monitor's output, an Mqtt or design variable message and a Midi note fire on
  every occurrence, repeats included.
- The golden sketches change with each such rule, and the guards, not the
  golden files, say whether a change is right.
- A transform with no wired source emits nothing on the board.
- A Function whose code the board cannot run as the live node does is
  refused: generation reports a warning naming the reason
  (`function::codegen::board_refusal`), and the node never runs on the board.

## What this does NOT decide

- What value an Emit carries on the board, or which Emits have none
  ([ADR-0013](0013-handle-aware-sketch-wiring.md), amendment).
- How Delay and Trigger bound what they hold
  ([ADR-0043](0043-timed-nodes-share-one-bound-live-and-on-the-board.md)).

## References

- `crates/microflow-core/src/codegen/wire.rs` — `SourceExpr`, `bind_pulses`.
- `crates/microflow-core/src/codegen/emit.rs` — `NodeEmission::transform`, `debounced_read`.
- `crates/microflow-core/src/codegen/mod.rs` — `output_expression`, `bool_state`.
- `crates/microflow-core/src/nodes/compare/config.rs` — `EQUALITY_TOLERANCE`, `CompareConfig::equals`.
- `crates/microflow-core/src/config/mod.rs` — `DEBOUNCE_MS`.
- `crates/microflow-core/src/codegen/parity.rs` — the two guards.
- `crates/microflow-core/src/codegen/cloud/payload.rs` — `mf_number_text`, the design-variable coercion on the board.
- `crates/microflow-core/src/nodes/function/codegen.rs` — the Function subset, `board_refusal`.
- `crates/microflow-core/tests/boolean_sketch.rs`, `input_sketch.rs`, `output_sketch.rs`, `function_sketch.rs`, `cloud_sketch.rs`, `i2c_sketch.rs`, `midi_sketch.rs` — the sketches run against the live nodes.
- `CONTEXT.md` § Sketch Wiring (Transform rule), Debounce window, Ranging.
