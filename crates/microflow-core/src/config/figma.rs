//! Figma Node config — shared by the live runtime and (future) codegen emitter.
//!
//! Pure data describing which Figma variable (via the plugin's MQTT bridge) this
//! node mirrors: the broker id, the plugin's `unique_id`, the `variable_id`, the
//! resolved Figma type, and the debounce window. The broker credentials live on
//! the host, never here.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FigmaConfig {
    #[serde(default)]
    pub broker_id: String,
    #[serde(default)]
    pub unique_id: String,
    #[serde(default)]
    pub variable_id: String,
    #[serde(default = "default_resolved_type")]
    pub resolved_type: String,
    #[serde(default = "default_debounce_time")]
    pub debounce_time: u64,
}

fn default_resolved_type() -> String {
    "STRING".to_string()
}

fn default_debounce_time() -> u64 {
    100
}

impl Default for FigmaConfig {
    fn default() -> Self {
        Self {
            broker_id: String::new(),
            unique_id: String::new(),
            variable_id: String::new(),
            resolved_type: "STRING".to_string(),
            debounce_time: 100,
        }
    }
}
