//! Board layouts for the simulated board — which pins exist and what each one
//! can do, transcribed from `StandardFirmata`'s `Boards.h` (`IS_PIN_DIGITAL`,
//! `IS_PIN_ANALOG`, `IS_PIN_PWM`, `IS_PIN_SERVO`, `IS_PIN_I2C`, `PIN_TO_ANALOG`).
//!
//! A layout is the whole answer to "what would this board say in its
//! `CAPABILITY_RESPONSE` and `ANALOG_MAPPING_RESPONSE`", so the sim can answer the
//! handshake for any board and tests can run the same flow against an Uno, a
//! Mega 2560 and a Leonardo — the three boards whose analog channels start at
//! three different Firmata pins (14, 54, 18).

use crate::firmata::{MODE_ANALOG, MODE_I2C, MODE_INPUT, MODE_OUTPUT, MODE_PULLUP, MODE_PWM, MODE_SERVO};

/// What one Firmata pin can do. A pin with no capability at all (the Uno's
/// serial pins 0/1) still occupies a slot in the pin table — Firmata pin
/// numbers are positional.
// One flag per `Boards.h` capability macro; an enum set would hide the 1:1 map.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PinCaps {
    /// `IS_PIN_DIGITAL`: INPUT, PULLUP and OUTPUT.
    pub digital: bool,
    /// `PIN_TO_ANALOG`: the analog channel this pin reads, if it is analog.
    pub analog_channel: Option<u8>,
    /// `IS_PIN_PWM`.
    pub pwm: bool,
    /// SERVO. Microflow's bundled `StandardFirmata` advertises and accepts it
    /// on every digital pin (`setPinModeCallback` checks only
    /// `IS_PIN_DIGITAL`; the limit is `MAX_SERVOS` attached at once, not
    /// which pin), so the layouts set it wherever `digital` is.
    pub servo: bool,
    /// `IS_PIN_I2C` (SDA/SCL).
    pub i2c: bool,
}

impl PinCaps {
    /// The `(mode, resolution)` pairs this pin advertises in the capability
    /// response, in `StandardFirmata`'s order.
    #[must_use]
    pub fn modes(&self) -> Vec<(u8, u8)> {
        let mut modes = Vec::new();
        if self.digital {
            modes.extend([(MODE_INPUT, 1), (MODE_PULLUP, 1), (MODE_OUTPUT, 1)]);
        }
        if self.analog_channel.is_some() {
            modes.push((MODE_ANALOG, 10));
        }
        if self.pwm {
            modes.push((MODE_PWM, 8));
        }
        if self.servo {
            modes.push((MODE_SERVO, 14));
        }
        if self.i2c {
            modes.push((MODE_I2C, 1));
        }
        modes
    }

    /// Whether the firmware would accept `SET_PIN_MODE(mode)` on this pin.
    #[must_use]
    pub fn supports(&self, mode: u8) -> bool {
        self.modes().iter().any(|&(m, _)| m == mode)
    }
}

/// A board's pin table. Build one with [`BoardLayout::uno`],
/// [`BoardLayout::mega2560`] or [`BoardLayout::leonardo`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardLayout {
    name: &'static str,
    pins: Vec<PinCaps>,
}

impl BoardLayout {
    /// Arduino Uno / Nano (`ATmega328P`): 20 pins, A0..A5 = pins 14..19, PWM on
    /// 3/5/6/9/10/11, I2C on A4/A5 (18/19), servos on every digital pin, serial
    /// on 0/1.
    #[must_use]
    pub fn uno() -> Self {
        let pins = (0u8..20)
            .map(|p| PinCaps {
                digital: (2..=19).contains(&p),
                analog_channel: (14..20).contains(&p).then(|| p - 14),
                pwm: matches!(p, 3 | 5 | 6 | 9 | 10 | 11),
                servo: (2..=19).contains(&p),
                i2c: matches!(p, 18 | 19),
            })
            .collect();
        Self { name: "uno", pins }
    }

    /// Arduino Mega 2560: 70 pins, A0..A15 = pins 54..69, PWM on 2..13 and
    /// 44..46, I2C on 20/21, servos on every digital pin, serial on 0/1.
    #[must_use]
    pub fn mega2560() -> Self {
        let pins = (0u8..70)
            .map(|p| PinCaps {
                digital: p >= 2,
                analog_channel: (p >= 54).then(|| p - 54),
                pwm: (2..=13).contains(&p) || (44..=46).contains(&p),
                servo: p >= 2,
                i2c: matches!(p, 20 | 21),
            })
            .collect();
        Self { name: "mega2560", pins }
    }

    /// Arduino Leonardo (`ATmega32U4`): 30 pins, A0..A11 = pins 18..29, PWM on
    /// 3/5/6/9/10/11/13, I2C on 2/3, servos on every pin.
    #[must_use]
    pub fn leonardo() -> Self {
        let pins = (0u8..30)
            .map(|p| PinCaps {
                digital: true,
                analog_channel: (p >= 18).then(|| p - 18),
                pwm: matches!(p, 3 | 5 | 6 | 9 | 10 | 11 | 13),
                servo: true,
                i2c: matches!(p, 2 | 3),
            })
            .collect();
        Self { name: "leonardo", pins }
    }

    #[must_use]
    pub fn name(&self) -> &'static str {
        self.name
    }

    /// Number of Firmata pins (`TOTAL_PINS`).
    #[must_use]
    pub fn pin_count(&self) -> usize {
        self.pins.len()
    }

    /// Capabilities of `pin`; a pin past the table has none.
    #[must_use]
    pub fn caps(&self, pin: u8) -> PinCaps {
        self.pins.get(pin as usize).copied().unwrap_or_default()
    }

    /// The Firmata pin that reads analog channel `channel` (`A{channel}`).
    #[must_use]
    pub fn analog_pin(&self, channel: u8) -> Option<u8> {
        self.pins
            .iter()
            .position(|caps| caps.analog_channel == Some(channel))
            .map(|p| p as u8)
    }

    /// Number of 8-pin ports (`TOTAL_PORTS`).
    #[must_use]
    pub fn port_count(&self) -> usize {
        self.pins.len().div_ceil(8)
    }

    pub(crate) fn pins(&self) -> &[PinCaps] {
        &self.pins
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analog_channel_zero_lands_on_a_different_pin_per_board() {
        assert_eq!(BoardLayout::uno().analog_pin(0), Some(14));
        assert_eq!(BoardLayout::mega2560().analog_pin(0), Some(54));
        assert_eq!(BoardLayout::leonardo().analog_pin(0), Some(18));
        assert_eq!(BoardLayout::uno().analog_pin(6), None);
        assert_eq!(BoardLayout::mega2560().analog_pin(15), Some(69));
    }

    #[test]
    fn uno_serial_pins_advertise_nothing_and_pwm_pins_advertise_pwm() {
        let uno = BoardLayout::uno();
        assert!(uno.caps(0).modes().is_empty(), "{:?}", uno.caps(0).modes());
        assert!(uno.caps(9).supports(MODE_PWM));
        assert!(!uno.caps(13).supports(MODE_PWM));
        assert!(uno.caps(18).supports(MODE_I2C));
        assert!(uno.caps(14).supports(MODE_SERVO), "servo on any digital pin");
        assert!(!uno.caps(0).supports(MODE_SERVO));
        assert_eq!(uno.port_count(), 3);
        assert_eq!(BoardLayout::mega2560().port_count(), 9);
    }
}
