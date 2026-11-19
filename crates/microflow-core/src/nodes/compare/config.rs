//! Compare Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CompareValidator {
    #[default]
    Boolean,
    Number,
    // The editor writes this option in camelCase.
    #[serde(rename = "oddEven")]
    OddEven,
    Range,
    Text,
}

/// The bounds of the range validator. A node that holds no `range` — the
/// author picked the range validator and left the bounds alone — checks
/// 0–100: the editor schema's default (`compare.schema.ts`), which is what the
/// settings panel shows for it and does not write into the node until the
/// bounds are edited.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RangeConfig {
    #[serde(default)]
    pub(crate) min: f64,
    #[serde(default = "default_max")]
    pub(crate) max: f64,
}

fn default_max() -> f64 {
    100.0
}

impl Default for RangeConfig {
    fn default() -> Self {
        Self { min: 0.0, max: default_max() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CompareConfig {
    #[serde(default)]
    pub(crate) validator: CompareValidator,
    /// Which comparison of the validator applies (`"odd"`, `"greater than"`,
    /// `"outside"`, …). Empty, or any name the validator does not know, is the
    /// validator's first option — the one the editor preselects.
    #[serde(default, rename = "subValidator")]
    pub(crate) sub_validator: String,
    #[serde(default)]
    pub(crate) number: f64,
    #[serde(default)]
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) range: RangeConfig,
}

/// How far apart a value and the configured `number` may be and still be
/// equal, for the number validator's equality check: they are equal when
/// `|value - number| < EQUALITY_TOLERANCE`. The live Compare checks by
/// [`CompareConfig::equals`]; the Sketch emits the same comparison against this
/// same constant, so 0.1 + 0.2 equals 0.3 on both.
pub(crate) const EQUALITY_TOLERANCE: f64 = f64::EPSILON;

impl CompareConfig {
    /// Whether `value` equals the configured `number`, within
    /// [`EQUALITY_TOLERANCE`].
    #[cfg_attr(not(feature = "runtime"), allow(dead_code))]
    pub(crate) fn equals(&self, value: f64) -> bool {
        (value - self.number).abs() < EQUALITY_TOLERANCE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::resolve;
    use serde_json::json;

    /// The editor writes the odd/even validator as `oddEven`
    /// (`compare.schema.ts`).
    #[test]
    fn the_editors_odd_even_option_is_read() {
        let config: CompareConfig =
            resolve(&json!({ "validator": "oddEven", "subValidator": "odd" })).unwrap();
        assert!(matches!(config.validator, CompareValidator::OddEven));
    }

    /// A range validator without bounds checks 0–100, whether `range` is
    /// missing or empty: the schema's default (`compare.schema.ts`), which is
    /// what the settings panel shows for a node that holds no range.
    #[test]
    fn a_range_without_bounds_is_the_schemas_default_range() {
        for data in [json!({ "validator": "range" }), json!({ "validator": "range", "range": {} })] {
            let config: CompareConfig = resolve(&data).unwrap();
            assert_eq!((config.range.min, config.range.max), (0.0, 100.0), "{data}");
        }
    }

    /// A range that holds one bound keeps it; the other is the default.
    #[test]
    fn a_range_with_one_bound_defaults_the_other() {
        let config: CompareConfig = resolve(&json!({ "validator": "range", "range": { "min": 20 } })).unwrap();
        assert_eq!((config.range.min, config.range.max), (20.0, 100.0));
        let config: CompareConfig = resolve(&json!({ "validator": "range", "range": { "max": 20 } })).unwrap();
        assert_eq!((config.range.min, config.range.max), (0.0, 20.0));
    }
}
