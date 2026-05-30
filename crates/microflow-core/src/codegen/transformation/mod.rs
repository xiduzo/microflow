//! Transformation-Node C++ emitters (Calculate, Compare, Gate, `RangeMap`,
//! Smooth, Function) — the codegen mirror of `runtime/transformation`.
//!
//! Each transformation Node is both a consumer and a producer in the generated
//! value-passing model: it reads the C++ expression of its wired source (its
//! `driver`) and writes its result into an output variable that downstream
//! Nodes read. The output variable name is exposed by each module's
//! `value_var`/`state_var` accessor so [`crate::codegen`] can wire it as a
//! driver for the Node's targets.
//!
//! Like the input/output emitters, every emitter is a pure function of a single
//! [`crate::flow::FlowNode`] (plus its driver) and reads the same
//! `data` the live runtime deserializes into its `*Config`. The emitted C++
//! reproduces the runtime semantics so that, for identical inputs, the
//! generated Sketch yields the same output the Flow Author sees in live mode.

pub mod calculate;
pub mod compare;
pub mod function;
pub mod gate;
pub mod range_map;
pub mod smooth;
