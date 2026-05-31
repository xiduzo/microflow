//! Firmata pin mode constants, shared by the runtime board writer and the
//! hardware component nodes.

pub const INPUT: u8 = 0;
pub const OUTPUT: u8 = 1;
pub const ANALOG: u8 = 2;
pub const PWM: u8 = 3;
pub const SERVO: u8 = 4;
pub const I2C: u8 = 6;
pub const PULLUP: u8 = 11;
