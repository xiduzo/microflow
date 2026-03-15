//! Shared types for the flasher module

use serde::{Deserialize, Serialize};

/// Supported board types
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BoardType {
    Uno,
    Nano,
    NanoNew,
    Mega,
    Leonardo,
    Micro,
}

impl BoardType {
    /// Get all supported board types
    pub fn all() -> Vec<Self> {
        vec![
            Self::Uno,
            Self::Nano,
            Self::NanoNew,
            Self::Mega,
            Self::Leonardo,
            Self::Micro,
        ]
    }

    /// Get board type as lowercase string
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Uno => "uno",
            Self::Nano => "nano",
            Self::NanoNew => "nanoNew",
            Self::Mega => "mega",
            Self::Leonardo => "leonardo",
            Self::Micro => "micro",
        }
    }
}

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
