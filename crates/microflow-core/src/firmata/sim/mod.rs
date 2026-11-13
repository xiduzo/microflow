//! Simulated Firmata board — the second adapter at the board byte seam.
//!
//! The runtime talks to a board through bytes: [`BoardWriter`] encodes what it
//! wants into `Effects::outbound_bytes`, and [`FlowRuntime::feed_bytes`] decodes
//! what comes back. Until now the only implementation on the far side of that
//! seam was real hardware, so the hardware Nodes had no tests. [`SimBoard`] is
//! the other adapter: a scripted device that consumes the host's bytes and
//! produces the bytes `StandardFirmata` would, modelled on its
//! `setPinModeCallback` / `digitalWriteCallback` / `analogWriteCallback` /
//! `sysexCallback` / `readAndReportData` and its main loop.
//!
//! What it gives a test:
//! - **The handshake** — `REPORT_VERSION`, `REPORT_FIRMWARE`, `CAPABILITY_QUERY`,
//!   `ANALOG_MAPPING_QUERY` and `PIN_STATE_QUERY` answers for a [`BoardLayout`]
//!   (Uno, Mega 2560, Leonardo).
//! - **Board state, not bytes** — [`SimBoard::pin`] says "pin 9 is PWM at 128";
//!   the I2C bus, a MAX7219 chain, a WS2812 strip and `AccelStepper` motors are
//!   decoded the same way. Writes the firmware would silently ignore (an
//!   analog write to a pin not in PWM/SERVO mode, a mode the pin lacks) are
//!   collected in [`SimBoard::violations`].
//! - **Inputs** — drive digital levels and analog readings; the board reports
//!   them on its next [`run_loop`](SimBoard::run_loop) /
//!   [`sample`](SimBoard::sample) exactly when the firmware would.
//! - **Faults** — reboot and re-announce mid-session, drop outbound bytes, cut
//!   a sysex frame short, NACK an I2C address, and refuse the non-stock sysex
//!   extensions (Pixel `0x51`, `AccelStepper` `0x62`) unless enabled.
//!
//! [`rig::SimRig`] wraps a `SimBoard` and a [`FlowRuntime`] into a host, so a
//! Node test reads: build a flow, attach the board, inject an input, run a
//! turn, assert board state.
//!
//! [`BoardWriter`]: crate::runtime::BoardWriter
//! [`FlowRuntime`]: crate::runtime::FlowRuntime
//! [`FlowRuntime::feed_bytes`]: crate::runtime::FlowRuntime::feed_bytes

mod layout;
pub mod noise;
mod peripherals;
#[cfg(feature = "runtime")]
pub mod rig;
#[cfg(test)]
mod tests;

pub use layout::{BoardLayout, PinCaps};
pub use peripherals::{
    decode_stepper_float, decode_stepper_long, ColorOrder, Max7219, Max7219Chain, PixelStrip,
    SimI2cDevice, SimStepper, StepperInterface,
};

use super::{
    ANALOG_MAPPING_QUERY, ANALOG_MAPPING_RESPONSE, ANALOG_MESSAGE, CAPABILITY_QUERY,
    CAPABILITY_RESPONSE, DIGITAL_MESSAGE, END_SYSEX, EXTENDED_ANALOG, I2C_CONFIG, I2C_REPLY,
    I2C_REQUEST, MODE_ANALOG, MODE_I2C, MODE_INPUT, MODE_OUTPUT, MODE_PULLUP, MODE_PWM,
    MODE_SERVO, PIN_MODE, PROTOCOL_VERSION, REPORT_ANALOG, REPORT_DIGITAL, REPORT_FIRMWARE,
    SAMPLING_INTERVAL, START_SYSEX, STRING_DATA,
};
use std::collections::BTreeMap;

/// node-pixel's WS2812 sysex command.
pub const PIXEL_COMMAND: u8 = 0x51;
/// `ConfigurableFirmata`'s `AccelStepper` sysex command.
pub const ACCELSTEPPER_DATA: u8 = 0x62;
const SET_DIGITAL_PIN_VALUE: u8 = 0xF5;
const SYSTEM_RESET: u8 = 0xFF;
const PIN_STATE_QUERY: u8 = 0x6D;
const PIN_STATE_RESPONSE: u8 = 0x6E;
/// `AccelStepper` move-complete report sub-command.
const STEPPER_MOVE_COMPLETE: u8 = 0x0A;
/// `StandardFirmata`'s `I2C_MAX_QUERIES`.
const I2C_MAX_QUERIES: usize = 8;
/// The AVR `Wire` buffer: a read longer than this comes back short.
const WIRE_BUFFER: usize = 32;

/// A firmware extension beyond `StandardFirmata`. A board without it ignores
/// the extension's sysex, as stock firmware does; the sim records the refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Extension {
    /// node-pixel's WS2812 support (sysex `0x51`).
    Pixel,
    /// `ConfigurableFirmata`'s `AccelStepper` (sysex `0x62`).
    AccelStepper,
}

/// One pin as the firmware holds it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SimPin {
    caps: PinCaps,
    /// The Firmata pin mode; `None` until a supported mode is set (and always
    /// for a pin with no capability, like the Uno's serial pins).
    mode: Option<u8>,
    /// Firmata's pin state: the OUTPUT level, the PWM duty, the servo value, or
    /// 1 when an input's pull-up is on. `setPinModeCallback` zeroes it.
    state: i32,
    /// The AVR output latch (`PORTx` bit): the level an OUTPUT pin drives, or the
    /// pull-up of an input. Unlike `state` it survives a mode change — only
    /// `pinMode(INPUT)`, `INPUT_PULLUP` and leaving PWM rewrite it — so a pin
    /// left HIGH stays HIGH through `SYSTEM_RESET`, as on the real board.
    latch: bool,
    /// Level driven onto the pin from outside; `None` = floating.
    external: Option<bool>,
    /// What `analogRead` returns on this pin.
    analog_in: u16,
}

impl SimPin {
    #[must_use]
    pub fn caps(&self) -> PinCaps {
        self.caps
    }

    #[must_use]
    pub fn mode(&self) -> Option<u8> {
        self.mode
    }

    /// Firmata's raw pin state (see the field docs).
    #[must_use]
    pub fn state(&self) -> i32 {
        self.state
    }

    /// The level `digitalRead` sees: what the board drives on an OUTPUT pin (its
    /// latch), otherwise the external level, else the pull-up, else low.
    #[must_use]
    pub fn level(&self) -> bool {
        match self.mode {
            Some(MODE_OUTPUT) => self.latch,
            Some(MODE_PWM) => self.state >= 255,
            _ => self.external.unwrap_or(self.pullup()),
        }
    }

    /// Whether the board drives this pin high as a digital OUTPUT.
    #[must_use]
    pub fn is_high(&self) -> bool {
        self.mode == Some(MODE_OUTPUT) && self.latch
    }

    /// The PWM duty, if the pin is in PWM mode.
    #[must_use]
    pub fn pwm(&self) -> Option<u16> {
        (self.mode == Some(MODE_PWM)).then_some(self.state as u16)
    }

    /// The servo value (an angle when < 544), if the pin is in SERVO mode.
    #[must_use]
    pub fn servo(&self) -> Option<u16> {
        (self.mode == Some(MODE_SERVO)).then_some(self.state as u16)
    }

    fn pullup(&self) -> bool {
        matches!(self.mode, Some(MODE_INPUT | MODE_PULLUP)) && self.latch
    }
}

/// One continuous I2C read the board is streaming (`StandardFirmata`'s `query`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct I2cQuery {
    pub address: u8,
    /// `None` when the request carried no register.
    pub register: Option<u8>,
    pub length: usize,
}

/// The host → board stream parser, byte at a time like `FirmataParser::parse`:
/// a status byte starts a message, data bytes fill it, a sysex runs to `F7`.
#[derive(Debug, Default)]
struct Parser {
    status: u8,
    waiting: usize,
    data: Vec<u8>,
    sysex: Option<Vec<u8>>,
}

/// The scripted Firmata device. See the module docs.
#[derive(Debug)]
pub struct SimBoard {
    layout: BoardLayout,
    firmware_name: String,
    firmware_version: (u8, u8),
    extensions: Vec<Extension>,
    pins: Vec<SimPin>,
    /// `reportPINs`, `portConfigInputs`, `previousPINs`, per port.
    report_digital: Vec<bool>,
    port_inputs: Vec<u8>,
    previous_port: Vec<u8>,
    /// `analogInputsToReport`, per channel.
    report_analog: Vec<bool>,
    sampling_interval_ms: u32,
    i2c_enabled: bool,
    i2c_read_delay_us: u32,
    i2c_devices: BTreeMap<u8, SimI2cDevice>,
    i2c_queries: Vec<I2cQuery>,
    pixel: Option<PixelStrip>,
    steppers: BTreeMap<u8, SimStepper>,
    matrices: Vec<Max7219Chain>,
    parser: Parser,
    /// Bytes on their way to the host.
    tx: Vec<u8>,
    // --- scripted faults ---
    drop_bytes: usize,
    cut_sysex: Option<usize>,
    // --- what the board saw ---
    refused_sysex: Vec<u8>,
    violations: Vec<String>,
    strings: Vec<String>,
    boots: u32,
}

impl SimBoard {
    /// A freshly powered `StandardFirmata` board of `layout`: it has announced
    /// itself (`REPORT_VERSION` + `REPORT_FIRMWARE`, waiting in the output) and
    /// run its reset defaults — analog pins in ANALOG mode, digital pins OUTPUT
    /// low, nothing reporting.
    #[must_use]
    pub fn new(layout: BoardLayout) -> Self {
        let pins = layout.pins().iter().map(|&caps| SimPin { caps, ..SimPin::default() }).collect();
        let ports = layout.port_count();
        let mut board = Self {
            layout,
            firmware_name: "StandardFirmata.ino".to_string(),
            firmware_version: (2, 5),
            extensions: Vec::new(),
            pins,
            report_digital: vec![false; ports],
            port_inputs: vec![0; ports],
            previous_port: vec![0; ports],
            report_analog: vec![false; 16],
            sampling_interval_ms: 19,
            i2c_enabled: false,
            i2c_read_delay_us: 0,
            i2c_devices: BTreeMap::new(),
            i2c_queries: Vec::new(),
            pixel: None,
            steppers: BTreeMap::new(),
            matrices: Vec::new(),
            parser: Parser::default(),
            tx: Vec::new(),
            drop_bytes: 0,
            cut_sysex: None,
            refused_sysex: Vec::new(),
            violations: Vec::new(),
            strings: Vec::new(),
            boots: 0,
        };
        board.boot();
        board
    }

    /// Install a firmware extension (non-stock firmware).
    #[must_use]
    pub fn with_extension(mut self, extension: Extension) -> Self {
        self.extensions.push(extension);
        self
    }

    /// Rename the firmware; the boot announcement is re-issued under the new
    /// name.
    #[must_use]
    pub fn with_firmware(mut self, name: &str, major: u8, minor: u8) -> Self {
        self.firmware_name = name.to_string();
        self.firmware_version = (major, minor);
        self.tx.clear();
        self.send_version();
        self.send_firmware();
        self
    }

    // --- The byte seam -------------------------------------------------------

    /// Bytes from the host, in any chunking.
    pub fn receive(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.receive_byte(b);
        }
    }

    /// Bytes the board has sent since the last call, after the scripted
    /// output faults are applied.
    pub fn take_output(&mut self) -> Vec<u8> {
        let mut out = std::mem::take(&mut self.tx);
        if let Some(keep) = self.cut_sysex {
            if let Some(start) = out.iter().position(|&b| b == START_SYSEX) {
                if let Some(len) = out[start..].iter().position(|&b| b == END_SYSEX) {
                    let end = start + len;
                    let cut_from = (start + keep).min(end);
                    out.drain(cut_from..=end);
                    self.cut_sysex = None;
                }
            }
        }
        let dropped = self.drop_bytes.min(out.len());
        out.drain(..dropped);
        self.drop_bytes -= dropped;
        out
    }

    // --- The firmware's clock --------------------------------------------------

    /// One pass of the firmware's main loop: `checkDigitalInputs` (send every
    /// reporting port whose input bits changed) and finish pending stepper
    /// moves.
    pub fn run_loop(&mut self) {
        for port in 0..self.report_digital.len() {
            if self.report_digital[port] {
                let value = self.read_port(port);
                self.output_port(port, value, false);
            }
        }
        let done: Vec<(u8, i32)> = self
            .steppers
            .iter_mut()
            .filter(|(_, m)| m.target != m.position)
            .map(|(&device, m)| {
                m.position = m.target;
                (device, m.position)
            })
            .collect();
        for (device, position) in done {
            let mut frame = vec![START_SYSEX, ACCELSTEPPER_DATA, STEPPER_MOVE_COMPLETE, device];
            frame.extend(encode_stepper_long(position));
            frame.push(END_SYSEX);
            self.tx.extend(frame);
        }
    }

    /// One sampling interval elapsed: report every enabled analog channel whose
    /// pin is in ANALOG mode, then run every continuous I2C read.
    pub fn sample(&mut self) {
        for pin in 0..self.pins.len() {
            let p = &self.pins[pin];
            if let (Some(channel), Some(MODE_ANALOG)) = (p.caps.analog_channel, p.mode) {
                if self.report_analog[channel as usize] {
                    let value = p.analog_in;
                    self.send_analog(channel, value);
                }
            }
        }
        for query in self.i2c_queries.clone() {
            self.read_and_report(query.address, query.register, query.length);
        }
    }

    // --- Inputs ------------------------------------------------------------------

    /// Drive `pin` from outside (a button, a PIR output, a switch contact).
    pub fn drive_pin(&mut self, pin: u8, high: bool) {
        self.pins[pin as usize].external = Some(high);
    }

    /// Stop driving `pin`; it floats (reads its pull-up, else low).
    pub fn release_pin(&mut self, pin: u8) {
        self.pins[pin as usize].external = None;
    }

    /// Set what `analogRead` returns on `pin`.
    pub fn set_analog(&mut self, pin: u8, value: u16) {
        self.pins[pin as usize].analog_in = value;
    }

    /// The I2C device at `address`, attached (empty, answering) on first use.
    pub fn i2c_device(&mut self, address: u8) -> &mut SimI2cDevice {
        self.i2c_devices.entry(address).or_default()
    }

    /// Wire a chain of `count` MAX7219s to `data` / `clock` / `cs`; returns the
    /// chain's index for [`max7219`](Self::max7219).
    pub fn attach_max7219(&mut self, data: u8, clock: u8, cs: u8, count: usize) -> usize {
        self.matrices.push(Max7219Chain::new(data, clock, cs, count));
        self.matrices.len() - 1
    }

    // --- Faults ---------------------------------------------------------------

    /// Reboot mid-session (an AVR reset over a USB-serial chip keeps the port
    /// open): the firmware forgets every pin mode, report and I2C query, and
    /// announces itself again. Peripherals keep their own state.
    pub fn reset(&mut self) {
        for pin in &mut self.pins {
            *pin = SimPin { caps: pin.caps, external: pin.external, analog_in: pin.analog_in, ..SimPin::default() };
        }
        self.parser = Parser::default();
        self.sampling_interval_ms = 19;
        self.i2c_read_delay_us = 0;
        self.pixel = None;
        self.steppers.clear();
        self.boot();
    }

    /// Lose the next `n` bytes the board sends.
    pub fn drop_output_bytes(&mut self, n: usize) {
        self.drop_bytes += n;
    }

    /// Cut the next sysex frame the board sends after `keep` bytes (counting
    /// the `F0`): the rest of the frame, `F7` included, never arrives.
    pub fn cut_next_sysex(&mut self, keep: usize) {
        self.cut_sysex = Some(keep);
    }

    /// Put arbitrary bytes on the wire towards the host (line noise, a
    /// half-written frame).
    pub fn inject_output(&mut self, bytes: &[u8]) {
        self.tx.extend_from_slice(bytes);
    }

    // --- Board state -------------------------------------------------------------

    #[must_use]
    pub fn layout(&self) -> &BoardLayout {
        &self.layout
    }

    #[must_use]
    pub fn pin(&self, pin: u8) -> &SimPin {
        &self.pins[pin as usize]
    }

    #[must_use]
    pub fn is_reporting_digital(&self, port: u8) -> bool {
        self.report_digital.get(port as usize).copied().unwrap_or(false)
    }

    #[must_use]
    pub fn is_reporting_analog(&self, channel: u8) -> bool {
        self.report_analog.get(channel as usize).copied().unwrap_or(false)
    }

    #[must_use]
    pub fn sampling_interval_ms(&self) -> u32 {
        self.sampling_interval_ms
    }

    #[must_use]
    pub fn i2c_enabled(&self) -> bool {
        self.i2c_enabled
    }

    #[must_use]
    pub fn i2c_read_delay_us(&self) -> u32 {
        self.i2c_read_delay_us
    }

    /// The continuous reads the board is streaming, in query order.
    #[must_use]
    pub fn i2c_queries(&self) -> &[I2cQuery] {
        &self.i2c_queries
    }

    #[must_use]
    pub fn pixel_strip(&self) -> Option<&PixelStrip> {
        self.pixel.as_ref()
    }

    #[must_use]
    pub fn stepper(&self, device: u8) -> Option<&SimStepper> {
        self.steppers.get(&device)
    }

    #[must_use]
    pub fn max7219(&self, chain: usize) -> &Max7219Chain {
        &self.matrices[chain]
    }

    /// Sysex commands the firmware ignored because it lacks the extension.
    #[must_use]
    pub fn refused_sysex(&self) -> &[u8] {
        &self.refused_sysex
    }

    /// Writes the firmware accepted but silently ignored or would choke on.
    #[must_use]
    pub fn violations(&self) -> &[String] {
        &self.violations
    }

    /// `STRING_DATA` diagnostics the board sent.
    #[must_use]
    pub fn sent_strings(&self) -> &[String] {
        &self.strings
    }

    /// How many times the board has booted (1 after [`new`](Self::new)).
    #[must_use]
    pub fn boots(&self) -> u32 {
        self.boots
    }

    // --- Firmware internals -----------------------------------------------------

    /// `Firmata.begin` (announce) then `systemResetCallback` (defaults).
    fn boot(&mut self) {
        self.boots += 1;
        self.send_version();
        self.send_firmware();
        self.system_reset();
    }

    fn receive_byte(&mut self, b: u8) {
        if let Some(frame) = self.parser.sysex.as_mut() {
            if b == END_SYSEX {
                let frame = std::mem::take(frame);
                self.parser.sysex = None;
                self.on_sysex(&frame);
            } else {
                frame.push(b);
            }
            return;
        }
        if b < 0x80 {
            if self.parser.waiting > 0 {
                self.parser.data.push(b);
                self.parser.waiting -= 1;
                if self.parser.waiting == 0 {
                    let data = std::mem::take(&mut self.parser.data);
                    self.execute(self.parser.status, &data);
                }
            }
            return;
        }
        self.parser.status = b;
        self.parser.data.clear();
        self.parser.waiting = 0;
        let command = if b < 0xF0 { b & 0xF0 } else { b };
        match command {
            ANALOG_MESSAGE | DIGITAL_MESSAGE | PIN_MODE | SET_DIGITAL_PIN_VALUE => {
                self.parser.waiting = 2;
            }
            REPORT_ANALOG | REPORT_DIGITAL => self.parser.waiting = 1,
            START_SYSEX => self.parser.sysex = Some(Vec::new()),
            SYSTEM_RESET => self.system_reset(),
            PROTOCOL_VERSION => self.send_version(),
            _ => {}
        }
    }

    fn execute(&mut self, status: u8, data: &[u8]) {
        let value = u16::from(data[0]) | (u16::from(data.get(1).copied().unwrap_or(0)) << 7);
        let channel = status & 0x0F;
        match status & 0xF0 {
            DIGITAL_MESSAGE => self.digital_write_port(channel, value as u8),
            ANALOG_MESSAGE => self.analog_write(channel, value),
            REPORT_ANALOG => self.report_analog_channel(channel, data[0] != 0),
            REPORT_DIGITAL => self.report_digital_port(channel, data[0] != 0),
            _ => match status {
                PIN_MODE => self.set_pin_mode(data[0], data[1]),
                SET_DIGITAL_PIN_VALUE => {
                    if let Some(p) = self.pins.get(data[0] as usize) {
                        if p.mode == Some(MODE_OUTPUT) {
                            self.set_output(data[0], data[1] != 0);
                        }
                    }
                }
                _ => {}
            },
        }
    }

    fn on_sysex(&mut self, frame: &[u8]) {
        let Some((&command, argv)) = frame.split_first() else { return };
        let seven = |i: usize| -> u32 {
            u32::from(argv.get(i).copied().unwrap_or(0)) | (u32::from(argv.get(i + 1).copied().unwrap_or(0)) << 7)
        };
        match command {
            REPORT_FIRMWARE => self.send_firmware(),
            CAPABILITY_QUERY => self.send_capabilities(),
            ANALOG_MAPPING_QUERY => self.send_analog_mapping(),
            PIN_STATE_QUERY => {
                if let Some(&pin) = argv.first() {
                    self.send_pin_state(pin);
                }
            }
            EXTENDED_ANALOG => {
                if let Some(&pin) = argv.first() {
                    let mut value = 0u32;
                    for (i, &b) in argv[1..].iter().enumerate().take(4) {
                        value |= u32::from(b) << (7 * i);
                    }
                    self.analog_write(pin, value as u16);
                }
            }
            SAMPLING_INTERVAL => {
                if argv.len() > 1 {
                    self.sampling_interval_ms = seven(0).max(1);
                }
            }
            I2C_CONFIG => {
                let delay = seven(0);
                if argv.len() > 1 && delay > 0 {
                    self.i2c_read_delay_us = delay;
                }
                if !self.i2c_enabled {
                    self.enable_i2c();
                }
            }
            I2C_REQUEST => self.i2c_request(argv),
            PIXEL_COMMAND if self.extensions.contains(&Extension::Pixel) => {
                if !PixelStrip::apply(&mut self.pixel, argv) {
                    self.violations.push(format!("pixel frame not understood: {argv:02X?}"));
                }
            }
            ACCELSTEPPER_DATA if self.extensions.contains(&Extension::AccelStepper) => {
                if !SimStepper::apply(&mut self.steppers, argv) {
                    self.violations.push(format!("accelstepper frame not understood: {argv:02X?}"));
                }
            }
            other => self.refused_sysex.push(other),
        }
    }

    /// `systemResetCallback`.
    fn system_reset(&mut self) {
        if self.i2c_enabled {
            self.i2c_enabled = false;
            self.i2c_queries.clear();
        }
        self.report_digital.fill(false);
        self.port_inputs.fill(0);
        self.previous_port.fill(0);
        for pin in 0..self.pins.len() as u8 {
            let caps = self.pins[pin as usize].caps;
            if caps.analog_channel.is_some() {
                self.apply_pin_mode(pin, MODE_ANALOG, true);
            } else if caps.digital {
                self.apply_pin_mode(pin, MODE_OUTPUT, true);
            }
        }
        self.report_analog.fill(false);
    }

    fn set_pin_mode(&mut self, pin: u8, mode: u8) {
        self.apply_pin_mode(pin, mode, false);
    }

    /// `setPinModeCallback`. `resetting` mutes the immediate analog report.
    fn apply_pin_mode(&mut self, pin: u8, mode: u8, resetting: bool) {
        let Some(p) = self.pins.get(pin as usize) else {
            self.violations.push(format!("pin mode {mode} on pin {pin}, which this board does not have"));
            return;
        };
        let caps = p.caps;
        if p.mode == Some(MODE_I2C) && self.i2c_enabled && mode != MODE_I2C {
            self.i2c_enabled = false;
            self.i2c_queries.clear();
        }
        if let Some(channel) = caps.analog_channel {
            self.set_analog_report(channel, mode == MODE_ANALOG, resetting);
        }
        if caps.digital {
            let port = (pin / 8) as usize;
            let bit = 1u8 << (pin % 8);
            if matches!(mode, MODE_INPUT | MODE_PULLUP) {
                self.port_inputs[port] |= bit;
            } else {
                self.port_inputs[port] &= !bit;
            }
        }
        let was_high = self.pins[pin as usize].level();
        self.pins[pin as usize].state = 0;
        let known = matches!(
            mode,
            MODE_INPUT | MODE_OUTPUT | MODE_ANALOG | MODE_PWM | MODE_SERVO | MODE_I2C | MODE_PULLUP | 0x0A
        );
        if !known {
            self.send_string("Unknown pin mode");
            return;
        }
        if !caps.supports(mode) {
            self.violations.push(format!("pin {pin} does not support mode {mode}; the firmware ignores it"));
            return;
        }
        let p = &mut self.pins[pin as usize];
        match mode {
            // `pinMode(INPUT)` clears the latch; `analogWrite(pin, 0)` and the
            // `digitalWrite(LOW)` on leaving PWM drive it low.
            MODE_INPUT | MODE_ANALOG | MODE_PWM => p.latch = false,
            MODE_OUTPUT if p.mode == Some(MODE_PWM) => p.latch = false,
            MODE_PULLUP => {
                p.latch = true;
                p.state = 1;
            }
            _ => {}
        }
        p.mode = Some(mode);
        let now_high = p.level();
        if was_high != now_high {
            self.notify_edge(pin, now_high);
        }
    }

    /// `digitalWriteCallback`: only OUTPUT pins follow the port byte; an INPUT
    /// pin written 1 turns its pull-up on (legacy behaviour).
    fn digital_write_port(&mut self, port: u8, value: u8) {
        let first = port as usize * 8;
        for pin in first..(first + 8).min(self.pins.len()) {
            let level = value & (1 << (pin - first)) != 0;
            let p = &self.pins[pin];
            if !p.caps.digital {
                continue;
            }
            match p.mode {
                Some(MODE_OUTPUT) => self.set_output(pin as u8, level),
                Some(MODE_INPUT) => {
                    // Legacy pull-up: writing 1 to an INPUT runs `pinMode(INPUT_PULLUP)`.
                    let p = &mut self.pins[pin];
                    if level && p.state != 1 {
                        p.latch = true;
                    }
                    p.state = i32::from(level);
                }
                _ => {}
            }
        }
    }

    fn set_output(&mut self, pin: u8, level: bool) {
        let p = &mut self.pins[pin as usize];
        let was = p.latch;
        p.latch = level;
        p.state = i32::from(level);
        if was != level {
            self.notify_edge(pin, level);
        }
    }

    fn notify_edge(&mut self, pin: u8, rising: bool) {
        let level = |pins: &[SimPin], p: u8| pins.get(p as usize).is_some_and(SimPin::level);
        for chain in &mut self.matrices {
            let data = level(&self.pins, chain.data);
            let cs_low = !level(&self.pins, chain.cs);
            chain.on_edge(pin, rising, data, cs_low);
        }
    }

    /// `analogWriteCallback`: SERVO and PWM pins take the value; anything else
    /// is ignored by the firmware.
    fn analog_write(&mut self, pin: u8, value: u16) {
        let Some(p) = self.pins.get_mut(pin as usize) else {
            self.violations.push(format!("analog write to pin {pin}, which this board does not have"));
            return;
        };
        match p.mode {
            Some(MODE_SERVO | MODE_PWM) => p.state = i32::from(value),
            mode => self.violations.push(format!(
                "analog write {value} to pin {pin} in mode {mode:?}; the firmware ignores it"
            )),
        }
    }

    fn report_analog_channel(&mut self, channel: u8, enable: bool) {
        self.set_analog_report(channel, enable, false);
    }

    /// `reportAnalogCallback`: enabling sends the current reading at once.
    fn set_analog_report(&mut self, channel: u8, enable: bool, resetting: bool) {
        let Some(pin) = self.layout.analog_pin(channel) else { return };
        self.report_analog[channel as usize] = enable;
        if enable && !resetting {
            let value = self.pins[pin as usize].analog_in;
            self.send_analog(channel, value);
        }
    }

    /// `reportDigitalCallback`: enabling sends the port at once.
    fn report_digital_port(&mut self, port: u8, enable: bool) {
        let port = port as usize;
        if port >= self.report_digital.len() {
            return;
        }
        self.report_digital[port] = enable;
        if enable {
            let value = self.read_port(port);
            self.output_port(port, value, true);
        }
    }

    /// `readPort(port, portConfigInputs[port])`.
    fn read_port(&self, port: usize) -> u8 {
        let mut out = 0u8;
        for bit in 0..8 {
            let pin = port * 8 + bit;
            if let Some(p) = self.pins.get(pin) {
                if p.caps.digital && self.port_inputs[port] & (1 << bit) != 0 && p.level() {
                    out |= 1 << bit;
                }
            }
        }
        out
    }

    /// `outputPort`.
    fn output_port(&mut self, port: usize, value: u8, force: bool) {
        let value = value & self.port_inputs[port];
        if force || self.previous_port[port] != value {
            self.tx.extend([DIGITAL_MESSAGE | port as u8, value & 0x7F, value >> 7]);
            self.previous_port[port] = value;
        }
    }

    fn enable_i2c(&mut self) {
        for pin in 0..self.pins.len() as u8 {
            if self.pins[pin as usize].caps.i2c {
                self.apply_pin_mode(pin, MODE_I2C, false);
            }
        }
        self.i2c_enabled = true;
    }

    /// The `I2C_REQUEST` branch of `sysexCallback`.
    fn i2c_request(&mut self, argv: &[u8]) {
        let (Some(&address), Some(&flags)) = (argv.first(), argv.get(1)) else { return };
        if flags & 0x20 != 0 {
            self.send_string("10-bit addressing not supported");
            return;
        }
        if !self.i2c_enabled {
            self.violations.push(format!("I2C request to 0x{address:02X} before I2C_CONFIG"));
        }
        let seven = |i: usize| -> usize {
            usize::from(argv.get(i).copied().unwrap_or(0)) | (usize::from(argv.get(i + 1).copied().unwrap_or(0)) << 7)
        };
        let (register, length) = if argv.len() == 6 {
            (Some(seven(2) as u8), seven(4))
        } else {
            (None, seven(2))
        };
        match flags & 0x18 {
            0x00 => {
                let data: Vec<u8> = argv[2..].chunks(2).map(|c| c[0] | (c.get(1).copied().unwrap_or(0) << 7)).collect();
                if let Some(device) = self.i2c_devices.get_mut(&address) {
                    device.write(&data);
                }
            }
            0x08 => self.read_and_report(address, register, length),
            0x10 => {
                if self.i2c_queries.len() >= I2C_MAX_QUERIES {
                    self.send_string("too many queries");
                } else {
                    self.i2c_queries.push(I2cQuery { address, register, length });
                }
            }
            _ => {
                // STOP_READING: with one query left it is cleared whatever the
                // address; otherwise the first match goes (index 0 if none).
                if self.i2c_queries.len() <= 1 {
                    self.i2c_queries.clear();
                } else {
                    let skip = self.i2c_queries.iter().position(|q| q.address == address).unwrap_or(0);
                    self.i2c_queries.remove(skip);
                }
            }
        }
    }

    /// `readAndReportData`.
    fn read_and_report(&mut self, address: u8, register: Option<u8>, length: usize) {
        let available = match self.i2c_devices.get_mut(&address) {
            Some(device) if !device.is_nacking() => device.read(register, length.min(WIRE_BUFFER)),
            _ => Vec::new(),
        };
        if length > available.len() {
            self.send_string("I2C: Too few bytes received");
        }
        let register = u16::from(register.unwrap_or(0));
        let mut frame = vec![
            START_SYSEX,
            I2C_REPLY,
            address & 0x7F,
            address >> 7,
            (register & 0x7F) as u8,
            (register >> 7) as u8,
        ];
        for b in available {
            frame.extend([b & 0x7F, b >> 7]);
        }
        frame.push(END_SYSEX);
        self.tx.extend(frame);
    }

    // --- Board → host encoders --------------------------------------------------

    fn send_version(&mut self) {
        self.tx.extend([PROTOCOL_VERSION, 2, 5]);
    }

    /// `printFirmwareVersion`: the name goes out as 7-bit pairs.
    fn send_firmware(&mut self) {
        let (major, minor) = self.firmware_version;
        let mut frame = vec![START_SYSEX, REPORT_FIRMWARE, major, minor];
        for b in self.firmware_name.bytes() {
            frame.extend([b & 0x7F, b >> 7]);
        }
        frame.push(END_SYSEX);
        self.tx.extend(frame);
    }

    /// `CAPABILITY_RESPONSE`. An installed extension advertises its mode on
    /// every digital pin, as Microflow's `StandardFirmata` does for Pixel and
    /// `AccelStepperFirmata::handleCapability` does for steppers.
    fn send_capabilities(&mut self) {
        let mut frame = vec![START_SYSEX, CAPABILITY_RESPONSE];
        for pin in &self.pins {
            for (mode, resolution) in pin.caps.modes() {
                frame.extend([mode, resolution]);
            }
            if pin.caps.digital {
                for extension in &self.extensions {
                    frame.extend(match extension {
                        Extension::Pixel => [super::PIN_MODE_PIXEL, 1],
                        Extension::AccelStepper => [super::PIN_MODE_STEPPER, 21],
                    });
                }
            }
            frame.push(127);
        }
        frame.push(END_SYSEX);
        self.tx.extend(frame);
    }

    fn send_analog_mapping(&mut self) {
        let mut frame = vec![START_SYSEX, ANALOG_MAPPING_RESPONSE];
        frame.extend(self.pins.iter().map(|p| p.caps.analog_channel.unwrap_or(127)));
        frame.push(END_SYSEX);
        self.tx.extend(frame);
    }

    fn send_pin_state(&mut self, pin: u8) {
        let Some(p) = self.pins.get(pin as usize) else { return };
        let mut frame = vec![START_SYSEX, PIN_STATE_RESPONSE, pin, p.mode.unwrap_or(0x7F)];
        let mut state = p.state as u32;
        loop {
            frame.push((state & 0x7F) as u8);
            state >>= 7;
            if state == 0 {
                break;
            }
        }
        frame.push(END_SYSEX);
        self.tx.extend(frame);
    }

    /// `sendAnalog`: channels past 15 go out as `EXTENDED_ANALOG`.
    fn send_analog(&mut self, channel: u8, value: u16) {
        if channel <= 15 {
            self.tx.extend([ANALOG_MESSAGE | channel, (value & 0x7F) as u8, (value >> 7) as u8 & 0x7F]);
        } else {
            self.tx.extend([
                START_SYSEX,
                EXTENDED_ANALOG,
                channel,
                (value & 0x7F) as u8,
                (value >> 7) as u8 & 0x7F,
                END_SYSEX,
            ]);
        }
    }

    fn send_string(&mut self, s: &str) {
        self.strings.push(s.to_string());
        let mut frame = vec![START_SYSEX, STRING_DATA];
        for b in s.bytes() {
            frame.extend([b & 0x7F, b >> 7]);
        }
        frame.push(END_SYSEX);
        self.tx.extend(frame);
    }
}

/// firmata.js's `encode32BitSignedInteger` — the encoder matching
/// [`decode_stepper_long`].
#[must_use]
pub fn encode_stepper_long(value: i32) -> [u8; 5] {
    let magnitude = value.unsigned_abs();
    let mut out = [
        (magnitude & 0x7F) as u8,
        ((magnitude >> 7) & 0x7F) as u8,
        ((magnitude >> 14) & 0x7F) as u8,
        ((magnitude >> 21) & 0x7F) as u8,
        ((magnitude >> 28) & 0x07) as u8,
    ];
    if value < 0 {
        out[4] |= 0x08;
    }
    out
}
