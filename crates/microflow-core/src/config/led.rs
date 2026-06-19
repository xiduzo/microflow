//! LED Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
}

fn default_pin() -> u8 {
    13
}

impl Default for LedConfig {
    fn default() -> Self {
        Self { pin: default_pin() }
    }
}
