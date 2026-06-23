//! `RangeMap` Component — Transformation. Linearly remaps a value between ranges.

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext, RuntimeError,
};
use std::borrow::Cow;

pub use crate::config::range_map::{Range, RangeMapConfig};

pub struct RangeMap {
    base: ComponentBase,
    config: RangeMapConfig,
}

impl RangeMap {
    const E_TO: &'static str = "to";

    #[must_use]
    pub fn new(id: String, config: RangeMapConfig) -> Self {
        Self {
            base: ComponentBase::new(
                id,
                ComponentValue::Array(vec![ComponentValue::Number(0.0), ComponentValue::Number(0.0)]),
            ),
            config,
        }
    }

    fn map_value(&mut self, input: ComponentValue) {
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
        self.base.emit_with_value(Self::E_TO, Cow::Owned(ComponentValue::Number(normalized)));
    }
}

impl Component for RangeMap {
    fn ports() -> &'static [&'static str] {
        &["value"]
    }

    fn emits() -> &'static [&'static str] {
        &[Self::E_TO, ComponentBase::VALUE_HANDLE]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "RangeMap"
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "value" => {
                self.map_value(args);
                Ok(())
            }
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}

impl ComponentBuilder for RangeMap {
    type Config = RangeMapConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
