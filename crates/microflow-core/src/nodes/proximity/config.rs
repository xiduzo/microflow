//! Proximity Node config — shared by the live runtime and the codegen emitter.
//!
//! The analog pin (stored as a string, `"A0"` or a numeric pin), the sensor
//! controller model, and the sampling frequency.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProximityConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_string_or_number")]
    pub(crate) pin: String,
    #[serde(default = "default_controller")]
    pub(crate) controller: String,
    #[serde(default = "default_freq")]
    pub(crate) freq: u32,
}

fn default_pin() -> String {
    "A0".to_string()
}
fn default_controller() -> String {
    "GP2Y0A21YK".to_string()
}
fn default_freq() -> u32 {
    25
}

impl Default for ProximityConfig {
    fn default() -> Self {
        Self {
            pin: default_pin(),
            controller: default_controller(),
            freq: default_freq(),
        }
    }
}
