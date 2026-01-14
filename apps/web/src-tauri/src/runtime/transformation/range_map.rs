//! RangeMap Component - Transformation

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RangeMapConfig {
    #[serde(default)]
    pub from: Range,
    #[serde(default)]
    pub to: Range,
}

impl Default for RangeMapConfig {
    fn default() -> Self {
        Self { from: Range::default(), to: Range::default() }
    }
}

pub struct RangeMap {
    base: ComponentBase,
    config: RangeMapConfig,
}

impl RangeMap {
    pub fn new(id: String, config: RangeMapConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Array(vec![
                ComponentValue::Number(0.0),
                ComponentValue::Number(0.0),
            ])),
            config,
        }
    }

    pub fn from(&mut self, input: ComponentValue) {
        let input_num = match input {
            ComponentValue::Bool(b) => if b { 1.0 } else { 0.0 },
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
        let precision = if distance <= 10.0 { 1 } else { 0 };
        let factor = 10_f64.powi(precision);
        let normalized = (mapped * factor).round() / factor;

        self.base.value = ComponentValue::Array(vec![
            ComponentValue::Number(input_num),
            ComponentValue::Number(normalized),
        ]);
        self.base.emit_with_value("to", ComponentValue::Number(normalized));
    }
}

impl Component for RangeMap {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "RangeMap" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), String> { Ok(()) }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "from" => { self.from(args); Ok(()) }
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) {}
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
