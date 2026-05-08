//! `RangeMap` Component - Transformation

use crate::runtime::base::{Component, ComponentBase, ComponentValue};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Range {
    #[serde(default)]
    pub min: f64,
    #[serde(default = "default_max")]
    pub max: f64,
}

fn default_max() -> f64 { 1023.0 }

impl Default for Range {
    fn default() -> Self { Self { min: 0.0, max: default_max() } }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RangeMapConfig {
    #[serde(default)]
    pub from: Range,
    #[serde(default)]
    pub to: Range,
}

pub struct RangeMap {
    base: ComponentBase,
    config: RangeMapConfig,
}

impl RangeMap {
    #[must_use] 
    pub fn new(id: String, config: RangeMapConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Array(vec![
                ComponentValue::Number(0.0),
                ComponentValue::Number(0.0),
            ])),
            config,
        }
    }

    pub fn map_value(&mut self, input: ComponentValue) {
        let input_num = match input {
            ComponentValue::Bool(true) => 1.0,
            ComponentValue::Bool(false) => 0.0,
            ComponentValue::Number(n) => n,
            ComponentValue::String(s) => s.parse().unwrap_or(0.0),
            _ => 0.0,
        };

        let in_min = self.config.from.min;
        let in_max = self.config.from.max;
        let out_min = self.config.to.min;
        let out_max = self.config.to.max;

        let mapped = ((input_num - in_min) * (out_max - out_min)) / (in_max - in_min) + out_min;
        let distance = (out_max - out_min).abs();
        let precision = i32::from(distance <= 10.0);
        let factor = 10_f64.powi(precision);
        let normalized = (mapped * factor).round() / factor;

        self.base.set_value(ComponentValue::Array(vec![
            ComponentValue::Number(input_num),
            ComponentValue::Number(normalized),
        ]));
        self.base.emit_with_value("to", Cow::Owned(ComponentValue::Number(normalized)));
    }
}

impl Component for RangeMap {
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "RangeMap" }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "value" => { self.map_value(args); Ok(()) }
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}
