//! Shared types for the flasher module.
//!
//! [`BoardType`] is defined in `microflow-core` (shared with the browser) and
//! re-exported here. The frontend-facing result/progress types stay desktop-
//! local since they describe the Tauri command/event payloads.

use serde::{Deserialize, Serialize};

pub use microflow_core::flasher::BoardType;

/// Flash operation result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashResult {
    pub success: bool,
    pub message: String,
    pub board: String,
    pub port: String,
}

/// Flash progress event for frontend updates
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashProgress {
    pub stage: FlashStage,
    pub progress: f32,
    pub message: String,
}

/// Stages of the flash process
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FlashStage {
    Connecting,
    Resetting,
    Syncing,
    Erasing,
    Programming,
    Verifying,
    Complete,
    Error,
}
