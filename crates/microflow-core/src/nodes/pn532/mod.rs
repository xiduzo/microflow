//! The `Pn532` node.

// No emitter yet, so the runtime is the config's only reader: it shares that
// gate until a `codegen.rs` needs it ungated.
#[cfg(feature = "runtime")]
pub(crate) mod config;
#[cfg(feature = "runtime")]
pub(crate) mod runtime;
