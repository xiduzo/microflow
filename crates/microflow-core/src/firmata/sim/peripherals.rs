//! What hangs off the simulated board's pins and bus: an I2C device, a MAX7219
//! LED-matrix chain, and the state the two non-stock firmware extensions keep
//! (a WS2812 strip behind node-pixel's sysex `0x51`, `AccelStepper` motors behind
//! `ConfigurableFirmata`'s sysex `0x62`). Each one decodes what the firmware
//! would hand it and keeps the result as plain state a test can assert on.

use std::collections::BTreeMap;

/// A register-mapped I2C device on the simulated bus. Reads return
/// `registers[reg..reg + n]` (missing bytes read as 0); writes of `[reg, data..]`
/// store `data` from `reg` on and move the read pointer to `reg`, like most
/// auto-incrementing sensors.
#[derive(Debug, Clone, Default)]
pub struct SimI2cDevice {
    registers: BTreeMap<u8, u8>,
    /// Where a read with no register lands (the last register written).
    pointer: u8,
    /// Every write the device received, as raw bytes (register first).
    writes: Vec<Vec<u8>>,
    /// Whether the device ignores its address — a scripted bus fault. Such a
    /// device returns no bytes, so the firmware answers with an empty
    /// `I2C_REPLY`.
    nack: bool,
}

impl SimI2cDevice {
    /// Store `bytes` starting at register `reg`.
    pub fn set_registers(&mut self, reg: u8, bytes: &[u8]) -> &mut Self {
        for (i, &b) in bytes.iter().enumerate() {
            self.registers.insert(reg.wrapping_add(i as u8), b);
        }
        self
    }

    /// Script the device to stop (or resume) acknowledging its address.
    pub fn set_nack(&mut self, nack: bool) -> &mut Self {
        self.nack = nack;
        self
    }

    /// Every write the device has received, register byte first.
    #[must_use]
    pub fn writes(&self) -> &[Vec<u8>] {
        &self.writes
    }

    pub(crate) fn is_nacking(&self) -> bool {
        self.nack
    }

    pub(crate) fn write(&mut self, data: &[u8]) {
        if self.nack {
            return;
        }
        self.writes.push(data.to_vec());
        if let Some((&reg, rest)) = data.split_first() {
            self.pointer = reg;
            for (i, &b) in rest.iter().enumerate() {
                self.registers.insert(reg.wrapping_add(i as u8), b);
            }
        }
    }

    /// `numBytes` read from `register` (or from the pointer when the request
    /// carried no register). Empty when the device NACKs.
    pub(crate) fn read(&mut self, register: Option<u8>, len: usize) -> Vec<u8> {
        if self.nack {
            return Vec::new();
        }
        let start = register.unwrap_or(self.pointer);
        (0..len)
            .map(|i| self.registers.get(&start.wrapping_add(i as u8)).copied().unwrap_or(0))
            .collect()
    }
}

/// One MAX7219 in a daisy chain: the eight row registers plus the control
/// registers `LedControl` initialises.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Max7219 {
    /// Digit/row registers 1..=8 (index 0 = row 1).
    pub rows: [u8; 8],
    pub decode_mode: u8,
    pub intensity: u8,
    pub scan_limit: u8,
    /// `true` once the shutdown register is written 1 (normal operation).
    pub on: bool,
    pub display_test: bool,
}

impl Max7219 {
    fn latch(&mut self, word: u16) {
        let [opcode, data] = word.to_be_bytes();
        match opcode & 0x0F {
            0x00 => {} // no-op: addresses another device in the chain
            row @ 0x01..=0x08 => self.rows[(row - 1) as usize] = data,
            0x09 => self.decode_mode = data,
            0x0A => self.intensity = data,
            0x0B => self.scan_limit = data,
            0x0C => self.on = data & 1 == 1,
            0x0F => self.display_test = data & 1 == 1,
            _ => {}
        }
    }
}

/// A MAX7219 chain wired to three digital pins and clocked by the levels the
/// firmware drives on them: data is sampled on the clock's rising edge into a
/// 16-bit shift register per device (device 0 is nearest the board, so the
/// first word shifted ends in the last device), and every device latches its
/// word on the chip-select rising edge.
#[derive(Debug, Clone)]
pub struct Max7219Chain {
    pub(crate) data: u8,
    pub(crate) clock: u8,
    pub(crate) cs: u8,
    shift: Vec<u16>,
    devices: Vec<Max7219>,
}

impl Max7219Chain {
    pub(crate) fn new(data: u8, clock: u8, cs: u8, count: usize) -> Self {
        Self { data, clock, cs, shift: vec![0; count], devices: vec![Max7219::default(); count] }
    }

    /// The latched state of device `index` (0 = nearest the board).
    #[must_use]
    pub fn device(&self, index: usize) -> &Max7219 {
        &self.devices[index]
    }

    /// React to one pin's level change. `data_level` is the current level of
    /// the data pin.
    pub(crate) fn on_edge(&mut self, pin: u8, rising: bool, data_level: bool, cs_low: bool) {
        if pin == self.clock && rising && cs_low {
            let mut carry = u16::from(data_level);
            for reg in &mut self.shift {
                let out = *reg >> 15;
                *reg = (*reg << 1) | carry;
                carry = out;
            }
        } else if pin == self.cs && rising {
            for (device, &word) in self.devices.iter_mut().zip(&self.shift) {
                device.latch(word);
            }
        }
    }
}

/// node-pixel colour order, from the top bits of the config pin byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorOrder {
    Grb,
    Rgb,
    Brg,
}

/// A WS2812 strip configured through node-pixel's `PIXEL_COMMAND` (`0x51`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PixelStrip {
    pub pin: u8,
    pub color_order: ColorOrder,
    /// The frame buffer, packed `0xRRGGBB`, as `SET_PIXEL`/`SET_STRIP` left it.
    pub buffer: Vec<u32>,
    /// What the LEDs show: the buffer as of the last `SHOW`.
    pub shown: Vec<u32>,
}

impl PixelStrip {
    /// Apply one `PIXEL_COMMAND` payload (sub-command first). Returns `false`
    /// for a frame the extension does not understand.
    pub(crate) fn apply(strip: &mut Option<PixelStrip>, data: &[u8]) -> bool {
        let seven = |lo: u8, hi: u8| u32::from(lo) | (u32::from(hi) << 7);
        if let [0x01, pin_byte, len_lo, len_hi, ..] = data {
            let len = seven(*len_lo, *len_hi) as usize;
            let color_order = match pin_byte >> 5 {
                1 => ColorOrder::Rgb,
                2 => ColorOrder::Brg,
                _ => ColorOrder::Grb,
            };
            *strip = Some(PixelStrip {
                pin: pin_byte & 0x1F,
                color_order,
                buffer: vec![0; len],
                shown: vec![0; len],
            });
            return true;
        }
        let Some(s) = strip.as_mut() else { return false };
        match data {
            [0x00, ..] => s.buffer.fill(0),
            [0x02, ..] => s.shown.clone_from(&s.buffer),
            [0x03, i_lo, i_hi, c0, c1, c2, c3, ..] => {
                let index = seven(*i_lo, *i_hi) as usize;
                let color = seven(*c0, *c1) | (seven(*c2, *c3) << 14);
                if let Some(px) = s.buffer.get_mut(index) {
                    *px = color & 0x00FF_FFFF;
                }
            }
            [0x04, c0, c1, c2, c3, ..] => {
                let color = seven(*c0, *c1) | (seven(*c2, *c3) << 14);
                s.buffer.fill(color & 0x00FF_FFFF);
            }
            [0x05, shift, ..] => {
                let amount = (shift & 0x1F) as usize;
                let forward = shift & 0x20 != 0;
                let len = s.buffer.len();
                if len > 0 {
                    if forward {
                        s.buffer.rotate_right(amount % len);
                    } else {
                        s.buffer.rotate_left(amount % len);
                    }
                }
            }
            _ => return false,
        }
        true
    }
}

/// `AccelStepper` wiring, from the config byte's interface bits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepperInterface {
    Driver,
    TwoWire,
    ThreeWire,
    FourWire,
}

/// One `AccelStepper` motor as `ConfigurableFirmata` would hold it.
///
/// **Simplified motion.** There is no speed profile: a move completes on the
/// board's next main-loop pass, and `stop` halts the motor where it stands
/// (target = position). Real `AccelStepper::stop` decelerates, overrunning by
/// the stopping distance `v² / 2a` — a test that cares about where a stopped
/// motor ends up cannot use this model.
#[derive(Debug, Clone, PartialEq)]
pub struct SimStepper {
    pub interface: StepperInterface,
    pub pins: Vec<u8>,
    pub has_enable_pin: bool,
    pub enabled: bool,
    pub position: i32,
    pub target: i32,
    pub max_speed: f32,
    pub acceleration: f32,
}

/// The `AccelStepperFirmata` decoder for a sign-magnitude step count: 28 bits
/// of magnitude in four 7-bit bytes and the sign in bit 3 of the fifth byte
/// (the sign position is inferred from firmata.js `encode32BitSignedInteger`).
/// The fifth byte's low bits are not part of the magnitude, so a larger count
/// wraps — the runtime clamps to `±(2^28 − 1)`.
#[must_use]
pub fn decode_stepper_long(b: [u8; 5]) -> i32 {
    let magnitude = i64::from(b[0])
        | (i64::from(b[1]) << 7)
        | (i64::from(b[2]) << 14)
        | (i64::from(b[3]) << 21);
    let value = if b[4] & 0x08 != 0 { -magnitude } else { magnitude };
    value as i32
}

/// The `ConfigurableFirmata` decoder for `AccelStepper`'s custom float: a 23-bit
/// significand, a 4-bit exponent biased by 11 (power of ten) and a sign in bit
/// 6 of the last byte.
#[must_use]
pub fn decode_stepper_float(b: [u8; 4]) -> f32 {
    let significand = u32::from(b[0])
        | (u32::from(b[1]) << 7)
        | (u32::from(b[2]) << 14)
        | (u32::from(b[3] & 0x03) << 21);
    let exponent = i32::from((b[3] >> 2) & 0x0F) - 11;
    let magnitude = significand as f32 * 10f32.powi(exponent);
    if b[3] & 0x40 != 0 {
        -magnitude
    } else {
        magnitude
    }
}

impl SimStepper {
    /// Apply one `ACCELSTEPPER_DATA` payload (sub-command first) to the motor
    /// table. Returns `false` for a frame the extension does not understand.
    pub(crate) fn apply(steppers: &mut BTreeMap<u8, SimStepper>, data: &[u8]) -> bool {
        let long = |s: &[u8]| -> Option<i32> {
            Some(decode_stepper_long([*s.first()?, *s.get(1)?, *s.get(2)?, *s.get(3)?, *s.get(4)?]))
        };
        let float = |s: &[u8]| -> Option<f32> {
            Some(decode_stepper_float([*s.first()?, *s.get(1)?, *s.get(2)?, *s.get(3)?]))
        };
        match data {
            [0x00, device, iface, rest @ ..] => {
                let interface = match (iface >> 4) & 0x07 {
                    1 => StepperInterface::Driver,
                    2 => StepperInterface::TwoWire,
                    3 => StepperInterface::ThreeWire,
                    _ => StepperInterface::FourWire,
                };
                let pin_count = match interface {
                    StepperInterface::Driver | StepperInterface::TwoWire => 2,
                    StepperInterface::ThreeWire => 3,
                    StepperInterface::FourWire => 4,
                };
                let has_enable_pin = iface & 0x01 == 1;
                let wanted = pin_count + usize::from(has_enable_pin);
                if rest.len() < wanted {
                    return false;
                }
                steppers.insert(
                    *device,
                    SimStepper {
                        interface,
                        pins: rest[..wanted].to_vec(),
                        has_enable_pin,
                        enabled: true,
                        position: 0,
                        target: 0,
                        max_speed: 0.0,
                        acceleration: 0.0,
                    },
                );
                true
            }
            [cmd, device, rest @ ..] => {
                let Some(m) = steppers.get_mut(device) else { return false };
                match cmd {
                    0x01 => {
                        m.position = 0;
                        m.target = 0;
                    }
                    0x02 => match long(rest) {
                        Some(steps) => m.target = m.position.saturating_add(steps),
                        None => return false,
                    },
                    0x03 => match long(rest) {
                        Some(to) => m.target = to,
                        None => return false,
                    },
                    0x04 => m.enabled = rest.first().is_some_and(|&b| b != 0),
                    0x05 => m.target = m.position,
                    0x08 => match float(rest) {
                        Some(a) => m.acceleration = a,
                        None => return false,
                    },
                    0x09 => match float(rest) {
                        Some(s) => m.max_speed = s,
                        None => return false,
                    },
                    _ => return false,
                }
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stepper_long_is_sign_magnitude() {
        // firmata.js `encode32BitSignedInteger(-100)`: magnitude + sign bit 3.
        assert_eq!(decode_stepper_long([100, 0, 0, 0, 0x08]), -100);
        assert_eq!(decode_stepper_long([0x7F, 0x7F, 0, 0, 0]), 16383);
    }

    #[test]
    fn stepper_float_reads_significand_exponent_and_sign() {
        // 200.0 = 200 * 10^0 → exponent bits 11.
        assert!((decode_stepper_float([0x48, 1, 0, 11 << 2]) - 200.0).abs() < 1e-3);
        // -1.5 = 15 * 10^-1, sign bit 6.
        assert!((decode_stepper_float([15, 0, 0, (10 << 2) | 0x40]) + 1.5).abs() < 1e-6);
    }

    #[test]
    fn max7219_chain_routes_the_last_word_to_the_nearest_device() {
        let mut chain = Max7219Chain::new(2, 3, 4, 2);
        let shift_word = |chain: &mut Max7219Chain, word: u16| {
            for i in (0..16).rev() {
                chain.on_edge(3, true, (word >> i) & 1 == 1, true);
            }
        };
        // Far device first, then the near one, then latch.
        shift_word(&mut chain, 0x0155);
        shift_word(&mut chain, 0x02AA);
        chain.on_edge(4, true, false, false);
        assert_eq!(chain.device(0).rows[1], 0xAA);
        assert_eq!(chain.device(1).rows[0], 0x55);
    }
}
