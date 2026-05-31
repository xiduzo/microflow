//! Motion Sensor Component — Input. Template port for the workflow node fan-out.
//!
//! Note vs. the desktop original: the vestigial `poll_handle` / `polling_active`
//! tokio polling fields are dropped (the board reader, now `feed_bytes`, drives
//! `on_pin_change`), and digital reporting is no longer enabled here — the
//! runtime's `update_flow` reconciles reporting centrally from `listener_wiring`.

use crate::runtime::{
    pin_mode, serde_utils, Component, ComponentBase, ComponentBuilder, ComponentValue,
    HardwareComponent, ListenerWiring, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MotionConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default = "default_controller")]
    pub controller: String,
}

fn default_pin() -> u8 {
    8
}
fn default_controller() -> String {
    "HCSR501".to_string()
}

impl Default for MotionConfig {
    fn default() -> Self {
        Self {
            pin: default_pin(),
            controller: default_controller(),
        }
    }
}

pub struct Motion {
    base: ComponentBase,
    config: MotionConfig,
    motion_detected: bool,
    is_calibrated: bool,
}

impl Motion {
    #[must_use]
    pub fn new(id: String, config: MotionConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            motion_detected: false,
            is_calibrated: false,
        }
    }

    fn process_state(&mut self, detected: bool) {
        if !self.is_calibrated {
            self.is_calibrated = true;
        }
        if detected != self.motion_detected {
            self.motion_detected = detected;
            self.base.set_value(ComponentValue::Bool(detected));
            self.base.emit("event");
            self.base.emit(if detected { "true" } else { "false" });
        }
    }
}

impl Component for Motion {
    fn ports() -> &'static [&'static str] {
        &["read"]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Motion"
    }

    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        vec![ListenerWiring::DigitalPin { pin: self.config.pin }]
    }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> {
        Some(self)
    }

    fn dispatch(
        &mut self,
        method: &str,
        _args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "read" => Ok(()),
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}

impl HardwareComponent for Motion {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().set_pin_mode(self.config.pin, pin_mode::INPUT)?;
        Ok(())
    }

    fn on_pin_change(
        &mut self,
        value: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        if let Some(detected) = value.as_bool() {
            self.process_state(detected);
        }
        Ok(())
    }
}

impl ComponentBuilder for Motion {
    type Config = MotionConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
