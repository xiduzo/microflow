//! Internal protocol between **`BoardHandle`** and the **Board IO Loop**.
//!
//! The reader thread owns `BoardConnection` exclusively and dispatches these
//! between Firmata reads. Reader-thread state (callbacks, pin caches) lives on
//! shared `Arc`s held by both `BoardHandle` and `BoardConnection`, so it does
//! not flow through the channel.

/// Commands sent to the reader thread for board operations.
pub enum BoardCommand {
    SetPinMode { pin: u8, mode: u8 },
    DigitalWrite { pin: u8, value: bool },
    AnalogWrite { pin: u8, value: u16 },
    EnableAnalogReporting { pin: u8 },
    DisableAnalogReporting { pin: u8 },
    EnableDigitalReporting { pin: u8 },
    DisableDigitalReporting { pin: u8 },
    ResetAllReporting,
    /// Shift out a byte MSB-first on `data_pin`, clocking `clock_pin`.
    /// Equivalent to Arduino's shiftOut(dataPin, clockPin, MSBFIRST, value).
    /// Performed atomically on the reader thread for correct timing.
    ShiftOut { data_pin: u8, clock_pin: u8, value: u8 },
    /// Play a tone by toggling a pin at the given half-period (µs) for duration (ms).
    /// Executed directly on the reader thread for tight timing (no channel overhead).
    Tone { pin: u8, half_period_us: u32, duration_ms: u32 },
    /// Stop tone and drive pin low.
    NoTone { pin: u8 },
    /// Send a raw sysex message (`START_SYSEX` + command + data + `END_SYSEX`).
    Sysex { command: u8, data: Vec<u8> },
    /// Configure the I2C bus delay (microseconds). Must be sent before any I2C operations.
    I2cConfig { delay: i32 },
    /// Read `size` bytes from I2C device at `address`. Uses read-once mode.
    I2cRead { address: i32, size: i32 },
    /// Write `data` bytes to I2C device at `address`.
    I2cWrite { address: i32, data: Vec<u8> },
    /// Stop continuous I2C reading for `address`.
    I2cStopReading { address: i32 },
    Stop,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digital_write_round_trips() {
        let cmd = BoardCommand::DigitalWrite { pin: 13, value: true };
        match cmd {
            BoardCommand::DigitalWrite { pin, value } => {
                assert_eq!(pin, 13);
                assert!(value);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn reset_all_reporting_is_unit() {
        let cmd = BoardCommand::ResetAllReporting;
        assert!(matches!(cmd, BoardCommand::ResetAllReporting));
    }

    #[test]
    fn stop_is_unit() {
        let cmd = BoardCommand::Stop;
        assert!(matches!(cmd, BoardCommand::Stop));
    }
}
