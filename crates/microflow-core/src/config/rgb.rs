//! Rgb Node config — shared by the live runtime and the codegen emitter.
//!
//! The three PWM channel pins and the common-anode flag (active-low channels).

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RgbPins {
    #[serde(default = "default_red", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub red: u8,
    #[serde(default = "default_green", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub green: u8,
    #[serde(default = "default_blue", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub blue: u8,
}

fn default_red() -> u8 {
    9
}
fn default_green() -> u8 {
    10
}
fn default_blue() -> u8 {
    11
}

impl Default for RgbPins {
    fn default() -> Self {
        Self { red: default_red(), green: default_green(), blue: default_blue() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RgbConfig {
    #[serde(default)]
    pub pins: RgbPins,
    #[serde(default)]
    pub is_anode: bool,
}
