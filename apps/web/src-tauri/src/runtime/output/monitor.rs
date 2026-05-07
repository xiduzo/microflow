//! Monitor Component - Output
//!
//! A display-only component that receives values and stores them for
//! visualization in the frontend. No hardware interaction required.

use crate::runtime::base::{Component, ComponentBase, ComponentValue};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MonitorConfig {}

pub struct Monitor {
    base: ComponentBase,
    #[allow(dead_code)]
    config: MonitorConfig,
}

impl Monitor {
    #[must_use] 
    pub fn new(id: String, config: MonitorConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
        }
    }
}

impl Component for Monitor {
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Monitor" }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "value" => {
                self.base.set_value(args);
                Ok(())
            }
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}
