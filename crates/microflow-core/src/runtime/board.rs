//! Sans-IO board writer.
//!
//! The desktop runtime's hardware nodes called typed methods on an
//! `Arc<BoardHandle>` that enqueued `BoardCommand`s for the IO loop to encode +
//! write. Here the same typed surface ([`BoardWriter`]) encodes Firmata bytes
//! straight into a buffer via the shared [`FirmataClient`] codec; the host
//! drains the buffer to the wire when it applies `Effects`. One-to-one with the
//! desktop `BoardConnection` encode bodies, minus all I/O.

use crate::firmata::FirmataClient;
use crate::runtime::error::{HardwareError, RuntimeError};
use crate::runtime::pin_mode;

/// Typed Firmata write surface used by hardware component nodes. Every method
/// encodes one (or a few) Firmata message(s); nothing blocks or does I/O.
pub trait BoardWriter {
    fn set_pin_mode(&mut self, pin: u8, mode: u8) -> Result<(), RuntimeError>;
    fn digital_write(&mut self, pin: u8, value: bool) -> Result<(), RuntimeError>;
    fn analog_write(&mut self, pin: u8, value: u16) -> Result<(), RuntimeError>;
    fn enable_analog_reporting(&mut self, pin: u8) -> Result<(), RuntimeError>;
    fn disable_analog_reporting(&mut self, pin: u8) -> Result<(), RuntimeError>;
    fn enable_digital_reporting(&mut self, pin: u8) -> Result<(), RuntimeError>;
    fn disable_digital_reporting(&mut self, pin: u8) -> Result<(), RuntimeError>;
    fn reset_all_reporting(&mut self) -> Result<(), RuntimeError>;
    fn shift_out(&mut self, data_pin: u8, clock_pin: u8, value: u8) -> Result<(), RuntimeError>;
    fn tone(&mut self, pin: u8, half_period_us: u32, duration_ms: u32) -> Result<(), RuntimeError>;
    fn no_tone(&mut self, pin: u8) -> Result<(), RuntimeError>;
    fn sysex(&mut self, command: u8, data: &[u8]) -> Result<(), RuntimeError>;
    fn i2c_config(&mut self, delay: i32) -> Result<(), RuntimeError>;
    fn i2c_read(&mut self, address: i32, size: i32) -> Result<(), RuntimeError>;
    fn i2c_read_continuous(
        &mut self,
        address: i32,
        register: i32,
        size: i32,
    ) -> Result<(), RuntimeError>;
    fn i2c_write(&mut self, address: i32, data: &[u8]) -> Result<(), RuntimeError>;
    fn i2c_stop_reading(&mut self, address: i32) -> Result<(), RuntimeError>;
    fn sampling_interval(&mut self, interval_ms: i32) -> Result<(), RuntimeError>;
}

/// [`BoardWriter`] that encodes into a byte buffer via a borrowed
/// [`FirmataClient`]. Built fresh per turn by the runtime, borrowing the
/// runtime's codec (for the pin table) and the turn's outbound buffer.
pub struct BufferBoardWriter<'a> {
    client: &'a mut FirmataClient,
    out: &'a mut Vec<u8>,
}

impl<'a> BufferBoardWriter<'a> {
    pub fn new(client: &'a mut FirmataClient, out: &'a mut Vec<u8>) -> Self {
        Self { client, out }
    }

    /// Count of analog pins strictly before `pin` — the Firmata analog channel
    /// number, matching the desktop `BoardConnection::analog_channel_for`.
    fn analog_channel_for(&self, pin: u8) -> u8 {
        self.client
            .pins
            .iter()
            .take(pin as usize)
            .filter(|p| p.analog)
            .count() as u8
    }
}

impl BoardWriter for BufferBoardWriter<'_> {
    fn set_pin_mode(&mut self, pin: u8, mode: u8) -> Result<(), RuntimeError> {
        self.out.extend_from_slice(&self.client.encode_set_pin_mode(pin, mode));
        Ok(())
    }

    fn digital_write(&mut self, pin: u8, value: bool) -> Result<(), RuntimeError> {
        self.out.extend_from_slice(&self.client.encode_digital_write(pin, value));
        Ok(())
    }

    fn analog_write(&mut self, pin: u8, value: u16) -> Result<(), RuntimeError> {
        self.out.extend_from_slice(&self.client.encode_analog_write(pin, value));
        Ok(())
    }

    fn enable_analog_reporting(&mut self, pin: u8) -> Result<(), RuntimeError> {
        let is_analog = self
            .client
            .pins
            .get(pin as usize)
            .ok_or_else(|| HardwareError::FirmataCommunication(format!("Pin not found: {pin}")))?
            .analog;
        if !is_analog {
            return Err(HardwareError::UnsupportedPinMode { pin, mode: pin_mode::ANALOG }.into());
        }
        let channel = self.analog_channel_for(pin);
        self.out.extend_from_slice(&self.client.encode_report_analog(channel, true));
        Ok(())
    }

    fn disable_analog_reporting(&mut self, pin: u8) -> Result<(), RuntimeError> {
        let is_analog = self
            .client
            .pins
            .get(pin as usize)
            .ok_or_else(|| HardwareError::FirmataCommunication(format!("Pin not found: {pin}")))?
            .analog;
        if !is_analog {
            return Ok(());
        }
        let channel = self.analog_channel_for(pin);
        self.out.extend_from_slice(&self.client.encode_report_analog(channel, false));
        Ok(())
    }

    fn enable_digital_reporting(&mut self, pin: u8) -> Result<(), RuntimeError> {
        let port = pin / 8;
        self.out.extend_from_slice(&self.client.encode_report_digital(port, true));
        Ok(())
    }

    fn disable_digital_reporting(&mut self, pin: u8) -> Result<(), RuntimeError> {
        let port = pin / 8;
        self.out.extend_from_slice(&self.client.encode_report_digital(port, false));
        Ok(())
    }

    fn reset_all_reporting(&mut self) -> Result<(), RuntimeError> {
        for channel in 0..16 {
            self.out.extend_from_slice(&self.client.encode_report_analog(channel, false));
        }
        for port in 0..13 {
            self.out.extend_from_slice(&self.client.encode_report_digital(port, false));
        }
        Ok(())
    }

    fn shift_out(&mut self, data_pin: u8, clock_pin: u8, value: u8) -> Result<(), RuntimeError> {
        // MSB-first, matching Arduino shiftOut(MSBFIRST): CLK low → data → CLK high.
        for i in 0..8 {
            self.out.extend_from_slice(&self.client.encode_digital_write(clock_pin, false));
            let bit = (value >> (7 - i)) & 1 != 0;
            self.out.extend_from_slice(&self.client.encode_digital_write(data_pin, bit));
            self.out.extend_from_slice(&self.client.encode_digital_write(clock_pin, true));
        }
        Ok(())
    }

    fn tone(&mut self, pin: u8, _half_period_us: u32, _duration_ms: u32) -> Result<(), RuntimeError> {
        // Sub-millisecond pin toggling (the desktop's spin-loop tone) has no
        // single-threaded / browser equivalent. Phase-1 best effort: drive the
        // pin high; the piezo node's scheduler frames note on/off boundaries at
        // note granularity. Pitch fidelity is intentionally coarse on this path.
        self.out.extend_from_slice(&self.client.encode_digital_write(pin, true));
        Ok(())
    }

    fn no_tone(&mut self, pin: u8) -> Result<(), RuntimeError> {
        self.out.extend_from_slice(&self.client.encode_digital_write(pin, false));
        Ok(())
    }

    fn sysex(&mut self, command: u8, data: &[u8]) -> Result<(), RuntimeError> {
        self.out.extend_from_slice(&self.client.encode_sysex(command, data));
        Ok(())
    }

    fn i2c_config(&mut self, delay: i32) -> Result<(), RuntimeError> {
        self.out.extend_from_slice(&self.client.encode_i2c_config(delay));
        Ok(())
    }

    fn i2c_read(&mut self, address: i32, size: i32) -> Result<(), RuntimeError> {
        self.out.extend_from_slice(&self.client.encode_i2c_read(address, size));
        Ok(())
    }

    fn i2c_read_continuous(
        &mut self,
        address: i32,
        register: i32,
        size: i32,
    ) -> Result<(), RuntimeError> {
        self.out
            .extend_from_slice(&self.client.encode_i2c_read_continuous(address, register, size));
        Ok(())
    }

    fn i2c_write(&mut self, address: i32, data: &[u8]) -> Result<(), RuntimeError> {
        self.out.extend_from_slice(&self.client.encode_i2c_write(address, data));
        Ok(())
    }

    fn i2c_stop_reading(&mut self, address: i32) -> Result<(), RuntimeError> {
        self.out.extend_from_slice(&self.client.encode_i2c_stop_reading(address));
        Ok(())
    }

    fn sampling_interval(&mut self, interval_ms: i32) -> Result<(), RuntimeError> {
        self.out
            .extend_from_slice(&self.client.encode_sampling_interval(interval_ms));
        Ok(())
    }
}
