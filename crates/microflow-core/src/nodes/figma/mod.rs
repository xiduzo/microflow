//! The `Figma` node — a design-tool bridge to the Figma and Penpot plugins.

pub(crate) mod codegen;
pub(crate) mod config;
#[cfg(feature = "cloud")]
pub(crate) mod runtime;
