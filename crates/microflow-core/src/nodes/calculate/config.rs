//! Calculate Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CalculateFunction {
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
pub(crate) struct CalculateConfig {
    #[serde(default)]
    pub(crate) function: CalculateFunction,
}
