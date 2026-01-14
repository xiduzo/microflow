//! Firmware Flasher Module
//!
//! This module handles flashing firmware (like StandardFirmata) to Arduino boards.
//!
//! # Architecture
//!
//! ```text
//! flasher/
//! ├── mod.rs           - Public API and module orchestration
//! ├── types.rs         - Shared types (BoardType, FlashResult, etc.)
//! ├── boards.rs        - Board configurations and detection
//! ├── firmware.rs      - Embedded StandardFirmata hex files
//! ├── hex.rs           - Intel HEX file parser
//! ├── error.rs         - Error types
//! ├── commands.rs      - Tauri command handlers
//! └── protocols/
//!     ├── mod.rs       - Protocol trait and exports
//!     ├── stk500v1.rs  - STK500v1 protocol (Uno, Nano)
//!     └── avr109.rs    - AVR109 protocol (Leonardo, Micro)
//! ```

mod boards;
mod error;
mod firmware;
mod hex;
mod protocols;
mod types;

// Public modules
pub mod commands;

// Re-export public API
pub use boards::BoardConfig;
pub use error::FlashError;
pub use firmware::Firmware;
pub use types::{BoardType, FlashResult};

use protocols::{Avr109Flasher, Protocol, Stk500v1Flasher, Stk500v2Flasher};

/// Main flasher interface - orchestrates the flashing process
pub struct Flasher;

impl Flasher {
    /// Flash firmware to a board
    pub fn flash(
        port_name: &str,
        board_type: BoardType,
        hex_content: &str,
    ) -> Result<FlashResult, FlashError> {
        let config = BoardConfig::find(board_type)
            .ok_or_else(|| FlashError::UnsupportedBoard(format!("{:?}", board_type)))?;

        log::info!(
            "Flashing {:?} on {} using {:?} protocol",
            board_type,
            port_name,
            config.protocol
        );

        let hex_data = hex::parse(hex_content)?;
        log::info!("Parsed {} bytes from hex file", hex_data.len());

        match config.protocol {
            Protocol::Stk500v1 => {
                let mut flasher = Stk500v1Flasher::new(port_name, config)?;
                flasher.flash(&hex_data)?;
            }
            Protocol::Stk500v2 => {
                let mut flasher = Stk500v2Flasher::new(port_name, config)?;
                flasher.flash(&hex_data)?;
            }
            Protocol::Avr109 => {
                let mut flasher = Avr109Flasher::new(port_name, config);
                flasher.flash(&hex_data)?;
            }
        }

        Ok(FlashResult {
            success: true,
            message: "Firmware flashed successfully".to_string(),
            board: format!("{:?}", board_type),
            port: port_name.to_string(),
        })
    }

    /// Flash StandardFirmata to a board (auto-selects the correct hex file)
    pub fn flash_standard_firmata(
        port_name: &str,
        board_type: BoardType,
    ) -> Result<FlashResult, FlashError> {
        let hex_content = Firmware::get_firmata_hex(board_type)
            .ok_or_else(|| FlashError::UnsupportedBoard(format!("{:?}", board_type)))?;

        log::info!("Flashing StandardFirmata to {:?} on {}", board_type, port_name);
        Self::flash(port_name, board_type, hex_content)
    }

    /// Detect board type from USB VID/PID and flash StandardFirmata
    pub fn auto_flash_firmata(
        port_name: &str,
        vid: u16,
        pid: u16,
    ) -> Result<FlashResult, FlashError> {
        let board_type = BoardConfig::detect_from_usb(vid, pid)
            .ok_or_else(|| FlashError::UnsupportedBoard(format!("VID:{:04x} PID:{:04x}", vid, pid)))?;

        log::info!(
            "Auto-detected board type {:?} from VID:{:04x} PID:{:04x}",
            board_type, vid, pid
        );

        Self::flash_standard_firmata(port_name, board_type)
    }
}
