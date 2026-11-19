//! Sensor Node config — shared by the live runtime and the codegen emitter.
//!
//! The analog pin (`"A0"` or a pin number), the read mode, the sampling
//! frequency and the change threshold.

use crate::config::serde_utils;
use crate::firmata::PinLabel;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SensorType {
    #[default]
    Analog,
    Digital,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SensorConfig {
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
    #[serde(default)]
    pub(crate) r#type: SensorType,
    #[serde(default = "default_freq", deserialize_with = "serde_utils::deserialize_whole")]
    pub(crate) freq: u32,
    #[serde(default = "default_threshold", deserialize_with = "serde_utils::deserialize_whole")]
    pub(crate) threshold: u16,
}

fn default_pin() -> PinLabel {
    PinLabel::Analog(0)
}
fn default_freq() -> u32 {
    25
}
fn default_threshold() -> u16 {
    1
}

impl Default for SensorConfig {
    fn default() -> Self {
        Self {
            pin: default_pin(),
            r#type: SensorType::default(),
            freq: default_freq(),
            threshold: default_threshold(),
        }
    }
}
