//! Constant Component - Generator

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConstantConfig {
    #[serde(default = "default_value")]
    pub value: f64,
}

fn default_value() -> f64 { 1337.0 }

impl Default for ConstantConfig {
    fn default() -> Self { Self { value: default_value() } }
}

pub struct Constant {
    base: ComponentBase,
    #[allow(dead_code)]
    config: ConstantConfig,
}

impl Constant {
    #[must_use] 
    pub fn new(id: String, config: ConstantConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(config.value)),
            config,
        }
    }
}

impl Component for Constant {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Constant" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), String> { Ok(()) }

    fn call_method(&mut self, method: &str, _args: ComponentValue) -> Result<(), String> {
        Err(format!("Unknown method: {method}"))
    }

    fn destroy(&mut self) {}
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
