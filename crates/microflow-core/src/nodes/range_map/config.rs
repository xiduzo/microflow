//! `RangeMap` Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Range {
    #[serde(default)]
    pub(crate) min: f64,
    #[serde(default = "default_max")]
    pub(crate) max: f64,
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
pub(crate) struct RangeMapConfig {
    #[serde(default)]
    pub(crate) from: Range,
    #[serde(default)]
    pub(crate) to: Range,
}
