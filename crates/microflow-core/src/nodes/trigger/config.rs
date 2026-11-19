//! Trigger Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

/// How many values a Trigger holds from its last `within` ms. The live runtime
/// and the generated Sketch share this bound and the rule for what happens
/// past it — a value that arrives while the Trigger is full takes the place of
/// the newest held one — so a Flow counts a change from the same value on the
/// device as it does live. On the device every slot is a value plus a
/// timestamp in RAM: 8 bytes on an Uno, 128 for the whole window.
pub(crate) const WINDOW_CAPACITY: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TriggerConfig {
    #[serde(default)]
    pub(crate) relative: bool,
    #[serde(default = "default_behaviour")]
    pub(crate) behaviour: TriggerBehaviour,
    #[serde(default = "default_threshold")]
    pub(crate) threshold: f64,
    #[serde(default = "default_within", deserialize_with = "serde_utils::deserialize_whole")]
    pub(crate) within: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TriggerBehaviour {
    Increasing,
    #[default]
    Decreasing,
}

fn default_behaviour() -> TriggerBehaviour {
    TriggerBehaviour::Decreasing
}
fn default_threshold() -> f64 {
    5.0
}
fn default_within() -> u64 {
    250
}
