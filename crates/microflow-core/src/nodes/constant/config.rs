//! Constant Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConstantConfig {
    #[serde(default = "default_value")]
    pub value: f64,
}

fn default_value() -> f64 {
    1337.0
}

impl Default for ConstantConfig {
    fn default() -> Self {
        Self { value: default_value() }
    }
}
