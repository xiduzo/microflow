//! The `Music` node.

// No emitter, so the runtime is the config's only reader: it shares that gate.
#[cfg(feature = "cloud")]
pub(crate) mod config;
#[cfg(feature = "cloud")]
pub(crate) mod runtime;
