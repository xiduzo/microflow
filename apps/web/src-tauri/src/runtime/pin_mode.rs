//! Firmata pin mode constants. Re-exported via `crate::runtime::base::pin_mode`
//! for backwards compatibility.

pub const INPUT: u8 = 0;
pub const OUTPUT: u8 = 1;
pub const ANALOG: u8 = 2;
pub const PWM: u8 = 3;
pub const SERVO: u8 = 4;
pub const I2C: u8 = 6;
pub const PULLUP: u8 = 11;
