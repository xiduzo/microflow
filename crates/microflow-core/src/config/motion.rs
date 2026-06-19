//! Motion Sensor Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MotionConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default = "default_controller")]
    pub controller: String,
}

fn default_pin() -> u8 {
    8
}
fn default_controller() -> String {
    "HCSR501".to_string()
}

impl Default for MotionConfig {
    fn default() -> Self {
        Self {
            pin: default_pin(),
            controller: default_controller(),
        }
    }
}
