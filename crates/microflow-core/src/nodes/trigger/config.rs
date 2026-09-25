//! Trigger Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TriggerConfig {
    #[serde(default)]
    pub(crate) relative: bool,
    #[serde(default = "default_behaviour")]
    pub(crate) behaviour: TriggerBehaviour,
    #[serde(default = "default_threshold")]
    pub(crate) threshold: f64,
    #[serde(default = "default_within")]
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

impl Default for TriggerConfig {
    fn default() -> Self {
        Self {
            relative: false,
            behaviour: default_behaviour(),
            threshold: default_threshold(),
            within: default_within(),
        }
    }
}
