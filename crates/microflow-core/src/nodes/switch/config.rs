//! Switch Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) enum SwitchType {
    /// Normally Open — circuit is open when not actuated
    #[default]
    NO,
    /// Normally Closed — circuit is closed when not actuated
    NC,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub(crate) pin: u8,
    #[serde(default, rename = "type")]
    pub(crate) switch_type: SwitchType,
}

fn default_pin() -> u8 {
    2
}

impl Default for SwitchConfig {
    fn default() -> Self {
        Self { pin: default_pin(), switch_type: SwitchType::default() }
    }
}
