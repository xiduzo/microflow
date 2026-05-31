//! Embedded `StandardFirmata` firmware images, shared by the desktop flasher
//! and the browser (via wasm). Each is the compiled `.hex` for that board's
//! MCU; the flasher parses it with [`super::hex::parse`] and programs the bytes.

use super::BoardType;

/// `StandardFirmata` for the Arduino Uno (`ATmega328P`).
pub const UNO: &str = include_str!("firmware/uno.hex");
/// `StandardFirmata` for the Arduino Nano (same `ATmega328P` image as the Uno).
pub const NANO: &str = include_str!("firmware/nano.hex");
/// `StandardFirmata` for the Arduino Mega (`ATmega2560`).
pub const MEGA: &str = include_str!("firmware/mega.hex");
/// `StandardFirmata` for the Arduino Leonardo (`ATmega32U4`).
pub const LEONARDO: &str = include_str!("firmware/leonardo.hex");
/// `StandardFirmata` for the Arduino Micro (`ATmega32U4`).
pub const MICRO: &str = include_str!("firmware/micro.hex");

/// The `StandardFirmata` hex content for a board type.
#[must_use]
pub fn standard_firmata_hex(board_type: BoardType) -> &'static str {
    match board_type {
        BoardType::Uno => UNO,
        BoardType::Nano | BoardType::NanoNew => NANO,
        BoardType::Mega => MEGA,
        BoardType::Leonardo => LEONARDO,
        BoardType::Micro => MICRO,
    }
}
