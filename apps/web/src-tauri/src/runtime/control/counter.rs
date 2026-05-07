//! Counter Component - Control

use crate::runtime::base::{Component, ComponentBase, ComponentValue};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CounterConfig {}

pub struct Counter {
    base: ComponentBase,
    #[allow(dead_code)]
    config: CounterConfig,
}

impl Counter {
    #[must_use] 
    pub fn new(id: String, config: CounterConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
        }
    }

    pub fn increment(&mut self) {
        let current = self.base.value.as_number().unwrap_or(0.0);
        self.base.set_value(ComponentValue::Number(current + 1.0));
    }

    pub fn decrement(&mut self) {
        let current = self.base.value.as_number().unwrap_or(0.0);
        self.base.set_value(ComponentValue::Number(current - 1.0));
    }

    pub fn reset(&mut self) {
        self.base.set_value(ComponentValue::Number(0.0));
    }

    pub fn set(&mut self, value: f64) {
        self.base.set_value(ComponentValue::Number(value));
    }
}

impl Component for Counter {
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Counter" }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "increment" => { self.increment(); Ok(()) }
            "decrement" => { self.decrement(); Ok(()) }
            "reset" => { self.reset(); Ok(()) }
            "set" => { self.set(args.as_number().unwrap_or(0.0)); Ok(()) }
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}
