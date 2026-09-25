//! Serde helpers shared by the Node configs.
//!
//! Each Node's config lives with the Node, in `crate::nodes::<node>::config`
//! (ADR-0026). This module holds what those configs share: the pin
//! string-or-number helpers in [`serde_utils`]. Ungated like the configs, so
//! codegen-only consumers reach them without the `runtime` feature.

pub mod serde_utils;
