//! Flow types matching the TypeScript runtime.
//!
//! The definitions now live in the platform-independent `microflow-core` crate
//! (shared with codegen and the future WebAssembly build). They are re-exported
//! here so the existing `crate::runtime::types::…` paths used throughout the
//! runtime keep resolving to the same canonical types.

pub use microflow_core::flow::{FlowEdge, FlowNode, FlowUpdate, Position};
