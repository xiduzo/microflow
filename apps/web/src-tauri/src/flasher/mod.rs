//! Firmware Flasher Module
//!
//! Flashes firmware (like `StandardFirmata`) onto Arduino boards.
//!
//! The bootloader protocols (`STK500v1`, `STK500v2`, AVR109) are not here: they
//! are the sans-IO `FlashDriver`s in `microflow_core::flasher`, shared with the
//! browser. This module is the desktop's executor of those drivers: it carries
//! their steps out on a serial port.
//!
//! ```text
//! flasher/
//! ├── mod.rs           - Public API: parse the hex, pick the driver, run it
//! ├── executor.rs      - Runs a FlashDriver's steps on a serial port
//! ├── serial.rs        - SerialHost: the seam to the OS's serial ports
//! ├── sim_serial.rs    - Test adapter of that seam: a modelled board
//! ├── hardware_smoke.rs - Ignored test: flash a real board
//! ├── commands.rs      - Tauri command handlers
//! └── types.rs         - Command result payloads
//! ```
//!
//! The board catalogue, the embedded firmware, the hex parser and the error
//! type are core's too.

mod executor;
#[cfg(test)]
mod hardware_smoke;
mod serial;
#[cfg(test)]
mod sim_serial;
#[cfg(test)]
mod tests;
mod types;

// Public modules
pub mod commands;

pub use microflow_core::flasher::{BoardConfig, BoardType, FlashError};
pub use types::FlashResult;

use microflow_core::flasher::{firmware, hex, new_driver};
use serial::{SerialHost, SystemSerial};

/// Main flasher interface - orchestrates the flashing process
pub struct Flasher;

impl Flasher {
    /// Flash firmware to a board
    pub fn flash(
        port_name: &str,
        board_type: BoardType,
        hex_content: &str,
    ) -> Result<FlashResult, FlashError> {
        let config = BoardConfig::find(board_type);

        log::info!(
            "Flashing {:?} on {} using {:?} protocol",
            board_type,
            port_name,
            config.protocol
        );

        let hex_data = hex::parse(hex_content)?;
        log::info!("Parsed {} bytes from hex file", hex_data.len());

        flash_image(&SystemSerial, port_name, board_type, &hex_data)?;

        Ok(FlashResult {
            success: true,
            message: "Firmware flashed successfully".to_string(),
            board: format!("{board_type:?}"),
            port: port_name.to_string(),
        })
    }

    /// Flash `StandardFirmata` to a board (auto-selects the correct hex file)
    pub fn flash_standard_firmata(
        port_name: &str,
        board_type: BoardType,
    ) -> Result<FlashResult, FlashError> {
        let hex_content = firmware::standard_firmata_hex(board_type);

        log::info!("Flashing StandardFirmata to {board_type:?} on {port_name}");
        Self::flash(port_name, board_type, hex_content)
    }

    /// Detect board type from USB VID/PID and flash `StandardFirmata`
    pub fn auto_flash_firmata(
        port_name: &str,
        vid: u16,
        pid: u16,
    ) -> Result<FlashResult, FlashError> {
        let board_type = BoardConfig::detect_from_usb(vid, pid)
            .ok_or_else(|| FlashError::UnsupportedBoard(format!("VID:{vid:04x} PID:{pid:04x}")))?;

        log::info!(
            "Auto-detected board type {board_type:?} from VID:{vid:04x} PID:{pid:04x}"
        );

        Self::flash_standard_firmata(port_name, board_type)
    }
}

/// Program the raw flash `image` onto the board on `port_name`, through `host`:
/// the board's core driver, run by the desktop executor.
fn flash_image(
    host: &dyn SerialHost,
    port_name: &str,
    board_type: BoardType,
    image: &[u8],
) -> Result<(), FlashError> {
    let baud = BoardConfig::find(board_type).baud_rate;
    let mut driver = new_driver(board_type, image.to_vec());
    executor::run(host, port_name, baud, driver.as_mut())
}
