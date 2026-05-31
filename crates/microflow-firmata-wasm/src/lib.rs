//! WebAssembly wrapper around [`microflow_core::firmata`].
//!
//! This crate adds **no** protocol logic — it is a thin `wasm-bindgen` shim so
//! the browser can speak the exact same Firmata protocol the desktop app speaks
//! natively (single source of truth, no drift). It exposes the sans-IO
//! [`FirmataClient`] as a stateful [`FirmataSession`]:
//!
//! - **Encoders** return the wire bytes (`Uint8Array`) to write to the board.
//! - [`FirmataSession::feed`] takes the bytes read from the board and returns a
//!   JSON summary of what changed (pin changes, I2C replies, whether firmware /
//!   capabilities were (re)reported), ready to `JSON.parse`.
//!
//! The **transport is the caller's** — the browser owns the Web Serial port and
//! its async read/write loop, because WASM cannot block on the Web Serial
//! Promises. This module is pure: no I/O, no async, no clock.
//!
//! The pin-change diffing here mirrors the desktop reader loop
//! (`runtime::board::connection::detect_and_emit_changes`) so the browser
//! surfaces the same events from the same byte stream.

// Firmata values are small (7-bit data, pin counts < 256), so the deliberate
// narrowing casts between u8/u16/i32/usize cannot actually lose information.
// Mirror microflow-core's crate-wide allowance for the same cast lints.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap
)]

use microflow_core::firmata::{FirmataClient, Message};
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Initialise the wasm module: install a panic hook so a Rust panic surfaces as
/// a readable `console.error` rather than an opaque trap. Safe to call twice.
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(target_arch = "wasm32")]
    console_error_panic_hook::set_once();
}

/// A pin value change, mirroring the desktop `PinChangeEvent`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PinChange {
    pin: u8,
    value: u16,
    is_analog: bool,
}

/// An I2C reply, mirroring the desktop `I2cReplyEvent`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct I2cReplyOut {
    address: u8,
    register: u8,
    data: Vec<u8>,
}

/// Pin capability info, matching the ts-rs `PinInfo` binding shape so the board
/// store can reuse it verbatim.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PinInfo {
    pin: usize,
    supported_modes: Vec<u8>,
    analog_channel: i32,
}

/// What changed after feeding a chunk of incoming bytes. Returned as JSON from
/// [`FirmataSession::feed`].
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedResult {
    pin_changes: Vec<PinChange>,
    i2c_replies: Vec<I2cReplyOut>,
    /// A firmware report arrived this feed — the caller should re-read
    /// `firmwareName` / `firmwareVersion`.
    firmware_updated: bool,
    /// A capability or analog-mapping response arrived — re-read `pinsJson`.
    capabilities_updated: bool,
}

/// A live Firmata protocol session for one board connection. Holds the codec
/// plus the last-seen pin values for change detection. The caller drives it:
/// write the encoder output to the port, feed it the bytes read back.
#[wasm_bindgen]
pub struct FirmataSession {
    client: FirmataClient,
    /// Last value emitted per pin index, for change detection.
    last: Vec<Option<i32>>,
}

#[wasm_bindgen]
impl FirmataSession {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self {
            client: FirmataClient::new(),
            last: Vec::new(),
        }
    }

    // --- Encoders: return bytes for the caller to write ------------------

    #[wasm_bindgen(js_name = encodeSetPinMode)]
    pub fn encode_set_pin_mode(&mut self, pin: u8, mode: u8) -> Vec<u8> {
        self.client.encode_set_pin_mode(pin, mode)
    }

    #[wasm_bindgen(js_name = encodeDigitalWrite)]
    pub fn encode_digital_write(&mut self, pin: u8, value: bool) -> Vec<u8> {
        self.client.encode_digital_write(pin, value)
    }

    #[wasm_bindgen(js_name = encodeAnalogWrite)]
    pub fn encode_analog_write(&mut self, pin: u8, value: u16) -> Vec<u8> {
        self.client.encode_analog_write(pin, value)
    }

    #[wasm_bindgen(js_name = encodeReportDigital)]
    #[must_use]
    pub fn encode_report_digital(&self, port: u8, enabled: bool) -> Vec<u8> {
        self.client.encode_report_digital(port, enabled)
    }

    #[wasm_bindgen(js_name = encodeReportAnalog)]
    #[must_use]
    pub fn encode_report_analog(&self, analog_channel: u8, enabled: bool) -> Vec<u8> {
        self.client.encode_report_analog(analog_channel, enabled)
    }

    /// Enable/disable analog reporting for a digital pin, computing the Firmata
    /// analog channel from the capability table (same indexing the desktop
    /// uses). Returns the report-analog bytes; empty if the pin is not analog.
    #[wasm_bindgen(js_name = encodeAnalogReporting)]
    #[must_use]
    pub fn encode_analog_reporting(&self, pin: u8, enabled: bool) -> Vec<u8> {
        let Some(info) = self.client.pins.get(pin as usize) else {
            return Vec::new();
        };
        if !info.analog {
            return Vec::new();
        }
        let channel = self
            .client
            .pins
            .iter()
            .take(pin as usize)
            .filter(|p| p.analog)
            .count() as u8;
        self.client.encode_report_analog(channel, enabled)
    }

    #[wasm_bindgen(js_name = encodeI2cConfig)]
    #[must_use]
    pub fn encode_i2c_config(&self, delay: i32) -> Vec<u8> {
        self.client.encode_i2c_config(delay)
    }

    #[wasm_bindgen(js_name = encodeI2cRead)]
    #[must_use]
    pub fn encode_i2c_read(&self, address: i32, size: i32) -> Vec<u8> {
        self.client.encode_i2c_read(address, size)
    }

    #[wasm_bindgen(js_name = encodeI2cWrite)]
    #[must_use]
    pub fn encode_i2c_write(&self, address: i32, data: &[u8]) -> Vec<u8> {
        self.client.encode_i2c_write(address, data)
    }

    #[wasm_bindgen(js_name = encodeI2cStopReading)]
    #[must_use]
    pub fn encode_i2c_stop_reading(&self, address: i32) -> Vec<u8> {
        self.client.encode_i2c_stop_reading(address)
    }

    #[wasm_bindgen(js_name = encodeSysex)]
    #[must_use]
    pub fn encode_sysex(&self, command: u8, data: &[u8]) -> Vec<u8> {
        self.client.encode_sysex(command, data)
    }

    #[wasm_bindgen(js_name = encodeQueryFirmware)]
    #[must_use]
    pub fn encode_query_firmware(&self) -> Vec<u8> {
        self.client.encode_query_firmware()
    }

    #[wasm_bindgen(js_name = encodeQueryCapabilities)]
    #[must_use]
    pub fn encode_query_capabilities(&self) -> Vec<u8> {
        self.client.encode_query_capabilities()
    }

    #[wasm_bindgen(js_name = encodeQueryAnalogMapping)]
    #[must_use]
    pub fn encode_query_analog_mapping(&self) -> Vec<u8> {
        self.client.encode_query_analog_mapping()
    }

    // --- Decode -----------------------------------------------------------

    /// Feed incoming bytes; parse, update cached state, and return a JSON
    /// [`FeedResult`] describing what changed.
    ///
    /// # Errors
    /// Returns a `JsError` only if serializing the result to JSON fails (not
    /// expected for these plain structs).
    pub fn feed(&mut self, bytes: &[u8]) -> Result<String, JsError> {
        let messages = self.client.feed(bytes);

        let mut firmware_updated = false;
        let mut capabilities_updated = false;
        for m in &messages {
            match m {
                Message::ReportFirmware => firmware_updated = true,
                Message::CapabilityResponse | Message::AnalogMappingResponse => {
                    capabilities_updated = true;
                }
                _ => {}
            }
        }

        // Keep the change-detection table sized to the pin count.
        if self.last.len() < self.client.pins.len() {
            self.last.resize(self.client.pins.len(), None);
        }

        let mut pin_changes = Vec::new();
        for (i, pin) in self.client.pins.iter().enumerate() {
            let current = pin.value;
            if self.last[i] == Some(current) {
                continue;
            }
            self.last[i] = Some(current);
            pin_changes.push(PinChange {
                pin: i as u8,
                value: current as u16,
                is_analog: pin.analog,
            });
        }

        let i2c_replies = self
            .client
            .i2c_data
            .drain(..)
            .map(|r| I2cReplyOut {
                address: r.address as u8,
                register: r.register as u8,
                data: r.data,
            })
            .collect();

        let result = FeedResult {
            pin_changes,
            i2c_replies,
            firmware_updated,
            capabilities_updated,
        };
        serde_json::to_string(&result)
            .map_err(|e| JsError::new(&format!("failed to serialize feed result: {e}")))
    }

    // --- State accessors --------------------------------------------------

    /// The current pin table as JSON (`PinInfo[]`), matching the ts-rs binding.
    ///
    /// # Errors
    /// Returns a `JsError` only if JSON serialization fails.
    #[wasm_bindgen(js_name = pinsJson)]
    pub fn pins_json(&self) -> Result<String, JsError> {
        let pins: Vec<PinInfo> = self
            .client
            .pins
            .iter()
            .enumerate()
            .map(|(index, pin)| PinInfo {
                pin: index,
                supported_modes: pin.modes.iter().map(|m| m.mode).collect(),
                analog_channel: if pin.analog { index as i32 } else { -1 },
            })
            .collect();
        serde_json::to_string(&pins)
            .map_err(|e| JsError::new(&format!("failed to serialize pins: {e}")))
    }

    #[wasm_bindgen(js_name = firmwareName)]
    #[must_use]
    pub fn firmware_name(&self) -> String {
        self.client.firmware_name.clone()
    }

    #[wasm_bindgen(js_name = firmwareVersion)]
    #[must_use]
    pub fn firmware_version(&self) -> String {
        self.client.firmware_version.clone()
    }

    #[wasm_bindgen(js_name = protocolVersion)]
    #[must_use]
    pub fn protocol_version(&self) -> String {
        self.client.protocol_version.clone()
    }
}

impl Default for FirmataSession {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use microflow_core::firmata::{
        ANALOG_MAPPING_RESPONSE, CAPABILITY_RESPONSE, END_SYSEX, MODE_ANALOG, MODE_INPUT,
        MODE_OUTPUT, REPORT_FIRMWARE, START_SYSEX,
    };

    #[test]
    fn feed_reports_firmware_and_capability_updates() {
        let mut s = FirmataSession::new();
        let cap = [
            START_SYSEX, CAPABILITY_RESPONSE,
            MODE_INPUT, 1, MODE_OUTPUT, 1, 127,
            MODE_ANALOG, 10, 127,
            END_SYSEX,
        ];
        let json = s.feed(&cap).expect("feed ok");
        assert!(json.contains("\"capabilitiesUpdated\":true"), "got: {json}");

        let fw = [START_SYSEX, REPORT_FIRMWARE, 2, 3, b'S', b'F', END_SYSEX];
        let json = s.feed(&fw).expect("feed ok");
        assert!(json.contains("\"firmwareUpdated\":true"), "got: {json}");
        assert_eq!(s.firmware_name(), "SF");
        assert_eq!(s.firmware_version(), "2.3");
    }

    #[test]
    fn analog_reporting_computes_channel_from_capabilities() {
        let mut s = FirmataSession::new();
        // 3 pins; pin 2 analog channel 0.
        let cap = [
            START_SYSEX, CAPABILITY_RESPONSE,
            MODE_INPUT, 1, 127,
            MODE_INPUT, 1, 127,
            MODE_ANALOG, 10, 127,
            END_SYSEX,
        ];
        s.feed(&cap).expect("feed ok");
        let mapping = [START_SYSEX, ANALOG_MAPPING_RESPONSE, 127, 127, 0, END_SYSEX];
        s.feed(&mapping).expect("feed ok");

        // pin 2 is the first analog pin -> channel 0 -> REPORT_ANALOG | 0.
        let bytes = s.encode_analog_reporting(2, true);
        assert_eq!(bytes, vec![0xC0, 1]);
        // A non-analog pin yields no bytes.
        assert!(s.encode_analog_reporting(0, true).is_empty());
    }

    #[test]
    fn pins_json_matches_pin_info_shape() {
        let mut s = FirmataSession::new();
        let cap = [
            START_SYSEX, CAPABILITY_RESPONSE,
            MODE_INPUT, 1, MODE_OUTPUT, 1, 127,
            END_SYSEX,
        ];
        s.feed(&cap).expect("feed ok");
        let json = s.pins_json().expect("pins json");
        assert!(json.contains("\"supportedModes\""), "got: {json}");
        assert!(json.contains("\"analogChannel\""), "got: {json}");
    }

    #[test]
    fn feed_surfaces_pin_changes_once_per_value() {
        let mut s = FirmataSession::new();
        // Size the pin table via a capability response (8 input pins on port 0).
        let mut cap = vec![START_SYSEX, CAPABILITY_RESPONSE];
        for _ in 0..8 {
            cap.extend_from_slice(&[MODE_INPUT, 1, 127]);
        }
        cap.push(END_SYSEX);
        s.feed(&cap).expect("feed ok");

        // Digital report: port 0, pins 0 and 2 high.
        let json = s.feed(&[0x90, 0b0000_0101, 0]).expect("feed ok");
        assert!(json.contains("\"pin\":0"), "got: {json}");
        assert!(json.contains("\"pin\":2"), "got: {json}");

        // Same values again -> no changes reported.
        let json = s.feed(&[0x90, 0b0000_0101, 0]).expect("feed ok");
        assert!(json.contains("\"pinChanges\":[]"), "got: {json}");
    }
}
