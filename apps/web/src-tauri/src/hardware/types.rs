//! Shared types for the hardware module

use serde::{Deserialize, Serialize};

/// Pin information matching frontend Pin type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinInfo {
    pub pin: usize,
    pub supported_modes: Vec<u8>,
    pub analog_channel: i32, // -1 if not analog
}

/// Board state for frontend events
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum BoardState {
    #[serde(rename = "connected")]
    Connected {
        port: String,
        firmware_name: String,
        firmware_version: String,
        pins: Vec<PinInfo>,
    },
    #[serde(rename = "connecting")]
    Connecting {},
    #[serde(rename = "flashing")]
    Flashing { port: String, board: String },
    #[serde(rename = "disconnected")]
    Disconnected {},
    #[serde(rename = "error")]
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

/// Response from hardware operations (sidecar)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareResponse {
    pub success: bool,
    pub message: String,
}

/// Hardware status information (sidecar)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareStatus {
    pub connected: bool,
    pub blinking: bool,
    pub pin: Option<u8>,
    pub interval: Option<u32>,
}
