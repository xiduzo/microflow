//! Internal protocol between **`BoardHandle`** and the **Board IO Loop**.
//!
//! The reader thread owns `BoardConnection` exclusively and dispatches these
//! between Firmata reads. Reader-thread state (callbacks, pin caches) lives on
//! shared `Arc`s held by both `BoardHandle` and `BoardConnection`, so it does
//! not flow through the channel.
//!
//! Every wire-op variant carries a `reply: oneshot::Sender<Result<(), HardwareError>>`
//! that the IO loop fills after running the underlying connection method. The
//! `BoardHandle` typed methods return a `CommandReceipt` wrapping the matching
//! `Receiver`. See `receipt.rs` for consumer semantics.

use crate::error::HardwareError;
use tokio::sync::oneshot;

/// Outcome channel paired with every wire-op `BoardCommand`.
pub(super) type ReplyTx = oneshot::Sender<Result<(), HardwareError>>;

/// Commands sent to the reader thread for board operations.
pub enum BoardCommand {
    SetPinMode { pin: u8, mode: u8, reply: ReplyTx },
    DigitalWrite { pin: u8, value: bool, reply: ReplyTx },
    AnalogWrite { pin: u8, value: u16, reply: ReplyTx },
    EnableAnalogReporting { pin: u8, reply: ReplyTx },
    DisableAnalogReporting { pin: u8, reply: ReplyTx },
    EnableDigitalReporting { pin: u8, reply: ReplyTx },
    DisableDigitalReporting { pin: u8, reply: ReplyTx },
    ResetAllReporting { reply: ReplyTx },
    /// Shift out a byte MSB-first on `data_pin`, clocking `clock_pin`.
    /// Equivalent to Arduino's shiftOut(dataPin, clockPin, MSBFIRST, value).
    /// Performed atomically on the reader thread for correct timing.
    ShiftOut { data_pin: u8, clock_pin: u8, value: u8, reply: ReplyTx },
    /// Play a tone by toggling a pin at the given half-period (µs) for duration (ms).
    /// Executed directly on the reader thread for tight timing (no channel overhead).
    Tone { pin: u8, half_period_us: u32, duration_ms: u32, reply: ReplyTx },
    /// Stop tone and drive pin low.
    NoTone { pin: u8, reply: ReplyTx },
    /// Send a raw sysex message (`START_SYSEX` + command + data + `END_SYSEX`).
    Sysex { command: u8, data: Vec<u8>, reply: ReplyTx },
    /// Configure the I2C bus delay (microseconds). Must be sent before any I2C operations.
    I2cConfig { delay: i32, reply: ReplyTx },
    /// Read `size` bytes from I2C device at `address`. Uses read-once mode.
    I2cRead { address: i32, size: i32, reply: ReplyTx },
    /// Write `data` bytes to I2C device at `address`.
    I2cWrite { address: i32, data: Vec<u8>, reply: ReplyTx },
    /// Stop continuous I2C reading for `address`.
    I2cStopReading { address: i32, reply: ReplyTx },
    /// Shut the IO loop down. No outcome; the reader joins.
    Stop,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digital_write_carries_pin_value_and_reply() {
        let (reply, _rx) = oneshot::channel();
        let cmd = BoardCommand::DigitalWrite { pin: 13, value: true, reply };
        match cmd {
            BoardCommand::DigitalWrite { pin, value, reply: _ } => {
                assert_eq!(pin, 13);
                assert!(value);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn reset_all_reporting_carries_reply_only() {
        let (reply, _rx) = oneshot::channel();
        let cmd = BoardCommand::ResetAllReporting { reply };
        assert!(matches!(cmd, BoardCommand::ResetAllReporting { .. }));
    }

    #[test]
    fn stop_is_unit() {
        let cmd = BoardCommand::Stop;
        assert!(matches!(cmd, BoardCommand::Stop));
    }
}
