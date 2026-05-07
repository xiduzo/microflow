//! Constant Component - Generator

use crate::runtime::base::{Component, ComponentBase, ComponentValue};
use serde::{Deserialize, Serialize};

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
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Constant" }

    fn call_method(&mut self, method: &str, _args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}")))
    }
}
