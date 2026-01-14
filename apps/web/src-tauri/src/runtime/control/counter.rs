//! Counter Component - Control

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CounterConfig {}

pub struct Counter {
    base: ComponentBase,
    #[allow(dead_code)]
    config: CounterConfig,
}

impl Counter {
    pub fn new(id: String, config: CounterConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
        }
    }

    pub fn increment(&mut self) {
        let current = self.base.value.as_number().unwrap_or(0.0);
        self.base.value = ComponentValue::Number(current + 1.0);
        self.base.emit("change");
    }

    pub fn decrement(&mut self) {
        let current = self.base.value.as_number().unwrap_or(0.0);
        self.base.value = ComponentValue::Number(current - 1.0);
        self.base.emit("change");
    }

    pub fn reset(&mut self) {
        self.base.value = ComponentValue::Number(0.0);
        self.base.emit("change");
    }

    pub fn set(&mut self, value: f64) {
        self.base.value = ComponentValue::Number(value);
        self.base.emit("change");
    }
}

impl Component for Counter {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Counter" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), String> { Ok(()) }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "increment" => { self.increment(); Ok(()) }
            "decrement" => { self.decrement(); Ok(()) }
            "reset" => { self.reset(); Ok(()) }
            "set" => { self.set(args.as_number().unwrap_or(0.0)); Ok(()) }
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) {}
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
