//! Private `firmata-rs` wrapper held by the **Board IO Loop**.
//!
//! Owns the open serial port and forwards Firmata reads into the shared
//! pin-value cache, active-pin set, and callback slots that **`BoardHandle`**
//! also clones — so `ClearPinCache`, `RegisterActivePin`,
//! `SetPinChangeCallback`, and `SetI2cReplyCallback` no longer flow through
//! the command channel.

use crate::error::HardwareError;
use dashmap::DashMap;
use firmata_rs::Firmata;
use std::fmt::Debug;
use std::io::{Read, Write};
use std::sync::{Arc, RwLock};

/// Wrap a Firmata-side failure into `HardwareError::FirmataCommunication`
/// with a contextual prefix.
fn fw_err(ctx: &str, e: impl std::fmt::Display) -> HardwareError {
    HardwareError::FirmataCommunication(format!("{ctx}: {e}"))
}

/// Serial port wrapper for firmata-rs
pub struct SerialPortWrapper {
    port: Box<dyn serialport::SerialPort>,
}

impl SerialPortWrapper {
    #[must_use]
    pub fn new(port: Box<dyn serialport::SerialPort>) -> Self {
        Self { port }
    }
}

impl Read for SerialPortWrapper {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.port.read(buf)
    }
}

impl Write for SerialPortWrapper {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.port.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.port.flush()
    }
}

impl Debug for SerialPortWrapper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SerialPortWrapper")
            .field("port", &self.port.name())
            .finish()
    }
}

/// Pin change event emitted when a pin value changes
#[derive(Debug, Clone)]
pub struct PinChangeEvent {
    pub pin: u8,
    pub value: u16,
    pub is_analog: bool,
}

/// I2C reply event emitted when an I2C device responds
#[derive(Debug, Clone)]
pub struct I2cReplyEvent {
    pub address: u8,
    pub register: u8,
    pub data: Vec<u8>,
}

/// Callback type for pin change events
pub type PinChangeCallback = Box<dyn Fn(PinChangeEvent) + Send + Sync>;

/// Callback type for I2C reply events
pub type I2cReplyCallback = Box<dyn Fn(I2cReplyEvent) + Send + Sync>;

/// Slot holding the optional pin-change callback. Read by the IO loop on every
/// pin-change emission; written by `BoardHandle::set_pin_change_callback`.
pub(super) type PinChangeCallbackSlot = Arc<RwLock<Option<Arc<PinChangeCallback>>>>;

/// Slot holding the optional I2C reply callback.
pub(super) type I2cReplyCallbackSlot = Arc<RwLock<Option<Arc<I2cReplyCallback>>>>;

/// Wrapper around the firmata-rs Board
pub struct BoardConnection {
    pub board: firmata_rs::Board<SerialPortWrapper>,
    pub port_name: String,
    /// Track previous pin values for change detection. Shared with `BoardHandle`.
    pin_values: Arc<DashMap<u8, u16>>,
    /// Pins that have listeners registered. Only these are checked in
    /// `detect_and_emit_changes`. Shared with `BoardHandle`. Empty means
    /// "check all pins" (safe fallback before listeners are registered).
    active_pins: Arc<DashMap<u8, ()>>,
    /// Callback for pin changes. Shared with `BoardHandle`.
    pin_change_cb: PinChangeCallbackSlot,
    /// Callback for I2C reply events. Shared with `BoardHandle`.
    i2c_reply_cb: I2cReplyCallbackSlot,
}

impl BoardConnection {
    /// Construct a connection bound to a `BoardHandle`'s shared state.
    /// Only callable from within the `board` module — `BoardHandle::connect_board`
    /// is the public entry point.
    pub(super) fn new(
        board: firmata_rs::Board<SerialPortWrapper>,
        port_name: String,
        pin_values: Arc<DashMap<u8, u16>>,
        active_pins: Arc<DashMap<u8, ()>>,
        pin_change_cb: PinChangeCallbackSlot,
        i2c_reply_cb: I2cReplyCallbackSlot,
    ) -> Self {
        Self {
            board,
            port_name,
            pin_values,
            active_pins,
            pin_change_cb,
            i2c_reply_cb,
        }
    }

    pub fn set_pin_mode(&mut self, pin: u8, mode: u8) -> Result<(), HardwareError> {
        self.board
            .set_pin_mode(i32::from(pin), mode)
            .map_err(|e| fw_err("Failed to set pin mode", e))
    }

    pub fn digital_write(&mut self, pin: u8, value: bool) -> Result<(), HardwareError> {
        self.board
            .digital_write(i32::from(pin), i32::from(value))
            .map_err(|e| fw_err("Failed to digital write", e))
    }

    pub fn analog_write(&mut self, pin: u8, value: u16) -> Result<(), HardwareError> {
        self.board
            .analog_write(i32::from(pin), i32::from(value))
            .map_err(|e| fw_err("Failed to analog write", e))
    }

    /// Shift out a byte MSB-first, toggling `data_pin` and `clock_pin`.
    /// This performs all the digital writes atomically on the reader thread,
    /// matching Arduino's shiftOut(dataPin, clockPin, MSBFIRST, value).
    pub fn shift_out(&mut self, data_pin: u8, clock_pin: u8, value: u8) -> Result<(), HardwareError> {
        for i in 0..8 {
            // Match J5 board.shiftOut exactly: CLK low → set data → CLK high
            self.board
                .digital_write(i32::from(clock_pin), 0)
                .map_err(|e| fw_err("Failed to clock low", e))?;
            let bit = i32::from((value >> (7 - i)) & 1);
            self.board
                .digital_write(i32::from(data_pin), bit)
                .map_err(|e| fw_err("Failed to shift data", e))?;
            self.board
                .digital_write(i32::from(clock_pin), 1)
                .map_err(|e| fw_err("Failed to clock high", e))?;
        }
        Ok(())
    }

    /// Play a tone by toggling a digital pin at the given half-period.
    /// Runs directly on the reader thread for tight timing — mirrors J5's
    /// DEFAULT controller approach (OUTPUT mode + digitalWrite toggling).
    pub fn tone(&mut self, pin: u8, half_period_us: u32, duration_ms: u32, cancel: &std::sync::atomic::AtomicBool) -> Result<(), HardwareError> {
        let half_period = std::time::Duration::from_micros(u64::from(half_period_us));
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(u64::from(duration_ms));
        let mut value = 1;

        while std::time::Instant::now() < deadline {
            if cancel.load(std::sync::atomic::Ordering::Acquire) {
                break;
            }
            let _ = self.board.digital_write(i32::from(pin), value);
            value = i32::from(value != 1);
            // Spin-sleep for accurate sub-millisecond timing
            let target = std::time::Instant::now() + half_period;
            if half_period > std::time::Duration::from_millis(1) {
                std::thread::sleep(half_period.checked_sub(std::time::Duration::from_micros(500)).unwrap());
            }
            while std::time::Instant::now() < target {
                if cancel.load(std::sync::atomic::Ordering::Acquire) {
                    break;
                }
                std::hint::spin_loop();
            }
        }

        // Ensure pin is low when done
        let _ = self.board.digital_write(i32::from(pin), 0);
        Ok(())
    }

    /// Stop tone — drive pin low.
    pub fn no_tone(&mut self, pin: u8) -> Result<(), HardwareError> {
        self.board
            .digital_write(i32::from(pin), 0)
            .map_err(|e| fw_err("Failed to stop tone", e))
    }

    /// Send a raw sysex message: `START_SYSEX` (0xF0) + command + data + `END_SYSEX` (0xF7).
    /// Data bytes must already be 7-bit encoded per the Firmata protocol.
    pub fn sysex_write(&mut self, command: u8, data: &[u8]) -> Result<(), HardwareError> {
        let mut buf = Vec::with_capacity(data.len() + 3);
        buf.push(0xF0); // START_SYSEX
        buf.push(command);
        buf.extend_from_slice(data);
        buf.push(0xF7); // END_SYSEX
        self.board
            .connection
            .write_all(&buf)
            .map_err(|e| fw_err("Failed to write sysex", e))?;
        self.board
            .connection
            .flush()
            .map_err(|e| fw_err("Failed to flush sysex", e))
    }

    pub fn digital_read(&mut self, pin: u8) -> Result<bool, HardwareError> {
        let port = pin / 8;
        self.board
            .report_digital(i32::from(port), 1)
            .map_err(|e| fw_err("Failed to enable digital reporting", e))?;
        self.board
            .read_and_decode()
            .map_err(|e| fw_err("Failed to read", e))?;
        let pins = self.board.pins();
        pins.get(pin as usize)
            .map(|p| p.value > 0)
            .ok_or_else(|| fw_err("Pin not found", pin))
    }

    /// Read analog value from a pin
    /// `pin` is the digital pin number (e.g., 14 for A0 on Arduino Uno)
    ///
    /// Note: This assumes `report_analog` has already been enabled for this pin
    /// and `read_and_decode` has been called to update pin values.
    pub fn analog_read(&mut self, pin: u8) -> Result<u16, HardwareError> {
        let pins = self.board.pins();

        pins.get(pin as usize)
            .map(|p| p.value as u16)
            .ok_or_else(|| fw_err("Analog pin not found", pin))
    }

    /// Enable analog reporting for a pin
    /// Call this once during initialization, not on every read
    pub fn enable_analog_reporting(&mut self, pin: u8) -> Result<(), HardwareError> {
        let pins = self.board.pins();

        let pin_info = pins
            .get(pin as usize)
            .ok_or_else(|| fw_err("Pin not found", pin))?;

        if !pin_info.analog {
            return Err(HardwareError::UnsupportedPinMode {
                pin,
                mode: crate::runtime::pin_mode::ANALOG,
            });
        }

        let analog_channel = pins
            .iter()
            .take(pin as usize)
            .filter(|p| p.analog)
            .count() as i32;

        log::info!("Enabling analog reporting: pin={pin}, analog_channel={analog_channel}");

        self.board
            .report_analog(analog_channel, 1)
            .map_err(|e| fw_err("Failed to enable analog reporting", e))
    }

    /// Process all pending messages from the board and emit change events
    /// Note: With the dedicated reader thread, this is mainly used as a fallback
    pub fn read_all(&mut self) -> Result<(), HardwareError> {
        match self.board.read_and_decode() {
            Ok(_) => {
                self.detect_and_emit_changes();
                Ok(())
            }
            Err(e) => {
                let err_str = format!("{e}");
                if err_str.contains("timed out") || err_str.contains("timeout") {
                    Ok(())
                } else {
                    Err(fw_err("Read error", e))
                }
            }
        }
    }

    /// Detect pin value changes and emit events immediately.
    /// Only scans `active_pins` when registered; falls back to all pins if none registered yet.
    pub(super) fn detect_and_emit_changes(&mut self) {
        let cb_guard = self
            .pin_change_cb
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(callback) = cb_guard.as_ref().cloned() else {
            return;
        };
        drop(cb_guard);

        let pins = self.board.pins();
        let mut changes = Vec::new();

        // Fast path: only check pins with listeners.
        // Falls back to all pins only if no active pins registered yet.
        let scan_all = self.active_pins.is_empty();
        let indices: Vec<usize> = if scan_all {
            (0..pins.len()).collect()
        } else {
            self.active_pins.iter().map(|e| *e.key() as usize).collect()
        };

        for index in indices {
            let Some(pin) = pins.get(index) else { continue };
            let pin_num = index as u8;
            let current_value = pin.value as u16;
            let is_analog = pin.analog;

            let last_value = self.pin_values.get(&pin_num).map(|v| *v);
            if last_value == Some(current_value) {
                continue;
            }

            let should_emit = if is_analog {
                match last_value {
                    Some(last) => (i32::from(current_value) - i32::from(last)).unsigned_abs() as u16 >= 1,
                    None => true,
                }
            } else {
                true
            };

            if should_emit {
                self.pin_values.insert(pin_num, current_value);
                changes.push(PinChangeEvent { pin: pin_num, value: current_value, is_analog });
            }
        }

        for change in changes {
            callback(change);
        }
    }

    /// Drain any pending I2C replies and emit them via the callback.
    pub(super) fn drain_i2c_replies(&mut self) {
        let cb_guard = self
            .i2c_reply_cb
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(callback) = cb_guard.as_ref().cloned() else {
            // Still drain to prevent unbounded growth
            self.board.i2c_data().clear();
            return;
        };
        drop(cb_guard);

        let replies: Vec<_> = self.board.i2c_data().drain(..).collect();
        for reply in replies {
            callback(I2cReplyEvent {
                address: reply.address as u8,
                register: reply.register as u8,
                data: reply.data,
            });
        }
    }

    pub fn set_reporting(&mut self, pin: u8, enabled: bool) -> Result<(), HardwareError> {
        let port = pin / 8;
        self.board
            .report_digital(i32::from(port), i32::from(enabled))
            .map_err(|e| fw_err("Failed to set reporting", e))
    }

    /// Disable analog reporting for a pin.
    /// Call this during component cleanup to stop receiving updates.
    pub fn disable_analog_reporting(&mut self, pin: u8) -> Result<(), HardwareError> {
        let pins = self.board.pins();

        let pin_info = pins
            .get(pin as usize)
            .ok_or_else(|| fw_err("Pin not found", pin))?;

        if !pin_info.analog {
            return Ok(());
        }

        let analog_channel = pins
            .iter()
            .take(pin as usize)
            .filter(|p| p.analog)
            .count() as i32;

        log::info!("Disabling analog reporting: pin={pin}, analog_channel={analog_channel}");

        self.pin_values.remove(&pin);

        self.board
            .report_analog(analog_channel, 0)
            .map_err(|e| fw_err("Failed to disable analog reporting", e))
    }

    /// Disable digital reporting for a pin's port.
    /// Note: This disables reporting for the entire port (8 pins).
    pub fn disable_digital_reporting(&mut self, pin: u8) -> Result<(), HardwareError> {
        let port = pin / 8;

        log::info!("Disabling digital reporting: pin={pin}, port={port}");

        self.pin_values.remove(&pin);

        self.board
            .report_digital(i32::from(port), 0)
            .map_err(|e| fw_err("Failed to disable digital reporting", e))
    }

    /// Disable all reporting and clear state. Called inside the reader thread — no sleep needed.
    pub fn reset_all_reporting(&mut self) -> Result<(), HardwareError> {
        log::info!("Resetting all pin reporting");
        self.pin_values.clear();
        for channel in 0..16 {
            let _ = self.board.report_analog(channel, 0);
        }
        for port in 0..13 {
            let _ = self.board.report_digital(port, 0);
        }
        Ok(())
    }
}
