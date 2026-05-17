//! Shared types for the hardware module

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Pin information matching frontend Pin type
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PinInfo {
    #[ts(type = "number")]
    pub pin: usize,
    pub supported_modes: Vec<u8>,
    pub analog_channel: i32, // -1 if not analog
}

/// Board state for frontend events
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, rename_all = "camelCase", rename_all_fields = "camelCase")]
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
        // Always serialized (as `null` when unset) so ts-rs can mirror the
        // shape into `BoardState.ts` without juggling `skip_serializing_if`
        // attrs it does not understand.
        error: Option<String>,
    },
}
