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

pub mod avr109;
pub mod driver;
pub mod firmware;
pub mod hex;
pub mod stk500v1;
pub mod stk500v2;

pub use driver::{FlashDriver, FlashStep};

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

    /// Parse a board type from its lowercase id (the inverse of [`as_str`](Self::as_str)).
    #[must_use]
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "uno" => Some(Self::Uno),
            "nano" => Some(Self::Nano),
            "nanoNew" => Some(Self::NanoNew),
            "mega" => Some(Self::Mega),
            "leonardo" => Some(Self::Leonardo),
            "micro" => Some(Self::Micro),
            _ => None,
        }
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
    ///
    /// PID alone proves nothing (several of these are generic bridge-chip PIDs),
    /// so this must never decide whether to flash: use
    /// [`detect_from_usb`](Self::detect_from_usb) for that.
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

    /// The board a USB VID/PID **positively identifies** — the only board a
    /// host may flash without asking. `None` for a generic USB-serial bridge
    /// chip (CH340, `CP210x`, FTDI) and for an unknown VID, even when the PID is
    /// one that clone boards commonly use: those chips are also on ESP32 dev
    /// boards, GPS modules and plain USB-serial adapters, and flashing them would
    /// overwrite someone else's firmware. Use [`identify_usb`](Self::identify_usb)
    /// for the full answer, including the board a bridge chip suggests.
    #[must_use]
    pub fn detect_from_usb(vid: u16, pid: u16) -> Option<BoardType> {
        Self::identify_usb(vid, pid).and_then(UsbMatch::auto_flash_board)
    }

    /// What a USB VID/PID says about the device behind a serial port: a
    /// positively identified board, a bridge chip that only *suggests* a board,
    /// or (`None`) nothing we recognise.
    #[must_use]
    pub fn identify_usb(vid: u16, pid: u16) -> Option<UsbMatch> {
        if vid == ARDUINO_VID || vid == ARDUINO_ORG_VID {
            return official_board(pid).map(UsbMatch::Identified);
        }
        let chip = BridgeChip::from_vid(vid)?;
        // The PIDs Arduino clones ship with; the chip itself proves nothing.
        let board = match (chip, pid) {
            (BridgeChip::Ch340, 0x7523) | (BridgeChip::Ftdi, 0x6001) => BoardType::Nano,
            (BridgeChip::Ftdi, 0x6015) | (BridgeChip::Cp210x, 0xea60) => BoardType::Uno,
            _ => return None,
        };
        Some(UsbMatch::BridgeChip { board, chip })
    }
}

// Positively identified vendors: only the official Arduino VIDs below. A vendor
// that ships boards under its own USB VID (e.g. SparkFun 0x1B4F) is a candidate
// for future positive identification; a generic bridge-chip VID never is.

/// Arduino LLC's USB vendor id.
const ARDUINO_VID: u16 = 0x2341;
/// Arduino SRL's (arduino.org) USB vendor id.
const ARDUINO_ORG_VID: u16 = 0x2a03;

/// The board an official Arduino PID names. Only native-USB and Arduino-made
/// USB-serial PIDs: a bridge-chip PID under an Arduino VID is not a real device.
fn official_board(pid: u16) -> Option<BoardType> {
    match pid {
        0x0043 | 0x0001 => Some(BoardType::Uno),
        0x0010 | 0x0042 => Some(BoardType::Mega),
        0x0036 | 0x8036 | 0x800c => Some(BoardType::Leonardo),
        0x0037 | 0x8037 | 0x0237 => Some(BoardType::Micro),
        _ => None,
    }
}

/// A generic USB-to-serial bridge chip. Its VID/PID names the chip, not the
/// board it is soldered onto.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeChip {
    /// WCH CH340/CH341 (VID 0x1A86).
    Ch340,
    /// Silicon Labs `CP210x` (VID 0x10C4).
    Cp210x,
    /// FTDI FT232/FT231X (VID 0x0403).
    Ftdi,
}

impl BridgeChip {
    /// The bridge chip a USB vendor id belongs to, if any.
    #[must_use]
    pub fn from_vid(vid: u16) -> Option<Self> {
        match vid {
            0x1a86 => Some(Self::Ch340),
            0x10c4 => Some(Self::Cp210x),
            0x0403 => Some(Self::Ftdi),
            _ => None,
        }
    }

    /// Human-readable chip name, for UI text.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Ch340 => "CH340",
            Self::Cp210x => "CP210x",
            Self::Ftdi => "FTDI",
        }
    }
}

/// What a USB VID/PID says about a serial device (see
/// [`BoardConfig::identify_usb`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsbMatch {
    /// An official Arduino VID + PID: the board is positively identified and
    /// may be flashed automatically when it has no Firmata.
    Identified(BoardType),
    /// A generic bridge chip whose PID clones of `board` commonly use. It may be
    /// probed for an existing Firmata, but is flashed only after the user
    /// confirms the board.
    BridgeChip { board: BoardType, chip: BridgeChip },
}

impl UsbMatch {
    /// The board this match names or suggests.
    #[must_use]
    pub fn board(self) -> BoardType {
        match self {
            Self::Identified(board) | Self::BridgeChip { board, .. } => board,
        }
    }

    /// The board to flash without asking — only a positively identified one.
    #[must_use]
    pub fn auto_flash_board(self) -> Option<BoardType> {
        match self {
            Self::Identified(board) => Some(board),
            Self::BridgeChip { .. } => None,
        }
    }
}

/// Build the bootloader driver for a board, given the raw flash image to write.
/// Selects the protocol from the board's [`BoardConfig`].
#[must_use]
pub fn new_driver(board_type: BoardType, flash: Vec<u8>) -> Box<dyn FlashDriver> {
    let config = BoardConfig::find(board_type);
    match config.protocol {
        Protocol::Stk500v1 => Box::new(stk500v1::Stk500v1Driver::new(flash, &config)),
        Protocol::Stk500v2 => Box::new(stk500v2::Stk500v2Driver::new(flash, &config)),
        Protocol::Avr109 => Box::new(avr109::Avr109Driver::new(flash, &config)),
    }
}

#[cfg(test)]
mod tests;
