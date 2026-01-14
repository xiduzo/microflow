//! Gate Component - Transformation

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateConfig {
    #[serde(default)]
    pub gate: GateType,
}

impl Default for GateConfig {
    fn default() -> Self { Self { gate: GateType::default() } }
}

pub struct Gate {
    base: ComponentBase,
    config: GateConfig,
}

impl Gate {
    pub fn new(id: String, config: GateConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
        }
    }

    pub fn check(&mut self, inputs: Vec<bool>) {
        let result = self.passes_gate(&inputs);
        self.base.value = ComponentValue::Bool(result);
        self.base.emit(if result { "true" } else { "false" });
    }

    fn passes_gate(&self, inputs: &[bool]) -> bool {
        let true_count = inputs.iter().filter(|&&b| b).count();
        let total = inputs.len();

        match self.config.gate {
            GateType::And => true_count == total,
            GateType::Nand => true_count != total,
            GateType::Or => true_count > 0,
            GateType::Xor => true_count == 1,
            GateType::Nor => true_count == 0,
            GateType::Xnor => true_count != 1,
        }
    }
}

impl Component for Gate {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Gate" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), String> { Ok(()) }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "check" => {
                let inputs = match args {
                    ComponentValue::Array(arr) => arr.iter().filter_map(|v| v.as_bool()).collect(),
                    ComponentValue::Bool(b) => vec![b],
                    _ => vec![],
                };
                self.check(inputs);
                Ok(())
            }
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) {}
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
