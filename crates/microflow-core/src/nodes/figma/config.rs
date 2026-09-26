//! Figma Node config — shared by the live runtime and the codegen emitter.
//!
//! Pure data describing which design-tool variable (via a plugin's MQTT bridge)
//! this node mirrors: the design tool (`source`), the broker id, the Bridge ID
//! (`unique_id`), the tool's `variable_id` and its resolved type. The broker
//! credentials live on the host, never here.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FigmaConfig {
    /// The design tool the variable lives in: `figma` or `penpot`.
    #[serde(default = "default_source")]
    pub(crate) source: String,
    #[serde(default)]
    pub(crate) broker_id: String,
    #[serde(default)]
    pub(crate) unique_id: String,
    #[serde(default)]
    pub(crate) variable_id: String,
    #[serde(default = "default_resolved_type")]
    pub(crate) resolved_type: String,
}

fn default_source() -> String {
    "figma".to_string()
}

fn default_resolved_type() -> String {
    "STRING".to_string()
}

impl Default for FigmaConfig {
    fn default() -> Self {
        Self {
            source: default_source(),
            broker_id: String::new(),
            unique_id: String::new(),
            variable_id: String::new(),
            resolved_type: default_resolved_type(),
        }
    }
}
