//! Proximity Node config — shared by the live runtime and the codegen emitter.
//!
//! The analog pin (`"A0"` or a pin number), the sensor controller model, and
//! the sampling frequency — and what the controller makes of a reading:
//! [`Ranging`], the one conversion to centimetres both halves apply.

use crate::config::serde_utils;
use crate::firmata::PinLabel;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProximityConfig {
    /// The analog pin as the Node names it: `"A0"` (the default the editor
    /// keeps until a pin is picked) or a pin number. Only the board can turn
    /// `A<n>` into a pin, so each half resolves this one label against its
    /// board: the runtime against the connected board's pin profile, the
    /// emitter against the board target.
    #[serde(
        default = "default_pin",
        deserialize_with = "serde_utils::deserialize_analog_pin",
        serialize_with = "serde_utils::serialize_analog_pin"
    )]
    pub(crate) pin: PinLabel,
    #[serde(default = "default_controller")]
    pub(crate) controller: String,
    #[serde(default = "default_freq", deserialize_with = "serde_utils::deserialize_whole")]
    pub(crate) freq: u32,
}

fn default_pin() -> PinLabel {
    PinLabel::Analog(0)
}
fn default_controller() -> String {
    "GP2Y0A21YK".to_string()
}
fn default_freq() -> u32 {
    25
}

/// The smallest move, in centimetres, a Proximity hands on: a distance within
/// this of the one it last handed on is not a new distance.
pub(crate) const MIN_MOVE_CM: f64 = 1.0;

/// How a controller turns a raw analog reading (`0..=1023`) into centimetres.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Ranging {
    /// A Sharp infrared sensor. Its output voltage (the reading over a 5 V,
    /// 1024-step scale) falls as the distance grows: the distance is
    /// `scale / (volts - offset)`, kept between `near` and `far`, and `far`
    /// when the voltage is at or below `offset` (nothing in range).
    Infrared { scale: f64, offset: f64, near: f64, far: f64 },
    /// The reading times `numerator`, over `denominator`, kept between `near`
    /// and `far`.
    Linear { numerator: f64, denominator: f64, near: f64, far: f64 },
}

impl Ranging {
    /// The volts a reading stands for: `raw * VOLTS / STEPS`.
    pub(crate) const VOLTS: f64 = 5.0;
    pub(crate) const STEPS: f64 = 1024.0;

    /// The distance `raw` stands for, in centimetres. Read by the live node
    /// (the sketch writes the same formula in C++).
    #[cfg(feature = "runtime")]
    #[must_use]
    pub(crate) fn centimetres(self, raw: u16) -> f64 {
        let raw = f64::from(raw);
        match self {
            Self::Infrared { scale, offset, near, far } => {
                let volts = raw * Self::VOLTS / Self::STEPS;
                if volts > offset {
                    (scale / (volts - offset)).clamp(near, far)
                } else {
                    far
                }
            }
            Self::Linear { numerator, denominator, near, far } => (raw * numerator / denominator).clamp(near, far),
        }
    }
}

impl ProximityConfig {
    /// What this Node's controller makes of a reading. A controller this list
    /// does not name scales the reading to 0–200 cm.
    #[must_use]
    pub(crate) fn ranging(&self) -> Ranging {
        match self.controller.as_str() {
            "GP2Y0A21YK" => Ranging::Infrared { scale: 27.86, offset: 0.42, near: 10.0, far: 80.0 },
            "GP2Y0A02YK0F" => Ranging::Infrared { scale: 60.0, offset: 0.4, near: 20.0, far: 150.0 },
            "HCSR04" => Ranging::Linear { numerator: 1.0, denominator: 58.0, near: 2.0, far: 400.0 },
            _ => Ranging::Linear { numerator: 200.0, denominator: 1023.0, near: 0.0, far: 200.0 },
        }
    }
}
