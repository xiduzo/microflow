//! Compare Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CompareValidator {
    #[default]
    Boolean,
    Number,
    OddEven,
    Range,
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct RangeConfig {
    #[serde(default)]
    pub(crate) min: f64,
    #[serde(default = "default_max")]
    pub(crate) max: f64,
}

fn default_max() -> f64 {
    100.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CompareConfig {
    #[serde(default)]
    pub(crate) validator: CompareValidator,
    #[serde(default, rename = "subValidator")]
    pub(crate) sub_validator: String,
    #[serde(default)]
    pub(crate) number: f64,
    #[serde(default)]
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) range: RangeConfig,
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
