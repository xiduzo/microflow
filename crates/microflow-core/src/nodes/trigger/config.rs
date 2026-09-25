//! Trigger Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerConfig {
    #[serde(default)]
    pub relative: bool,
    #[serde(default = "default_behaviour")]
    pub behaviour: TriggerBehaviour,
    #[serde(default = "default_threshold")]
    pub threshold: f64,
    #[serde(default = "default_within")]
    pub within: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TriggerBehaviour {
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
