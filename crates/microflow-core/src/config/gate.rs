//! Gate Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum GateType {
    #[default]
    And,
    Nand,
    Or,
    Xor,
    Nor,
    Xnor,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GateConfig {
    #[serde(default)]
    pub gate: GateType,
}
