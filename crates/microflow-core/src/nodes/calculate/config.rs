//! Calculate Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CalculateFunction {
    #[default]
    Add,
    Subtract,
    Multiply,
    Divide,
    Modulo,
    Max,
    Min,
    Pow,
    Ceil,
    Floor,
    Round,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CalculateConfig {
    #[serde(default)]
    pub function: CalculateFunction,
}
