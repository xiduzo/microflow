//! Constant Component — Generator. Emits a fixed value once on start.

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConstantConfig {
    #[serde(default = "default_value")]
    pub value: f64,
}

fn default_value() -> f64 {
    1337.0
}

impl Default for ConstantConfig {
    fn default() -> Self {
        Self { value: default_value() }
    }
}

pub struct Constant {
    base: ComponentBase,
}

impl Constant {
    #[must_use]
    pub fn new(id: String, config: ConstantConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(config.value)),
        }
    }
}

impl Component for Constant {
    fn ports() -> &'static [&'static str] {
        &[]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Constant"
    }

    fn dispatch(
        &mut self,
        method: &str,
        _args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        Err(RuntimeError::ComponentError(format!("Unknown method: {method}")))
    }

    /// Emit the constant value once the node is built, so downstream nodes get
    /// it without any edge input. (The desktop relied on `set_event_sender`.)
    fn on_start(&mut self, _ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.base.emit("value");
        Ok(())
    }
}

impl ComponentBuilder for Constant {
    type Config = ConstantConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
