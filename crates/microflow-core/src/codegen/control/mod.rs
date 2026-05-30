//! Control-Node C++ emitters (Delay, Interval, Trigger, Counter, Constant) —
//! the codegen mirror of `runtime/control` and `runtime/generator/constant`.
//!
//! On-device there is no host event loop, so the live runtime's thread-and-sleep
//! timing model (`std::thread::spawn` + `sleep` in `runtime/control/delay.rs` and
//! `runtime/generator/interval.rs`) cannot be reproduced verbatim — a blocking
//! `delay()` would freeze the whole Sketch. Instead every timing Node compares
//! `millis()` against a stored next-fire timestamp and yields control each loop
//! iteration, so multiple timers tick concurrently without one stalling the
//! others. Stateful Nodes (Counter count, Delay/Interval timestamps) keep their
//! state in module-level variables that persist across `loop()` iterations.
//!
//! Like the input/output and transformation emitters, every emitter is a pure
//! function of a single [`crate::flow::FlowNode`] (plus its driver)
//! and reads the same `data` the live runtime deserializes into its `*Config`.
//! The emitted C++ reproduces the runtime semantics so that, for identical
//! inputs, the generated Sketch yields the same output the Flow Author sees in
//! live mode.
//!
//! ## Non-blocking timer invariant
//!
//! No emitter in this module ever emits a blocking `delay()`. Timing is always
//! expressed as `millis() - previous >= interval` so the scheduler in
//! [`crate::codegen`] completes every iteration without waiting, and `millis()`
//! rollover (~49 days) is handled by the unsigned elapsed-time subtraction.

pub mod constant;
pub mod counter;
pub mod delay;
pub mod interval;
pub mod trigger;
