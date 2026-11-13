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

impl SwitchType {
    /// The pin level that reads as "closed" — the one truth table the live
    /// runtime and the emitted sketch both apply, so they cannot disagree.
    /// johnny-five's semantics, on a plain `INPUT` with an external pull-down:
    /// a NO contact pulls the line HIGH when actuated; NC inverts it.
    #[must_use]
    pub(crate) fn closed_when_high(&self) -> bool {
        match self {
            SwitchType::NO => true,
            SwitchType::NC => false,
        }
    }
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
