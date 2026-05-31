//! Embedded `StandardFirmata` firmware hex.
//!
//! The hex images now live in `microflow-core` (shared with the browser via
//! wasm); this delegates so there is a single embedded copy.

use super::types::BoardType;

/// Embedded `StandardFirmata` hex files for each board type.
pub struct Firmware;

impl Firmware {
    /// Get the `StandardFirmata` hex content for a board type.
    #[must_use]
    pub fn get_firmata_hex(board_type: BoardType) -> &'static str {
        microflow_core::flasher::firmware::standard_firmata_hex(board_type)
    }
}
