//! The frontend-facing result and progress types: the payloads of the Tauri
//! commands and events, which only the desktop has.

use serde::{Deserialize, Serialize};

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
