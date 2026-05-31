//! Error type for the flasher module.
//!
//! Defined in `microflow-core` (the platform-independent flasher core) and
//! re-exported here so existing `crate::flasher::error::FlashError` paths keep
//! working unchanged.

pub use microflow_core::flasher::FlashError;
