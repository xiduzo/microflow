//! One directory per Node: its config, live runtime, and Arduino emitter side
//! by side (ADR-0026).
//!
//! `nodes/<node>/` holds only the layers that Node has, each declared in its
//! `mod.rs` behind the same gate it needs:
//!
//! - `config.rs` — the Node's config (fields, defaults, config-only enums).
//!   **Ungated**: the live runtime (interpret) and the emitter (compile to C++)
//!   both deserialize `node.data` into this one struct, so a default such as
//!   Smooth's `0.995` exists once and the two sides cannot disagree about what a
//!   Node means. A Node with no emitter (`Pn532`, `Music`) puts its config
//!   behind its runtime's gate, since the runtime is its only reader.
//! - `runtime.rs` — the live `Component` impl. Behind the `runtime` feature;
//!   the sans-IO cloud Nodes (`Mqtt`, `Llm`, `Figma`, `Midi`, `Music`) sit
//!   behind `cloud` and `Function` behind `js` (both imply `runtime`).
//! - `codegen.rs` — the Arduino C++ emitter. **Ungated**, so the lean
//!   `microflow-codegen-wasm` build compiles it without the runtime's deps.
//!
//! Inside a Node's directory, a layer reaches its own config through
//! `super::config`; shared infrastructure is always `crate::runtime::…` /
//! `crate::codegen::…`. Dispatch stays central and explicit (ADR-0012): every
//! Node is named once in `ComponentRegistry::register_all`, in
//! `codegen::emit_node` / `codegen::output_expression`, and in
//! `codegen/parity.rs::classify`.
//!
//! The boundary is enforced. `nodes` and everything in it is `pub(crate)`, so
//! no other crate reaches a Node's internals, and the `boundaries` test fails
//! when a Node names another Node, when a file outside the central dispatch
//! tables names a Node, or when this index and the Node directories disagree.
//!
//! ## Writing an emitter
//!
//! Every emitter is a pure function of one [`crate::flow::FlowNode`] (plus its
//! wired inputs) and reads the same `data` the runtime deserializes into the
//! Node's config. The emitted C++ reproduces the runtime semantics so that, for
//! identical inputs, the generated Sketch yields the same output the Flow Author
//! sees in live mode.
//!
//! A transformation Node is both a consumer and a producer: it reads the C++
//! expression of its wired source and writes its result into an output
//! variable that downstream Nodes read. Its `value_var` / `state_var` accessor
//! exposes that name so [`crate::codegen`] can wire it as a driver for the
//! Node's targets.
//!
//! ### Non-blocking timer invariant
//!
//! On-device there is no host event loop, so the live runtime's wakeup-based
//! timing cannot be reproduced verbatim, and a blocking `delay()` would freeze
//! the whole Sketch. No emitter ever emits a blocking `delay()`. Every timing
//! Node compares `millis()` against a stored timestamp —
//! `millis() - previous >= interval` — and yields each loop iteration, so
//! multiple timers tick concurrently and `millis()` rollover
//! (~49 days) is handled by the unsigned elapsed-time subtraction. Stateful
//! Nodes (Counter count, Delay/Interval timestamps) keep their state in
//! module-level variables that persist across `loop()` iterations.

pub(crate) mod button;
pub(crate) mod calculate;
pub(crate) mod compare;
pub(crate) mod constant;
pub(crate) mod counter;
pub(crate) mod delay;
pub(crate) mod figma;
pub(crate) mod function;
pub(crate) mod gate;
pub(crate) mod hotkey;
pub(crate) mod i2c_device;
pub(crate) mod interval;
pub(crate) mod led;
pub(crate) mod llm;
pub(crate) mod matrix;
pub(crate) mod midi;
pub(crate) mod monitor;
pub(crate) mod motion;
pub(crate) mod mqtt;
pub(crate) mod music;
pub(crate) mod note;
pub(crate) mod oscillator;
pub(crate) mod piezo;
pub(crate) mod pixel;
pub(crate) mod pn532;
pub(crate) mod proximity;
pub(crate) mod range_map;
pub(crate) mod relay;
pub(crate) mod rgb;
pub(crate) mod sensor;
pub(crate) mod servo;
pub(crate) mod smooth;
pub(crate) mod stepper;
pub(crate) mod switch;
pub(crate) mod trigger;

// The vertical-boundary guard (ADR-0026 § Enforcement); not a Node.
#[cfg(test)]
mod boundaries;
