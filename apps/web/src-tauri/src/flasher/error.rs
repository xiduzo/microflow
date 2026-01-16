//! Error types for the flasher module

use std::fmt;

/// Errors that can occur during flashing
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

impl fmt::Display for FlashError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PortOpen(msg) => write!(f, "Failed to open port: {}", msg),
            Self::Communication(msg) => write!(f, "Communication error: {}", msg),
            Self::SignatureMismatch { expected, actual } => {
                write!(
                    f,
                    "Signature mismatch: expected {:02X?}, got {:02X?}",
                    expected, actual
                )
            }
            Self::SyncFailed => write!(f, "Failed to sync with bootloader"),
            Self::ProgramFailed(msg) => write!(f, "Programming failed: {}", msg),
            Self::VerifyFailed(msg) => write!(f, "Verification failed: {}", msg),
            Self::InvalidHex(msg) => write!(f, "Invalid hex file: {}", msg),
            Self::UnsupportedBoard(board) => write!(f, "Unsupported board: {}", board),
            Self::UnsupportedProtocol(proto) => write!(f, "Unsupported protocol: {}", proto),
            Self::BoardNotFound(port) => write!(f, "Board not found on {} after reset", port),
            Self::Io(msg) => write!(f, "IO error: {}", msg),
        }
    }
}

impl std::error::Error for FlashError {}

impl From<FlashError> for String {
    fn from(err: FlashError) -> Self {
        err.to_string()
    }
}
