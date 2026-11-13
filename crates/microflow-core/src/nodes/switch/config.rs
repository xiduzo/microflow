//! Switch Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

/// The editor's default is `NC` (`switch.schema.ts`), so a node stored
/// without a `type` means the same thing to the editor, the live runtime and
/// the sketch.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) enum SwitchType {
    /// Normally Open — circuit is open when not actuated
    NO,
    /// Normally Closed — circuit is closed when not actuated
    #[default]
    NC,
}

impl SwitchType {
    /// The pin level that reads as "closed" (the node's `true`) — the one
    /// truth table the live runtime and the emitted sketch both apply, so they
    /// cannot disagree. It is the live runtime's long-standing behaviour and
    /// what the Switch docs describe for the editor's default, NC: HIGH is
    /// active, LOW inactive. NO is the inverse: LOW is closed.
    #[must_use]
    pub(crate) fn closed_when_high(&self) -> bool {
        match self {
            SwitchType::NO => false,
            SwitchType::NC => true,
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
