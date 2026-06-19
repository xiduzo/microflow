//! `RangeMap` Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Range {
    #[serde(default)]
    pub min: f64,
    #[serde(default = "default_max")]
    pub max: f64,
}

fn default_max() -> f64 {
    1023.0
}

impl Default for Range {
    fn default() -> Self {
        Self { min: 0.0, max: default_max() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RangeMapConfig {
    #[serde(default)]
    pub from: Range,
    #[serde(default)]
    pub to: Range,
}
