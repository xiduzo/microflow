//! Platform-independent flasher core: the transport-free pieces of firmware
//! flashing, shared by the desktop flasher and (via wasm) the browser.
//!
//! What lives here is pure and portable: the Intel-HEX parser ([`hex`]), the
//! board catalogue + USB detection ([`BoardConfig`]), the supported board /
//! protocol enums, and the error type. The actual bootloader **I/O
//! orchestration** (DTR/RTS reset timing, sync-retry loops, baud fallback,
//! `read_exact`) is deliberately *not* here — it is timing-critical, transport-
//! coupled, and (for AVR109) involves USB re-enumeration that the browser's Web
//! Serial API models very differently. That orchestration stays per-platform.
//!
//! The desktop `flasher` module re-exports these types so it keeps a single
//! definition; the browser parses hex and detects boards through the same code.

pub mod hex;

use serde::{Deserialize, Serialize};

/// Supported flashing protocols.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Stk500v1,
    Stk500v2,
    Avr109,
}

/// Supported board types.
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
    /// Get all supported board types.
    #[must_use]
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

    /// Get board type as lowercase string.
    #[must_use]
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

/// Errors that can occur during flashing.
#[derive(Debug)]
pub enum FlashError {
    /// Failed to open serial port
    PortOpen(String),
    /// Failed to communicate with bootloader
    Communication(String),
    /// Board signature mismatch
    SignatureMismatch { expected: Vec<u8>, actual: Vec<u8> },
    /// Failed to sync with bootloader
    SyncFailed,
    /// Programming failed
    ProgramFailed(String),
    /// Verification failed
    VerifyFailed(String),
    /// Invalid hex file
    InvalidHex(String),
    /// Unsupported board type
    UnsupportedBoard(String),
    /// Unsupported protocol
    UnsupportedProtocol(String),
    /// Board not found after reset
    BoardNotFound(String),
    /// Generic IO error
    Io(String),
}

impl std::fmt::Display for FlashError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PortOpen(msg) => write!(f, "Failed to open port: {msg}"),
            Self::Communication(msg) => write!(f, "Communication error: {msg}"),
            Self::SignatureMismatch { expected, actual } => {
                write!(f, "Signature mismatch: expected {expected:02X?}, got {actual:02X?}")
            }
            Self::SyncFailed => write!(f, "Failed to sync with bootloader"),
            Self::ProgramFailed(msg) => write!(f, "Programming failed: {msg}"),
            Self::VerifyFailed(msg) => write!(f, "Verification failed: {msg}"),
            Self::InvalidHex(msg) => write!(f, "Invalid hex file: {msg}"),
            Self::UnsupportedBoard(board) => write!(f, "Unsupported board: {board}"),
            Self::UnsupportedProtocol(proto) => write!(f, "Unsupported protocol: {proto}"),
            Self::BoardNotFound(port) => write!(f, "Board not found on {port} after reset"),
            Self::Io(msg) => write!(f, "IO error: {msg}"),
        }
    }
}

impl std::error::Error for FlashError {}

impl From<FlashError> for String {
    fn from(err: FlashError) -> Self {
        err.to_string()
    }
}

/// Board configuration: bootloader baud, expected signature, flash page size,
/// and which protocol drives it.
#[derive(Debug, Clone)]
pub struct BoardConfig {
    pub board_type: BoardType,
    pub baud_rate: u32,
    pub signature: Vec<u8>,
    pub page_size: usize,
    pub timeout: u32,
    pub protocol: Protocol,
}

/// USB Product IDs for board detection (lowercase hex without `0x` prefix).
pub struct BoardProductIds;

impl BoardProductIds {
    /// Arduino Uno product IDs
    pub const UNO: &'static [&'static str] = &["0043", "7523", "0001", "ea60", "6015"];
    /// Arduino Mega product IDs
    pub const MEGA: &'static [&'static str] = &["0042", "6001", "0010", "7523"];
    /// Arduino Nano product IDs (shared between old and new bootloader)
    pub const NANO: &'static [&'static str] = &["6001", "7523"];
    /// Arduino Leonardo product IDs
    pub const LEONARDO: &'static [&'static str] = &["0036", "8036", "800c"];
    /// Arduino Micro product IDs
    pub const MICRO: &'static [&'static str] = &["0037", "8037", "0036", "0237"];
}

impl BoardConfig {
    /// Get configuration for a specific board type.
    #[must_use]
    pub fn find(board_type: BoardType) -> Self {
        match board_type {
            BoardType::Uno => Self {
                board_type: BoardType::Uno,
                baud_rate: 115200,
                signature: vec![0x1e, 0x95, 0x0f],
                page_size: 128,
                timeout: 400,
                protocol: Protocol::Stk500v1,
            },
            BoardType::Nano => Self {
                board_type: BoardType::Nano,
                baud_rate: 57600,
                signature: vec![0x1e, 0x95, 0x0f],
                page_size: 128,
                timeout: 400,
                protocol: Protocol::Stk500v1,
            },
            BoardType::NanoNew => Self {
                board_type: BoardType::NanoNew,
                baud_rate: 115200,
                signature: vec![0x1e, 0x95, 0x0f],
                page_size: 128,
                timeout: 400,
                protocol: Protocol::Stk500v1,
            },
            BoardType::Mega => Self {
                board_type: BoardType::Mega,
                baud_rate: 115200,
                signature: vec![0x1e, 0x98, 0x01],
                page_size: 256,
                timeout: 200,
                protocol: Protocol::Stk500v2,
            },
            BoardType::Leonardo => Self {
                board_type: BoardType::Leonardo,
                baud_rate: 57600,
                signature: vec![0x43, 0x41, 0x54, 0x45, 0x52, 0x49, 0x4e],
                page_size: 128,
                timeout: 400,
                protocol: Protocol::Avr109,
            },
            BoardType::Micro => Self {
                board_type: BoardType::Micro,
                baud_rate: 57600,
                signature: vec![0x43, 0x41, 0x54, 0x45, 0x52, 0x49, 0x4e],
                page_size: 128,
                timeout: 400,
                protocol: Protocol::Avr109,
            },
        }
    }

    /// Detect board type from USB product ID. Returns the most likely board
    /// type based on PID.
    #[must_use]
    pub fn detect_from_pid(pid: u16) -> Option<BoardType> {
        let pid_str = format!("{pid:04x}");

        // Check in order of specificity (more unique PIDs first)
        if BoardProductIds::UNO.contains(&pid_str.as_str()) {
            // UNO has unique PIDs like 0043, 0001, ea60, 6015
            // But 7523 is shared with Nano - check VID too if needed
            return Some(BoardType::Uno);
        }

        if BoardProductIds::LEONARDO.contains(&pid_str.as_str()) {
            return Some(BoardType::Leonardo);
        }

        if BoardProductIds::MICRO.contains(&pid_str.as_str()) {
            // 0036 is shared with Leonardo, but 0037, 8037, 0237 are unique
            if pid_str == "0037" || pid_str == "8037" || pid_str == "0237" {
                return Some(BoardType::Micro);
            }
        }

        if BoardProductIds::MEGA.contains(&pid_str.as_str()) {
            // 0042 and 0010 are unique to Mega
            if pid_str == "0042" || pid_str == "0010" {
                return Some(BoardType::Mega);
            }
        }

        // Nano detection is tricky - 6001 and 7523 are shared
        // Default to Nano with old bootloader, user can override
        if BoardProductIds::NANO.contains(&pid_str.as_str()) {
            return Some(BoardType::Nano);
        }

        None
    }

    /// Detect board type from USB VID and PID combination.
    #[must_use]
    pub fn detect_from_usb(vid: u16, pid: u16) -> Option<BoardType> {
        let pid_str = format!("{pid:04x}");

        // CH340 chips (VID 0x1A86) are typically used on Nano clones
        // FTDI chips (VID 0x0403) can be Nano or Uno clones
        let is_ch340 = vid == 0x1a86;
        let is_ftdi = vid == 0x0403;

        // Arduino official VID
        let is_arduino = vid == 0x2341 || vid == 0x2a03;

        // For shared PIDs like 7523, use VID to disambiguate
        if pid_str == "7523" {
            if is_ch340 {
                log::info!("CH340 chip detected with PID 7523 - assuming Nano (old bootloader)");
                return Some(BoardType::Nano);
            }
            if is_ftdi {
                log::info!("FTDI chip detected with PID 7523 - assuming Nano");
                return Some(BoardType::Nano);
            }
        }

        // For official Arduino boards, use PID detection
        if is_arduino {
            return Self::detect_from_pid(pid);
        }

        // Fall back to PID-only detection for other VIDs
        Self::detect_from_pid(pid)
    }
}

#[cfg(test)]
mod tests;
