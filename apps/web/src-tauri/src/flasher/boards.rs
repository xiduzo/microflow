//! Board configurations and detection

use super::protocols::Protocol;
use super::types::BoardType;

/// Board configuration
#[derive(Debug, Clone)]
pub struct BoardConfig {
    #[allow(dead_code)]
    pub board_type: BoardType,
    pub baud_rate: u32,
    pub signature: Vec<u8>,
    pub page_size: usize,
    pub timeout: u32,
    pub protocol: Protocol,
}

/// USB Product IDs for board detection (lowercase hex without 0x prefix)
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
    /// Get configuration for a specific board type
    pub fn find(board_type: BoardType) -> Option<Self> {
        Some(match board_type {
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
        })
    }

    /// Detect board type from USB product ID
    /// Returns the most likely board type based on PID
    pub fn detect_from_pid(pid: u16) -> Option<BoardType> {
        let pid_str = format!("{:04x}", pid);

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

    /// Detect board type from USB VID and PID combination
    pub fn detect_from_usb(vid: u16, pid: u16) -> Option<BoardType> {
        let pid_str = format!("{:04x}", pid);

        // CH340 chips (VID 0x1A86) are typically used on Nano clones
        // FTDI chips (VID 0x0403) can be Nano or Uno clones
        let is_ch340 = vid == 0x1a86;
        let is_ftdi = vid == 0x0403;

        // Arduino official VID
        let is_arduino = vid == 0x2341 || vid == 0x2a03;

        // For shared PIDs like 7523, use VID to disambiguate
        if pid_str == "7523" {
            if is_ch340 {
                // CH340 with 7523 is almost always a Nano clone
                log::info!("CH340 chip detected with PID 7523 - assuming Nano (old bootloader)");
                return Some(BoardType::Nano);
            }
            if is_ftdi {
                // FTDI 7523 could be Nano - try Nano first
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
