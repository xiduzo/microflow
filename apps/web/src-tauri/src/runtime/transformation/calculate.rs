//! Calculate Component - Transformation

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

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

pub struct Calculate {
    base: ComponentBase,
    config: CalculateConfig,
}

impl Calculate {
    #[must_use] 
    pub fn new(id: String, config: CalculateConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
        }
    }

    pub fn check(&mut self, inputs: &[f64]) {
        if inputs.is_empty() { return; }

        let result = match self.config.function {
            CalculateFunction::Add => inputs.iter().sum(),
            CalculateFunction::Subtract => inputs.iter().skip(1).fold(inputs[0], |acc, &v| acc - v),
            CalculateFunction::Multiply => inputs.iter().product(),
            CalculateFunction::Divide => inputs.iter().skip(1).fold(inputs[0], |acc, &v| if v == 0.0 { acc } else { acc / v }),
            CalculateFunction::Modulo => inputs.iter().skip(1).fold(inputs[0], |acc, &v| if v == 0.0 { acc } else { acc % v }),
            CalculateFunction::Max => inputs.iter().copied().fold(f64::NEG_INFINITY, f64::max),
            CalculateFunction::Min => inputs.iter().copied().fold(f64::INFINITY, f64::min),
            CalculateFunction::Pow => if inputs.len() >= 2 { inputs[0].powf(inputs[1]) } else { inputs[0] },
            CalculateFunction::Ceil => inputs[0].ceil(),
            CalculateFunction::Floor => inputs[0].floor(),
            CalculateFunction::Round => inputs[0].round(),
        };

        self.base.set_value(ComponentValue::Number(result));
        self.base.emit("value");
    }
}

impl Component for Calculate {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Calculate" }
    fn aggregates_inputs(&self) -> bool { true }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> { Ok(()) }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "value" => {
                let inputs = match args {
                    ComponentValue::Array(arr) => arr.iter().filter_map(super::super::base::ComponentValue::as_number).collect(),
                    ComponentValue::Number(n) => vec![n],
                    _ => vec![],
                };
                self.check(&inputs);
                Ok(())
            }
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) {}
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
