//! Sans-IO Firmata client — the platform-independent half of board comms.
//!
//! This is a faithful reimplementation of the `firmata-rs` `Board` state
//! machine with the **transport removed**. Where `firmata-rs` couples protocol
//! to a `Read + Write` connection (so it only works where blocking serial I/O
//! exists — i.e. the native desktop, never `wasm32`), this client is pure:
//!
//! - **Encoders** ([`FirmataClient::encode_*`]) return the wire bytes to send
//!   instead of writing them. The caller owns the transport and does the write.
//! - **Decoding** ([`FirmataClient::feed`]) takes whatever bytes the transport
//!   read — any chunking — and parses as many complete Firmata messages as are
//!   present, updating the cached pin table / I2C buffer exactly as
//!   `firmata-rs` does. Partial trailing bytes are buffered until the rest
//!   arrives.
//!
//! Because there is no I/O, async, or clock, the module compiles identically
//! for native and `wasm32`: the desktop feeds it bytes from `serialport`, the
//! browser feeds it bytes from the Web Serial API, and both get byte-identical
//! protocol behaviour from this single source of truth.
//!
//! ## Parity with `firmata-rs`
//!
//! The value-level decode (analog pin = `(status & 0x0F) + 14`, digital pins
//! only updated while in `INPUT` mode, analog-mapping / capability / firmware /
//! I2C parsing, the octal version formatting) is replicated **exactly** so the
//! desktop runtime behaves the same after migrating off `firmata-rs`. The one
//! deliberate improvement is framing: `firmata-rs` blindly `read_exact(3)` for
//! every message (relying on the stream staying aligned); this client is
//! length-aware and re-syncs on a stray byte, which is strictly more robust on
//! a real serial stream and identical for well-formed `StandardFirmata` output.

use serde::{Deserialize, Serialize};

// --- Protocol constants (mirrors firmata-rs) --------------------------------

pub const ANALOG_MAPPING_QUERY: u8 = 0x69;
pub const ANALOG_MAPPING_RESPONSE: u8 = 0x6A;
pub const CAPABILITY_QUERY: u8 = 0x6B;
pub const CAPABILITY_RESPONSE: u8 = 0x6C;
pub const EXTENDED_ANALOG: u8 = 0x6F;
pub const STRING_DATA: u8 = 0x71;
pub const I2C_REQUEST: u8 = 0x76;
pub const I2C_REPLY: u8 = 0x77;
pub const I2C_CONFIG: u8 = 0x78;
pub const I2C_MODE_WRITE: u8 = 0x00;
pub const I2C_MODE_READ: u8 = 0x01;
pub const REPORT_FIRMWARE: u8 = 0x79;
pub const PROTOCOL_VERSION: u8 = 0xF9;
pub const SYSEX_REALTIME: u8 = 0x7F;
pub const START_SYSEX: u8 = 0xF0;
pub const END_SYSEX: u8 = 0xF7;
pub const PIN_MODE: u8 = 0xF4;
pub const REPORT_DIGITAL: u8 = 0xD0;
pub const REPORT_ANALOG: u8 = 0xC0;
pub const DIGITAL_MESSAGE: u8 = 0x90;
pub const DIGITAL_MESSAGE_BOUND: u8 = 0x9F;
pub const ANALOG_MESSAGE: u8 = 0xE0;
pub const ANALOG_MESSAGE_BOUND: u8 = 0xEF;

// --- Pin modes (mirrors runtime::pin_mode) ----------------------------------

pub const MODE_INPUT: u8 = 0;
pub const MODE_OUTPUT: u8 = 1;
pub const MODE_ANALOG: u8 = 2;
pub const MODE_PWM: u8 = 3;
pub const MODE_SERVO: u8 = 4;
pub const MODE_I2C: u8 = 6;
pub const MODE_PULLUP: u8 = 11;

// --- Decoded state ----------------------------------------------------------

/// An available pin mode and its resolution (bits), as reported by the board's
/// capability response.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mode {
    pub mode: u8,
    pub resolution: u8,
}

/// The cached state and configuration of a single pin. Mirrors `firmata-rs`'s
/// `Pin` — `value` is the last value seen (incoming reports) or set (outgoing
/// writes); `mode` is the last mode set; `modes` / `analog` come from the
/// capability and analog-mapping responses.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pin {
    pub modes: Vec<Mode>,
    pub analog: bool,
    pub value: i32,
    pub mode: u8,
}

/// An I2C reply decoded from the board.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct I2cReply {
    pub address: i32,
    pub register: i32,
    pub data: Vec<u8>,
}

/// The kind of message parsed from the stream. Carries no payload — the
/// payload has already been folded into the client's cached state (`pins`,
/// `i2c_data`, firmware fields); callers diff that state to surface changes,
/// exactly as the desktop reader loop already does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Message {
    ProtocolVersion,
    Analog,
    Digital,
    EmptyResponse,
    AnalogMappingResponse,
    CapabilityResponse,
    ReportFirmware,
    I2cReply,
}

// --- The client -------------------------------------------------------------

/// A transport-free Firmata client: encode commands to bytes, feed it incoming
/// bytes, read the resulting cached state. Holds no I/O handle, so it is
/// `Send + Sync`-trivial and `wasm32`-clean.
#[derive(Debug, Default)]
pub struct FirmataClient {
    pub pins: Vec<Pin>,
    pub i2c_data: Vec<I2cReply>,
    pub protocol_version: String,
    pub firmware_name: String,
    pub firmware_version: String,
    /// Bytes received but not yet forming a complete message.
    rx: Vec<u8>,
}

impl FirmataClient {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Grow the pin table so `idx` is addressable. `firmata-rs` would panic on
    /// an out-of-range index (it relies on the capability response having sized
    /// `pins` first); growing instead is harmless for the normal post-capability
    /// path and removes a latent panic when a command races detection.
    fn ensure_pin(&mut self, idx: usize) {
        if self.pins.len() <= idx {
            self.pins.resize_with(idx + 1, Pin::default);
        }
    }

    // --- Encoders: return wire bytes; caller writes them ------------------

    /// `[PIN_MODE, pin, mode]`. Caches the mode so `encode_digital_write` knows
    /// which port pins to OR together.
    pub fn encode_set_pin_mode(&mut self, pin: u8, mode: u8) -> Vec<u8> {
        self.ensure_pin(pin as usize);
        self.pins[pin as usize].mode = mode;
        vec![PIN_MODE, pin, mode]
    }

    /// Digital write. Mirrors `firmata-rs`: caches the pin value, then emits the
    /// whole 8-pin port byte built from the cached values of that port.
    pub fn encode_digital_write(&mut self, pin: u8, value: bool) -> Vec<u8> {
        self.ensure_pin(pin as usize);
        let level = i32::from(value);
        self.pins[pin as usize].value = level;

        let port = (pin / 8) as usize;
        self.ensure_pin(port * 8 + 7);
        let mut port_value = 0i32;
        for i in 0..8 {
            if self.pins[port * 8 + i].value != 0 {
                port_value |= 1 << i;
            }
        }
        vec![
            DIGITAL_MESSAGE | port as u8,
            port_value as u8 & SYSEX_REALTIME,
            (port_value >> 7) as u8 & SYSEX_REALTIME,
        ]
    }

    /// Analog (PWM) write to a pin in the low nibble (`pin < 16`). Mirrors
    /// `firmata-rs::analog_write`.
    pub fn encode_analog_write(&mut self, pin: u8, value: u16) -> Vec<u8> {
        self.ensure_pin(pin as usize);
        self.pins[pin as usize].value = i32::from(value);
        vec![
            ANALOG_MESSAGE | pin,
            value as u8 & SYSEX_REALTIME,
            (value >> 7) as u8 & SYSEX_REALTIME,
        ]
    }

    /// `[REPORT_DIGITAL | port, state]`.
    #[must_use]
    pub fn encode_report_digital(&self, port: u8, enabled: bool) -> Vec<u8> {
        vec![REPORT_DIGITAL | port, u8::from(enabled)]
    }

    /// `[REPORT_ANALOG | channel, state]`.
    #[must_use]
    pub fn encode_report_analog(&self, analog_channel: u8, enabled: bool) -> Vec<u8> {
        vec![REPORT_ANALOG | analog_channel, u8::from(enabled)]
    }

    /// `[F0, I2C_CONFIG, delay_lsb, delay_msb, F7]`.
    #[must_use]
    pub fn encode_i2c_config(&self, delay: i32) -> Vec<u8> {
        vec![
            START_SYSEX,
            I2C_CONFIG,
            (delay & 0xFF) as u8,
            ((delay >> 8) & 0xFF) as u8,
            END_SYSEX,
        ]
    }

    /// One-shot I2C read of `size` bytes from `address`.
    #[must_use]
    pub fn encode_i2c_read(&self, address: i32, size: i32) -> Vec<u8> {
        vec![
            START_SYSEX,
            I2C_REQUEST,
            address as u8,
            I2C_MODE_READ << 3,
            size as u8 & SYSEX_REALTIME,
            (size >> 7) as u8 & SYSEX_REALTIME,
            END_SYSEX,
        ]
    }

    /// I2C write of `data` to `address` (each byte split into two 7-bit bytes).
    #[must_use]
    pub fn encode_i2c_write(&self, address: i32, data: &[u8]) -> Vec<u8> {
        let mut buf = vec![START_SYSEX, I2C_REQUEST, address as u8, I2C_MODE_WRITE << 3];
        for &b in data {
            buf.push(b & SYSEX_REALTIME);
            buf.push((i32::from(b) >> 7) as u8 & SYSEX_REALTIME);
        }
        buf.push(END_SYSEX);
        buf
    }

    /// Stop continuous I2C reading for `address` (mode bits `0b11`).
    #[must_use]
    pub fn encode_i2c_stop_reading(&self, address: i32) -> Vec<u8> {
        vec![START_SYSEX, I2C_REQUEST, address as u8, 0b11 << 3, END_SYSEX]
    }

    /// Raw sysex: `[F0, command, data.., F7]`. Data must already be 7-bit.
    #[must_use]
    pub fn encode_sysex(&self, command: u8, data: &[u8]) -> Vec<u8> {
        let mut buf = Vec::with_capacity(data.len() + 3);
        buf.push(START_SYSEX);
        buf.push(command);
        buf.extend_from_slice(data);
        buf.push(END_SYSEX);
        buf
    }

    #[must_use]
    pub fn encode_query_firmware(&self) -> Vec<u8> {
        vec![START_SYSEX, REPORT_FIRMWARE, END_SYSEX]
    }

    #[must_use]
    pub fn encode_query_capabilities(&self) -> Vec<u8> {
        vec![START_SYSEX, CAPABILITY_QUERY, END_SYSEX]
    }

    #[must_use]
    pub fn encode_query_analog_mapping(&self) -> Vec<u8> {
        vec![START_SYSEX, ANALOG_MAPPING_QUERY, END_SYSEX]
    }

    // --- Decoder ----------------------------------------------------------

    /// Feed bytes read from the transport. Parses every complete message now in
    /// the buffer, folding each into the cached state, and returns the kinds
    /// parsed (in order). Incomplete trailing bytes are retained for the next
    /// call.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Message> {
        self.rx.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            match self.parse_one() {
                Step::Parsed(msg) => out.push(msg),
                Step::Skipped => {}
                Step::Incomplete => break,
            }
        }
        out
    }

    /// Number of bytes currently buffered awaiting completion (test/debug aid).
    #[must_use]
    pub fn pending_bytes(&self) -> usize {
        self.rx.len()
    }

    #[allow(clippy::too_many_lines)]
    fn parse_one(&mut self) -> Step {
        let Some(&cmd) = self.rx.first() else {
            return Step::Incomplete;
        };

        match cmd {
            PROTOCOL_VERSION => {
                if self.rx.len() < 3 {
                    return Step::Incomplete;
                }
                self.protocol_version = format!("{:o}.{:o}", self.rx[1], self.rx[2]);
                self.rx.drain(..3);
                Step::Parsed(Message::ProtocolVersion)
            }
            ANALOG_MESSAGE..=ANALOG_MESSAGE_BOUND => {
                if self.rx.len() < 3 {
                    return Step::Incomplete;
                }
                let value = i32::from(self.rx[1]) | (i32::from(self.rx[2]) << 7);
                let pin = (i32::from(cmd) & 0x0F) + 14;
                if (self.pins.len() as i32) > pin {
                    self.pins[pin as usize].value = value;
                }
                self.rx.drain(..3);
                Step::Parsed(Message::Analog)
            }
            DIGITAL_MESSAGE..=DIGITAL_MESSAGE_BOUND => {
                if self.rx.len() < 3 {
                    return Step::Incomplete;
                }
                let port = i32::from(cmd) & 0x0F;
                let value = i32::from(self.rx[1]) | (i32::from(self.rx[2]) << 7);
                for i in 0..8 {
                    let pin = (8 * port) + i;
                    if (self.pins.len() as i32) > pin
                        && self.pins[pin as usize].mode == MODE_INPUT
                    {
                        self.pins[pin as usize].value = (value >> (i & 0x07)) & 0x01;
                    }
                }
                self.rx.drain(..3);
                Step::Parsed(Message::Digital)
            }
            START_SYSEX => {
                // A complete sysex message ends at the first END_SYSEX. Data
                // bytes are 7-bit so none can equal 0xF7 — scanning is safe.
                let Some(end) = self.rx.iter().position(|&b| b == END_SYSEX) else {
                    return Step::Incomplete;
                };
                let msg: Vec<u8> = self.rx.drain(..=end).collect();
                self.parse_sysex(&msg)
            }
            _ => {
                // Stray / unaligned byte (data byte or unhandled status). Drop
                // one and re-sync on the next status boundary.
                self.rx.remove(0);
                Step::Skipped
            }
        }
    }

    /// Parse a complete sysex frame `[F0, cmd, data.., F7]`. Mirrors the
    /// `firmata-rs` branches; unknown codes are skipped (no event), matching the
    /// desktop reader loop which logs and ignores `UnknownSysEx`.
    fn parse_sysex(&mut self, buf: &[u8]) -> Step {
        // buf[0] == START_SYSEX, buf[last] == END_SYSEX, buf[1] == sysex command.
        let Some(&sub) = buf.get(1) else {
            return Step::Skipped;
        };
        match sub {
            END_SYSEX => Step::Parsed(Message::EmptyResponse),
            ANALOG_MAPPING_RESPONSE => {
                let mut i = 2;
                let upper = (buf.len() - 1).min(self.pins.len() + 2);
                while i < upper {
                    if buf[i] != 127u8 {
                        self.pins[i - 2].analog = true;
                    }
                    i += 1;
                }
                Step::Parsed(Message::AnalogMappingResponse)
            }
            CAPABILITY_RESPONSE => {
                let mut pin = 0usize;
                let mut i = 2;
                self.pins = vec![Pin::default()];
                while i < buf.len() - 1 {
                    if buf[i] == 127u8 {
                        pin += 1;
                        i += 1;
                        self.pins.push(Pin::default());
                        continue;
                    }
                    // Guard the resolution byte against a truncated frame.
                    let resolution = buf.get(i + 1).copied().unwrap_or(0);
                    self.pins[pin].modes.push(Mode { mode: buf[i], resolution });
                    i += 2;
                }
                Step::Parsed(Message::CapabilityResponse)
            }
            REPORT_FIRMWARE => {
                let (Some(&major), Some(&minor)) = (buf.get(2), buf.get(3)) else {
                    return Step::Skipped;
                };
                self.firmware_version = format!("{major:o}.{minor:o}");
                if 4 < buf.len() - 1 {
                    // Mirror firmata-rs exactly: decode the raw slice (it does
                    // not recombine the 7-bit name pairs). Lossy to avoid an
                    // error path the desktop never hit.
                    self.firmware_name =
                        String::from_utf8_lossy(&buf[4..buf.len() - 1]).into_owned();
                }
                Step::Parsed(Message::ReportFirmware)
            }
            I2C_REPLY => {
                let len = buf.len();
                if len < 8 {
                    return Step::Skipped;
                }
                let mut reply = I2cReply {
                    address: i32::from(buf[2]) | (i32::from(buf[3]) << 7),
                    register: i32::from(buf[4]) | (i32::from(buf[5]) << 7),
                    data: vec![buf[6] | (buf[7] << 7)],
                };
                let mut i = 8;
                while i < len - 1 {
                    if buf[i] == END_SYSEX || i + 2 > len {
                        break;
                    }
                    reply.data.push(buf[i] | (buf[i + 1] << 7));
                    i += 2;
                }
                self.i2c_data.push(reply);
                Step::Parsed(Message::I2cReply)
            }
            _ => Step::Skipped,
        }
    }
}

/// Outcome of one `parse_one` attempt.
enum Step {
    /// A complete message was parsed and folded into state.
    Parsed(Message),
    /// A byte or unknown frame was dropped; try again immediately.
    Skipped,
    /// Not enough bytes for a complete message; wait for more.
    Incomplete,
}

#[cfg(test)]
mod tests;
