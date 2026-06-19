//! Compare Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CompareValidator {
    #[default]
    Boolean,
    Number,
    OddEven,
    Range,
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RangeConfig {
    #[serde(default)]
    pub min: f64,
    #[serde(default = "default_max")]
    pub max: f64,
}

fn default_max() -> f64 {
    100.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompareConfig {
    #[serde(default)]
    pub validator: CompareValidator,
    #[serde(default, rename = "subValidator")]
    pub sub_validator: String,
    #[serde(default)]
    pub number: f64,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub range: RangeConfig,
}

impl Default for CompareConfig {
    fn default() -> Self {
        Self {
            validator: CompareValidator::default(),
            sub_validator: "true".to_string(),
            number: 0.0,
            text: String::new(),
            range: RangeConfig::default(),
        }
    }
}
