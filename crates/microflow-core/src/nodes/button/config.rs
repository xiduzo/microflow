//! Button Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default)]
    pub is_pullup: bool,
    #[serde(default)]
    pub is_pulldown: bool,
    #[serde(default = "default_holdtime")]
    pub holdtime: u64,
    #[serde(default)]
    pub invert: bool,
}

fn default_pin() -> u8 {
    6
}
fn default_holdtime() -> u64 {
    500
}

impl Default for ButtonConfig {
    fn default() -> Self {
        Self {
            pin: default_pin(),
            is_pullup: false,
            is_pulldown: false,
            holdtime: default_holdtime(),
            invert: false,
        }
    }
}
