//! Private `firmata-rs` wrapper held by the **Board IO Loop**.
//!
//! Owns the open serial port plus pin-value cache, active-pin set, and the
//! pin-change / I2C-reply callbacks. Never escapes the loop's thread; mutated
//! exclusively from there.

use firmata_rs::Firmata;
use std::collections::{HashMap, HashSet};
use std::fmt::Debug;
use std::io::{Read, Write};
use std::sync::Arc;

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

/// Wrapper around the firmata-rs Board
pub struct BoardConnection {
    pub board: firmata_rs::Board<SerialPortWrapper>,
    pub port_name: String,
    /// Track previous pin values for change detection
    pin_values: HashMap<u8, u16>,
    /// Callback for pin changes (set by runtime)
    pin_change_callback: Option<Arc<PinChangeCallback>>,
    /// Callback for I2C reply events (set by runtime)
    pub i2c_reply_callback: Option<Arc<I2cReplyCallback>>,
    /// Pins that have listeners registered. Only these are checked in `detect_and_emit_changes`.
    /// Empty means "check all pins" (safe fallback before listeners are registered).
    pub active_pins: HashSet<u8>,
}

impl BoardConnection {
    /// Create a new `BoardConnection` with change tracking
    #[must_use]
    pub fn new(board: firmata_rs::Board<SerialPortWrapper>, port_name: String) -> Self {
        Self {
            board,
            port_name,
            pin_values: HashMap::new(),
            pin_change_callback: None,
            i2c_reply_callback: None,
            active_pins: HashSet::new(),
        }
    }

    /// Set the callback for pin change events
    pub fn set_pin_change_callback(&mut self, callback: Arc<PinChangeCallback>) {
        self.pin_change_callback = Some(callback);
        // Clear cached pin values so fresh comparisons happen
        self.pin_values.clear();
    }

    /// Clear cached pin values and active pin set (useful when flow changes)
    pub fn clear_pin_cache(&mut self) {
        self.pin_values.clear();
        self.active_pins.clear();
    }

    pub fn set_pin_mode(&mut self, pin: u8, mode: u8) -> Result<(), String> {
        self.board
            .set_pin_mode(i32::from(pin), mode)
            .map_err(|e| format!("Failed to set pin mode: {e}"))
    }

    pub fn digital_write(&mut self, pin: u8, value: bool) -> Result<(), String> {
        self.board
            .digital_write(i32::from(pin), i32::from(value))
            .map_err(|e| format!("Failed to digital write: {e}"))
    }

    pub fn analog_write(&mut self, pin: u8, value: u16) -> Result<(), String> {
        self.board
            .analog_write(i32::from(pin), i32::from(value))
            .map_err(|e| format!("Failed to analog write: {e}"))
    }

    /// Shift out a byte MSB-first, toggling `data_pin` and `clock_pin`.
    /// This performs all the digital writes atomically on the reader thread,
    /// matching Arduino's shiftOut(dataPin, clockPin, MSBFIRST, value).
    pub fn shift_out(&mut self, data_pin: u8, clock_pin: u8, value: u8) -> Result<(), String> {
        for i in 0..8 {
            // Match J5 board.shiftOut exactly: CLK low → set data → CLK high
            self.board
                .digital_write(i32::from(clock_pin), 0)
                .map_err(|e| format!("Failed to clock low: {e}"))?;
            let bit = i32::from((value >> (7 - i)) & 1);
            self.board
                .digital_write(i32::from(data_pin), bit)
                .map_err(|e| format!("Failed to shift data: {e}"))?;
            self.board
                .digital_write(i32::from(clock_pin), 1)
                .map_err(|e| format!("Failed to clock high: {e}"))?;
        }
        Ok(())
    }

    /// Play a tone by toggling a digital pin at the given half-period.
    /// Runs directly on the reader thread for tight timing — mirrors J5's
    /// DEFAULT controller approach (OUTPUT mode + digitalWrite toggling).
    pub fn tone(&mut self, pin: u8, half_period_us: u32, duration_ms: u32, cancel: &std::sync::atomic::AtomicBool) -> Result<(), String> {
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
    pub fn no_tone(&mut self, pin: u8) -> Result<(), String> {
        self.board
            .digital_write(i32::from(pin), 0)
            .map_err(|e| format!("Failed to stop tone: {e}"))
    }

    /// Send a raw sysex message: `START_SYSEX` (0xF0) + command + data + `END_SYSEX` (0xF7).
    /// Data bytes must already be 7-bit encoded per the Firmata protocol.
    pub fn sysex_write(&mut self, command: u8, data: &[u8]) -> Result<(), String> {
        let mut buf = Vec::with_capacity(data.len() + 3);
        buf.push(0xF0); // START_SYSEX
        buf.push(command);
        buf.extend_from_slice(data);
        buf.push(0xF7); // END_SYSEX
        self.board
            .connection
            .write_all(&buf)
            .map_err(|e| format!("Failed to write sysex: {e}"))?;
        self.board
            .connection
            .flush()
            .map_err(|e| format!("Failed to flush sysex: {e}"))
    }

    pub fn digital_read(&mut self, pin: u8) -> Result<bool, String> {
        let port = pin / 8;
        self.board
            .report_digital(i32::from(port), 1)
            .map_err(|e| format!("Failed to enable digital reporting: {e}"))?;
        self.board
            .read_and_decode()
            .map_err(|e| format!("Failed to read: {e}"))?;
        let pins = self.board.pins();
        pins.get(pin as usize)
            .map(|p| p.value > 0)
            .ok_or_else(|| format!("Pin {pin} not found"))
    }

    /// Read analog value from a pin
    /// `pin` is the digital pin number (e.g., 14 for A0 on Arduino Uno)
    ///
    /// Note: This assumes `report_analog` has already been enabled for this pin
    /// and `read_and_decode` has been called to update pin values.
    /// For best performance, call `read_and_decode()` once per poll cycle,
    /// then read pin values directly.
    pub fn analog_read(&mut self, pin: u8) -> Result<u16, String> {
        let pins = self.board.pins();

        pins.get(pin as usize)
            .map(|p| p.value as u16)
            .ok_or_else(|| format!("Analog pin {pin} not found"))
    }

    /// Enable analog reporting for a pin
    /// Call this once during initialization, not on every read
    pub fn enable_analog_reporting(&mut self, pin: u8) -> Result<(), String> {
        let pins = self.board.pins();

        // Verify this pin supports analog
        let pin_info = pins
            .get(pin as usize)
            .ok_or_else(|| format!("Pin {pin} not found"))?;

        if !pin_info.analog {
            return Err(format!("Pin {pin} is not an analog pin"));
        }

        // Find the analog channel index (0-based) by counting analog pins before this one
        let analog_channel = pins
            .iter()
            .take(pin as usize)
            .filter(|p| p.analog)
            .count() as i32;

        log::info!("Enabling analog reporting: pin={pin}, analog_channel={analog_channel}");

        self.board
            .report_analog(analog_channel, 1)
            .map_err(|e| format!("Failed to enable analog reporting: {e}"))
    }

    /// Process all pending messages from the board and emit change events
    /// Note: With the dedicated reader thread, this is mainly used as a fallback
    pub fn read_all(&mut self) -> Result<(), String> {
        // Just do a single read - the reader thread handles continuous reading
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
                    Err(format!("Read error: {e}"))
                }
            }
        }
    }

    /// Detect pin value changes and emit events immediately.
    /// Only scans `active_pins` when registered; falls back to all pins if none registered yet.
    pub(super) fn detect_and_emit_changes(&mut self) {
        if self.pin_change_callback.is_none() {
            return;
        }

        let pins = self.board.pins();
        let mut changes = Vec::new();

        // Fast path: only check pins with listeners.
        // Falls back to all pins only if no active pins registered yet.
        let indices: Box<dyn Iterator<Item = usize>> = if self.active_pins.is_empty() {
            Box::new(0..pins.len())
        } else {
            Box::new(self.active_pins.iter().map(|&p| p as usize))
        };

        for index in indices {
            let Some(pin) = pins.get(index) else { continue };
            let pin_num = index as u8;
            let current_value = pin.value as u16;
            let is_analog = pin.analog;

            let last_value = self.pin_values.get(&pin_num).copied();
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

        if let Some(callback) = &self.pin_change_callback {
            for change in changes {
                callback(change);
            }
        }
    }

    /// Drain any pending I2C replies and emit them via the callback.
    pub(super) fn drain_i2c_replies(&mut self) {
        if self.i2c_reply_callback.is_none() {
            // Still drain to prevent unbounded growth
            self.board.i2c_data().clear();
            return;
        }

        let replies: Vec<_> = self.board.i2c_data().drain(..).collect();
        if let Some(callback) = &self.i2c_reply_callback {
            for reply in replies {
                callback(I2cReplyEvent {
                    address: reply.address as u8,
                    register: reply.register as u8,
                    data: reply.data,
                });
            }
        }
    }

    pub fn set_reporting(&mut self, pin: u8, enabled: bool) -> Result<(), String> {
        let port = pin / 8;
        self.board
            .report_digital(i32::from(port), i32::from(enabled))
            .map_err(|e| format!("Failed to set reporting: {e}"))
    }

    /// Disable analog reporting for a pin
    /// Call this during component cleanup to stop receiving updates
    pub fn disable_analog_reporting(&mut self, pin: u8) -> Result<(), String> {
        let pins = self.board.pins();

        // Verify this pin exists and is analog
        let pin_info = pins
            .get(pin as usize)
            .ok_or_else(|| format!("Pin {pin} not found"))?;

        if !pin_info.analog {
            // Not an analog pin, nothing to disable
            return Ok(());
        }

        // Find the analog channel index (0-based) by counting analog pins before this one
        let analog_channel = pins
            .iter()
            .take(pin as usize)
            .filter(|p| p.analog)
            .count() as i32;

        log::info!("Disabling analog reporting: pin={pin}, analog_channel={analog_channel}");

        // Remove from our cache
        self.pin_values.remove(&pin);

        self.board
            .report_analog(analog_channel, 0)
            .map_err(|e| format!("Failed to disable analog reporting: {e}"))
    }

    /// Disable digital reporting for a pin's port
    /// Note: This disables reporting for the entire port (8 pins)
    pub fn disable_digital_reporting(&mut self, pin: u8) -> Result<(), String> {
        let port = pin / 8;

        log::info!("Disabling digital reporting: pin={pin}, port={port}");

        // Remove from our cache
        self.pin_values.remove(&pin);

        self.board
            .report_digital(i32::from(port), 0)
            .map_err(|e| format!("Failed to disable digital reporting: {e}"))
    }

    /// Disable all reporting and clear state. Called inside the reader thread — no sleep needed.
    pub fn reset_all_reporting(&mut self) -> Result<(), String> {
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
