//! Servo Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ServoType {
    #[default]
    Standard,
    Continuous,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServoRange {
    #[serde(default = "default_min")]
    pub min: u16,
    #[serde(default = "default_max")]
    pub max: u16,
}

fn default_min() -> u16 {
    0
}
fn default_max() -> u16 {
    180
}

impl Default for ServoRange {
    fn default() -> Self {
        Self { min: default_min(), max: default_max() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServoConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default)]
    pub range: ServoRange,
    #[serde(default)]
    pub r#type: ServoType,
}

fn default_pin() -> u8 {
    3
}

impl Default for ServoConfig {
    fn default() -> Self {
        Self { pin: default_pin(), range: ServoRange::default(), r#type: ServoType::default() }
    }
}
