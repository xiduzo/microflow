//! Board configurations and USB detection.
//!
//! Defined in `microflow-core` (shared with the browser) and re-exported here
//! so existing `crate::flasher::boards::{BoardConfig, BoardProductIds}` paths
//! keep working unchanged.

pub use microflow_core::flasher::BoardConfig;
