//! Relay Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum RelayType {
    #[default]
    NO,
    NC,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default)]
    pub r#type: RelayType,
}

fn default_pin() -> u8 {
    10
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self { pin: default_pin(), r#type: RelayType::default() }
    }
}
