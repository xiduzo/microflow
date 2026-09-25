//! Proximity Node config — shared by the live runtime and the codegen emitter.
//!
//! The analog pin (stored as a string, `"A0"` or a numeric pin), the sensor
//! controller model, and the sampling frequency.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProximityConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_string_or_number")]
    pub pin: String,
    #[serde(default = "default_controller")]
    pub controller: String,
    #[serde(default = "default_freq")]
    pub freq: u32,
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

impl ProximityConfig {
    /// Get the pin number for analog operations
    /// Handles both legacy "A0" format and new numeric format
    #[must_use]
    pub fn analog_pin(&self) -> u8 {
        // If it starts with 'A' or 'a', strip it and parse (legacy format)
        if self.pin.starts_with('A') || self.pin.starts_with('a') {
            // Legacy format like "A0" - but this shouldn't happen anymore
            // since UI now sends actual pin numbers
            self.pin[1..].parse().unwrap_or(0)
        } else {
            // New format: actual pin number (e.g., "14" for A0 on Arduino Uno)
            self.pin.parse().unwrap_or(0)
        }
    }
}
