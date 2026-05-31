//! Monitor Component — Output. Template port for the workflow node fan-out.
//!
//! A display-only component that receives values and stores them for
//! visualization in the frontend. No hardware interaction required.

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext, RuntimeError,
};
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
    fn ports() -> &'static [&'static str] {
        &["value"]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Monitor"
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "value" => {
                self.base.set_value(args);
                Ok(())
            }
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}

impl ComponentBuilder for Monitor {
    type Config = MonitorConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
