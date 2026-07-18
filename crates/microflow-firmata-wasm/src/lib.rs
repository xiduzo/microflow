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

use microflow_core::bringup::{Action as BringUpAction, BringUp, Event as BringUpEvent};
use microflow_core::firmata::{FirmataClient, Message};
use microflow_core::flasher::firmware::standard_firmata_hex;
use microflow_core::flasher::{hex, new_driver, BoardConfig, BoardType, FlashDriver, FlashStep};
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

    /// Start a continuous (streaming) I2C read: the board re-writes `register`
    /// and pushes an `I2C_REPLY` every sampling interval on its own. Pairs with
    /// [`Self::encode_sampling_interval`] (the stream rate) and
    /// [`Self::encode_i2c_stop_reading`]. The desktop `BoardWriter` has all six
    /// I2C encoders; this shim was missing this one and the sampling interval, so
    /// browser-side streaming was reachable only through the core runtime.
    #[wasm_bindgen(js_name = encodeI2cReadContinuous)]
    #[must_use]
    pub fn encode_i2c_read_continuous(&self, address: i32, register: i32, size: i32) -> Vec<u8> {
        self.client.encode_i2c_read_continuous(address, register, size)
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

    /// Set the board's global sampling interval (ms) — the report-loop period
    /// that clocks continuous I2C reads (and analog reporting). A single global
    /// Firmata setting; the runtime reconciles it to the slowest sensor's rate.
    #[wasm_bindgen(js_name = encodeSamplingInterval)]
    #[must_use]
    pub fn encode_sampling_interval(&self, interval_ms: i32) -> Vec<u8> {
        self.client.encode_sampling_interval(interval_ms)
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

// --- Flashing helpers (pure, shared with the desktop flasher) --------------
//
// The bootloader I/O *orchestration* (reset timing, sync loops, programming)
// is not here — it is timing-critical and, for AVR109, involves USB
// re-enumeration that Web Serial models differently. These expose the pure
// pieces a browser flasher needs regardless of which protocol drives it.

/// Parse an Intel HEX string (compiled sketch / `StandardFirmata`) into the raw
/// flash image bytes, gaps filled with `0xFF`.
///
/// # Errors
/// Returns a `JsError` if a HEX data record is malformed.
#[wasm_bindgen(js_name = parseHex)]
pub fn parse_hex(hex_content: &str) -> Result<Vec<u8>, JsError> {
    hex::parse(hex_content).map_err(|e| JsError::new(&e.to_string()))
}

/// Detect the Arduino board type from a USB vendor/product id, returning the
/// lowercase board id (e.g. `"uno"`, `"nano"`) or `null` if unrecognised.
#[wasm_bindgen(js_name = detectBoardFromUsb)]
#[must_use]
pub fn detect_board_from_usb(vid: u16, pid: u16) -> Option<String> {
    BoardConfig::detect_from_usb(vid, pid).map(|b| b.as_str().to_string())
}

/// The embedded `StandardFirmata` hex for a board id (e.g. `"nano"`), or `null`
/// if the id is unknown.
#[wasm_bindgen(js_name = standardFirmataHex)]
#[must_use]
pub fn standard_firmata_hex_for(board_id: &str) -> Option<String> {
    BoardType::from_id(board_id).map(|b| standard_firmata_hex(b).to_string())
}

/// The serial baud rate to open the port at for flashing this board, or `null`
/// if the id is unknown. (AVR109 boards re-open at 1200 for the reset touch via
/// a `setBaud` step regardless.)
#[wasm_bindgen(js_name = flashBaud)]
#[must_use]
pub fn flash_baud(board_id: &str) -> Option<u32> {
    BoardType::from_id(board_id).map(|b| BoardConfig::find(b).baud_rate)
}

/// A bootloader flashing session for one board. Drives the shared sans-IO
/// [`FlashDriver`] (stk500v1 / stk500v2 / avr109, picked from the board type):
/// `start()` then `advance(bytesRead)` each return a JSON `FlashStep` telling
/// the JS executor what to do next (reset / write / read N / reacquire port /
/// progress / done / error). The browser owns the Web Serial transport.
#[wasm_bindgen]
pub struct FlashSession {
    driver: Box<dyn FlashDriver>,
}

#[wasm_bindgen]
impl FlashSession {
    /// Create a session for `board_id` (e.g. `"nano"`) that programs `flash`
    /// (the raw image from [`parse_hex`]).
    ///
    /// # Errors
    /// Returns a `JsError` if `board_id` is not a known board.
    #[wasm_bindgen(constructor)]
    pub fn new(board_id: &str, flash: &[u8]) -> Result<FlashSession, JsError> {
        let board = BoardType::from_id(board_id)
            .ok_or_else(|| JsError::new(&format!("unknown board id: {board_id}")))?;
        Ok(Self { driver: new_driver(board, flash.to_vec()) })
    }

    /// The first step (always a reset). Call once before `advance`.
    ///
    /// # Errors
    /// Returns a `JsError` only if the step fails to serialize.
    pub fn start(&mut self) -> Result<String, JsError> {
        step_json(&self.driver.start())
    }

    /// Provide the bytes read for the previous step (empty for non-read steps)
    /// and get the next step, as JSON.
    ///
    /// # Errors
    /// Returns a `JsError` only if the step fails to serialize.
    pub fn advance(&mut self, input: &[u8]) -> Result<String, JsError> {
        step_json(&self.driver.advance(input))
    }
}

fn step_json(step: &FlashStep) -> Result<String, JsError> {
    serde_json::to_string(step).map_err(|e| JsError::new(&format!("failed to serialize step: {e}")))
}

// --- Bring-up policy (shared with the desktop hardware monitor) --------------

/// The sans-IO board bring-up state machine ([`microflow_core::bringup`]): the
/// probe → flash-if-missing → connect → auto-reconnect policy the desktop
/// hardware monitor runs natively. Feed it a JSON `BringUpEvent`; perform the
/// returned JSON `BringUpAction[]`. The browser owns all I/O and UI.
#[wasm_bindgen]
pub struct BringUpMachine {
    inner: BringUp,
}

#[wasm_bindgen]
impl BringUpMachine {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self { inner: BringUp::new() }
    }

    /// True once a probe succeeded and nothing has torn the connection down.
    #[wasm_bindgen(js_name = isConnected)]
    #[must_use]
    pub fn is_connected(&self) -> bool {
        self.inner.is_connected()
    }

    /// Advance the machine with one JSON `BringUpEvent`; returns the JSON
    /// `BringUpAction[]` the caller must perform, in order.
    ///
    /// # Errors
    /// Returns a `JsError` if the event JSON is malformed or the actions fail
    /// to serialize.
    pub fn handle(&mut self, event_json: &str) -> Result<String, JsError> {
        let event: BringUpEvent = serde_json::from_str(event_json)
            .map_err(|e| JsError::new(&format!("invalid bring-up event: {e}")))?;
        let actions: Vec<BringUpAction> = self.inner.handle(event);
        serde_json::to_string(&actions)
            .map_err(|e| JsError::new(&format!("failed to serialize actions: {e}")))
    }
}

impl Default for BringUpMachine {
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
    fn parse_hex_returns_flash_bytes() {
        let data = parse_hex(":100000000C9461000C9489000C9489000C94890014").expect("valid hex");
        assert_eq!(data.len(), 16);
        assert_eq!(data[0], 0x0C);
    }

    #[test]
    fn detect_board_from_usb_maps_known_ids() {
        assert_eq!(detect_board_from_usb(0x1a86, 0x7523).as_deref(), Some("nano"));
        assert_eq!(detect_board_from_usb(0x2341, 0x0043).as_deref(), Some("uno"));
        assert_eq!(detect_board_from_usb(0x0000, 0xFFFF), None);
    }

    #[test]
    fn flash_session_starts_with_a_reset_step() {
        let mut s = FlashSession::new("nano", &[0u8; 8]).expect("nano session");
        let json = s.start().expect("start");
        assert!(json.contains("\"kind\":\"reset\""), "got: {json}");
    }

    // The unknown-board path returns a JsError, which cannot be constructed on
    // a non-wasm host (it panics: "cannot call wasm-bindgen imported functions
    // on non-wasm targets"), so it is only exercisable in the browser.

    #[test]
    fn bring_up_machine_round_trips_json() {
        let mut m = BringUpMachine::new();
        let actions = m
            .handle(r#"{"type":"portReady","board":"nano","autoFlash":true,"explicit":true}"#)
            .expect("handle ok");
        assert!(actions.contains(r#"{"type":"notify","phase":{"kind":"connecting"}}"#), "got: {actions}");
        assert!(actions.contains(r#"{"type":"probe","afterFlash":false}"#), "got: {actions}");
        let actions = m.handle(r#"{"type":"probeOk"}"#).expect("handle ok");
        assert!(actions.contains(r#""kind":"connected""#), "got: {actions}");
        assert!(m.is_connected());
    }

    #[test]
    fn standard_firmata_hex_available_for_known_boards() {
        assert!(standard_firmata_hex_for("nano").is_some());
        assert!(standard_firmata_hex_for("mega").is_some());
        assert!(standard_firmata_hex_for("bogus").is_none());
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
