//! Embedded `StandardFirmata` firmware hex files

use super::types::BoardType;

/// Embedded `StandardFirmata` hex files for each board type
pub struct Firmware;

impl Firmware {
    /// `StandardFirmata` for Arduino Uno
    pub const UNO: &'static str = include_str!("./hex/uno/StandardFirmata.ino.hex");
    
    /// `StandardFirmata` for Arduino Nano (same hex as Uno, `ATmega328P`)
    pub const NANO: &'static str = include_str!("./hex/nano/StandardFirmata.ino.hex");
    
    /// `StandardFirmata` for Arduino Mega
    pub const MEGA: &'static str = include_str!("./hex/mega/StandardFirmata.ino.hex");
    
    /// `StandardFirmata` for Arduino Leonardo
    pub const LEONARDO: &'static str = include_str!("./hex/leonardo/StandardFirmata.ino.hex");
    
    /// `StandardFirmata` for Arduino Micro
    pub const MICRO: &'static str = include_str!("./hex/micro/StandardFirmata.ino.hex");

    /// Get the `StandardFirmata` hex content for a board type
    pub fn get_firmata_hex(board_type: BoardType) -> &'static str {
        match board_type {
            BoardType::Uno => Self::UNO,
            BoardType::Nano | BoardType::NanoNew => Self::NANO,
            BoardType::Mega => Self::MEGA,
            BoardType::Leonardo => Self::LEONARDO,
            BoardType::Micro => Self::MICRO,
        }
    }
}
