//! Relay Component — Output. Template port for the workflow node fan-out.

use crate::runtime::{
    pin_mode, serde_utils, Component, ComponentBase, ComponentBuilder, ComponentValue,
    HardwareComponent, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum RelayType {
    #[default]
    NO,
    NC,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default)]
    pub r#type: RelayType,
}

fn default_pin() -> u8 {
    10
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self { pin: default_pin(), r#type: RelayType::default() }
    }
}

pub struct Relay {
    base: ComponentBase,
    config: RelayConfig,
    is_open: bool,
}

impl Relay {
    #[must_use]
    pub fn new(id: String, config: RelayConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            is_open: false,
        }
    }

    fn open(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        let signal = matches!(self.config.r#type, RelayType::NO);
        ctx.board().digital_write(self.config.pin, signal)?;
        self.is_open = true;
        self.base.set_value(ComponentValue::Bool(true));
        Ok(())
    }

    fn close(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        let signal = matches!(self.config.r#type, RelayType::NC);
        ctx.board().digital_write(self.config.pin, signal)?;
        self.is_open = false;
        self.base.set_value(ComponentValue::Bool(false));
        Ok(())
    }

    fn toggle(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        if self.is_open {
            self.close(ctx)
        } else {
            self.open(ctx)
        }
    }
}

impl Component for Relay {
    fn ports() -> &'static [&'static str] {
        &["true", "false", "toggle"]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Relay"
    }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> {
        Some(self)
    }

    fn dispatch(
        &mut self,
        method: &str,
        _args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "true" => self.open(ctx),
            "false" => self.close(ctx),
            "toggle" => self.toggle(ctx),
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}

impl HardwareComponent for Relay {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().set_pin_mode(self.config.pin, pin_mode::OUTPUT)?;
        self.close(ctx)
    }
}

impl ComponentBuilder for Relay {
    type Config = RelayConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
