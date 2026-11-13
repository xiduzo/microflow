//! Shared types for the hardware module

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One pin of the board's pin profile — defined once in core, shared with the
/// browser's `FirmataSession.pinsJson` and the runtime's seed.
pub use microflow_core::firmata::PinInfo;

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
    /// No Firmata answered, and `board` is only guessed from a generic
    /// USB-serial chip: the UI asks before flashing (`confirm_board_flash` /
    /// `decline_board_flash`).
    #[serde(rename = "confirmFlash")]
    ConfirmFlash { port: String, board: String, vid: u16, pid: u16 },
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
