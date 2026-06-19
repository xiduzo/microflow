//! Pixel Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PixelConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default = "default_length")]
    pub length: u16,
    #[serde(default = "default_color_order")]
    pub color_order: String,
    #[serde(default)]
    pub presets: Vec<Vec<String>>,
}

fn default_pin() -> u8 {
    6
}
fn default_length() -> u16 {
    32
}
fn default_color_order() -> String {
    "GRB".to_string()
}

impl Default for PixelConfig {
    fn default() -> Self {
        Self {
            pin: default_pin(),
            length: default_length(),
            color_order: default_color_order(),
            presets: Vec::new(),
        }
    }
}
