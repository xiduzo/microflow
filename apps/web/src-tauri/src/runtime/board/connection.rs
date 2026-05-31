//! Private board connection held by the **Board IO Loop**.
//!
//! Owns the open serial port plus a [`microflow_core::firmata::FirmataClient`]
//! (the platform-independent sans-IO protocol codec, shared verbatim with the
//! browser build). The port is the only transport: outgoing ops are encoded by
//! the client and written here; incoming bytes are read here and fed to the
//! client, which updates the cached pin table / I2C buffer.
//!
//! Forwards Firmata reads into the shared pin-value cache, active-pin set, and
//! callback slots that **`BoardHandle`** also clones — so `ClearPinCache`,
//! `RegisterActivePin`, `SetPinChangeCallback`, and `SetI2cReplyCallback` no
//! longer flow through the command channel.

use crate::error::HardwareError;
use dashmap::DashMap;
use microflow_core::firmata::FirmataClient;
use std::io::{Read, Write};
use std::sync::{Arc, RwLock};
use std::time::Instant;

/// Wrap a Firmata-side failure into `HardwareError::FirmataCommunication`
/// with a contextual prefix.
fn fw_err(ctx: &str, e: impl std::fmt::Display) -> HardwareError {
    HardwareError::FirmataCommunication(format!("{ctx}: {e}"))
}

/// Pin change event emitted when a pin value changes
#[derive(Debug, Clone)]
pub struct PinChangeEvent {
    pub pin: u8,
    pub value: u16,
    pub is_analog: bool,
}

/// An I2C reply event emitted when an I2C device responds
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

/// Wrapper around the serial port + sans-IO Firmata client.
pub struct BoardConnection {
    /// Protocol codec — encodes outgoing ops, decodes incoming bytes. No I/O.
    client: FirmataClient,
    /// The open serial transport. The only place bytes cross the wire.
    port: Box<dyn serialport::SerialPort>,
    pub port_name: String,
    /// Track previous pin values for change detection. Shared with `BoardHandle`.
    /// Each entry pairs the observed value with the `Instant` at which the IO
    /// loop captured it; `BoardHandle::pin_snapshot` surfaces both.
    pin_values: Arc<DashMap<u8, (u16, Instant)>>,
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
    /// is the public entry point. `client` carries the pin table / firmware info
    /// gathered during detection; `port` is the already-open transport.
    pub(super) fn new(
        client: FirmataClient,
        port: Box<dyn serialport::SerialPort>,
        port_name: String,
        pin_values: Arc<DashMap<u8, (u16, Instant)>>,
        active_pins: Arc<DashMap<u8, ()>>,
        pin_change_cb: PinChangeCallbackSlot,
        i2c_reply_cb: I2cReplyCallbackSlot,
    ) -> Self {
        Self {
            client,
            port,
            port_name,
            pin_values,
            active_pins,
            pin_change_cb,
            i2c_reply_cb,
        }
    }

    /// Write encoded bytes to the port and flush. The single egress point.
    fn write_bytes(&mut self, bytes: &[u8], ctx: &str) -> Result<(), HardwareError> {
        self.port.write_all(bytes).map_err(|e| fw_err(ctx, e))?;
        self.port.flush().map_err(|e| fw_err(ctx, e))
    }

    /// Read whatever bytes are available and feed them to the codec. Returns
    /// `Ok(true)` if any bytes were read (state may have changed), `Ok(false)`
    /// on a read timeout / no data, and `Err` only on a real I/O failure (port
    /// gone) so the reader loop can tear the connection down.
    pub(super) fn pump(&mut self) -> Result<bool, HardwareError> {
        let mut buf = [0u8; 256];
        match self.port.read(&mut buf) {
            Ok(0) => Ok(false),
            Ok(n) => {
                self.client.feed(&buf[..n]);
                Ok(true)
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                Ok(false)
            }
            Err(e) => Err(fw_err("Read error", e)),
        }
    }

    pub fn set_pin_mode(&mut self, pin: u8, mode: u8) -> Result<(), HardwareError> {
        let bytes = self.client.encode_set_pin_mode(pin, mode);
        self.write_bytes(&bytes, "Failed to set pin mode")
    }

    pub fn digital_write(&mut self, pin: u8, value: bool) -> Result<(), HardwareError> {
        let bytes = self.client.encode_digital_write(pin, value);
        self.write_bytes(&bytes, "Failed to digital write")
    }

    pub fn analog_write(&mut self, pin: u8, value: u16) -> Result<(), HardwareError> {
        let bytes = self.client.encode_analog_write(pin, value);
        self.write_bytes(&bytes, "Failed to analog write")
    }

    /// Shift out a byte MSB-first, toggling `data_pin` and `clock_pin`.
    /// This performs all the digital writes atomically on the reader thread,
    /// matching Arduino's shiftOut(dataPin, clockPin, MSBFIRST, value).
    pub fn shift_out(&mut self, data_pin: u8, clock_pin: u8, value: u8) -> Result<(), HardwareError> {
        for i in 0..8 {
            // Match J5 board.shiftOut exactly: CLK low → set data → CLK high
            let bytes = self.client.encode_digital_write(clock_pin, false);
            self.write_bytes(&bytes, "Failed to clock low")?;
            let bit = (value >> (7 - i)) & 1 != 0;
            let bytes = self.client.encode_digital_write(data_pin, bit);
            self.write_bytes(&bytes, "Failed to shift data")?;
            let bytes = self.client.encode_digital_write(clock_pin, true);
            self.write_bytes(&bytes, "Failed to clock high")?;
        }
        Ok(())
    }

    /// Play a tone by toggling a digital pin at the given half-period.
    /// Runs directly on the reader thread for tight timing — mirrors J5's
    /// DEFAULT controller approach (OUTPUT mode + digitalWrite toggling).
    pub fn tone(&mut self, pin: u8, half_period_us: u32, duration_ms: u32, cancel: &std::sync::atomic::AtomicBool) -> Result<(), HardwareError> {
        let half_period = std::time::Duration::from_micros(u64::from(half_period_us));
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(u64::from(duration_ms));
        let mut value = true;

        while std::time::Instant::now() < deadline {
            if cancel.load(std::sync::atomic::Ordering::Acquire) {
                break;
            }
            let bytes = self.client.encode_digital_write(pin, value);
            let _ = self.write_bytes(&bytes, "tone");
            value = !value;
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
        let bytes = self.client.encode_digital_write(pin, false);
        let _ = self.write_bytes(&bytes, "tone off");
        Ok(())
    }

    /// Stop tone — drive pin low.
    pub fn no_tone(&mut self, pin: u8) -> Result<(), HardwareError> {
        let bytes = self.client.encode_digital_write(pin, false);
        self.write_bytes(&bytes, "Failed to stop tone")
    }

    /// Send a raw sysex message: `START_SYSEX` (0xF0) + command + data + `END_SYSEX` (0xF7).
    /// Data bytes must already be 7-bit encoded per the Firmata protocol.
    pub fn sysex_write(&mut self, command: u8, data: &[u8]) -> Result<(), HardwareError> {
        let bytes = self.client.encode_sysex(command, data);
        self.write_bytes(&bytes, "Failed to write sysex")
    }

    pub fn digital_read(&mut self, pin: u8) -> Result<bool, HardwareError> {
        let port = pin / 8;
        let bytes = self.client.encode_report_digital(port, true);
        self.write_bytes(&bytes, "Failed to enable digital reporting")?;
        self.pump()?;
        self.client
            .pins
            .get(pin as usize)
            .map(|p| p.value > 0)
            .ok_or_else(|| fw_err("Pin not found", pin))
    }

    /// Read analog value from a pin
    /// `pin` is the digital pin number (e.g., 14 for A0 on Arduino Uno)
    ///
    /// Note: This assumes `report_analog` has already been enabled for this pin
    /// and the reader loop has pumped recent values into the cache.
    pub fn analog_read(&mut self, pin: u8) -> Result<u16, HardwareError> {
        self.client
            .pins
            .get(pin as usize)
            .map(|p| p.value as u16)
            .ok_or_else(|| fw_err("Analog pin not found", pin))
    }

    /// Count of analog pins strictly before `pin` — the Firmata analog channel
    /// number, matching `firmata-rs`'s `report_analog` indexing.
    fn analog_channel_for(&self, pin: u8) -> u8 {
        self.client
            .pins
            .iter()
            .take(pin as usize)
            .filter(|p| p.analog)
            .count() as u8
    }

    /// Enable analog reporting for a pin
    /// Call this once during initialization, not on every read
    pub fn enable_analog_reporting(&mut self, pin: u8) -> Result<(), HardwareError> {
        let is_analog = self
            .client
            .pins
            .get(pin as usize)
            .ok_or_else(|| fw_err("Pin not found", pin))?
            .analog;

        if !is_analog {
            return Err(HardwareError::UnsupportedPinMode {
                pin,
                mode: crate::runtime::pin_mode::ANALOG,
            });
        }

        let analog_channel = self.analog_channel_for(pin);
        log::info!("Enabling analog reporting: pin={pin}, analog_channel={analog_channel}");

        let bytes = self.client.encode_report_analog(analog_channel, true);
        self.write_bytes(&bytes, "Failed to enable analog reporting")
    }

    /// Process all pending messages from the board and emit change events
    /// Note: With the dedicated reader thread, this is mainly used as a fallback
    pub fn read_all(&mut self) -> Result<(), HardwareError> {
        if self.pump()? {
            self.detect_and_emit_changes();
        }
        Ok(())
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

        let pins = &self.client.pins;
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

            let last_value = self.pin_values.get(&pin_num).map(|v| v.0);
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
                self.pin_values.insert(pin_num, (current_value, Instant::now()));
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
            self.client.i2c_data.clear();
            return;
        };
        drop(cb_guard);

        let replies: Vec<_> = self.client.i2c_data.drain(..).collect();
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
        let bytes = self.client.encode_report_digital(port, enabled);
        self.write_bytes(&bytes, "Failed to set reporting")
    }

    /// Disable analog reporting for a pin.
    /// Call this during component cleanup to stop receiving updates.
    pub fn disable_analog_reporting(&mut self, pin: u8) -> Result<(), HardwareError> {
        let is_analog = self
            .client
            .pins
            .get(pin as usize)
            .ok_or_else(|| fw_err("Pin not found", pin))?
            .analog;

        if !is_analog {
            return Ok(());
        }

        let analog_channel = self.analog_channel_for(pin);
        log::info!("Disabling analog reporting: pin={pin}, analog_channel={analog_channel}");

        self.pin_values.remove(&pin);

        let bytes = self.client.encode_report_analog(analog_channel, false);
        self.write_bytes(&bytes, "Failed to disable analog reporting")
    }

    /// Disable digital reporting for a pin's port.
    /// Note: This disables reporting for the entire port (8 pins).
    pub fn disable_digital_reporting(&mut self, pin: u8) -> Result<(), HardwareError> {
        let port = pin / 8;

        log::info!("Disabling digital reporting: pin={pin}, port={port}");

        self.pin_values.remove(&pin);

        let bytes = self.client.encode_report_digital(port, false);
        self.write_bytes(&bytes, "Failed to disable digital reporting")
    }

    /// Disable all reporting and clear state. Called inside the reader thread — no sleep needed.
    pub fn reset_all_reporting(&mut self) -> Result<(), HardwareError> {
        log::info!("Resetting all pin reporting");
        self.pin_values.clear();
        for channel in 0..16 {
            let bytes = self.client.encode_report_analog(channel, false);
            let _ = self.write_bytes(&bytes, "reset analog reporting");
        }
        for port in 0..13 {
            let bytes = self.client.encode_report_digital(port, false);
            let _ = self.write_bytes(&bytes, "reset digital reporting");
        }
        Ok(())
    }

    pub fn i2c_config(&mut self, delay: i32) -> Result<(), HardwareError> {
        let bytes = self.client.encode_i2c_config(delay);
        self.write_bytes(&bytes, "Failed to configure I2C")
    }

    pub fn i2c_read(&mut self, address: i32, size: i32) -> Result<(), HardwareError> {
        let bytes = self.client.encode_i2c_read(address, size);
        self.write_bytes(&bytes, "Failed to I2C read")
    }

    pub fn i2c_write(&mut self, address: i32, data: &[u8]) -> Result<(), HardwareError> {
        let bytes = self.client.encode_i2c_write(address, data);
        self.write_bytes(&bytes, "Failed to I2C write")
    }

    pub fn i2c_stop_reading(&mut self, address: i32) -> Result<(), HardwareError> {
        let bytes = self.client.encode_i2c_stop_reading(address);
        self.write_bytes(&bytes, "Failed to stop I2C reading")
    }
}
