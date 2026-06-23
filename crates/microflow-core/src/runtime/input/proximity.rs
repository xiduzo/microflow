//! Proximity Sensor Component — Input. Template port for the workflow node fan-out.
//!
//! Note vs. the desktop original: the vestigial `poll_handle` / `polling_active`
//! tokio polling fields are dropped (the board reader, now `feed_bytes`, drives
//! `on_pin_change`), and analog reporting is no longer enabled here — the
//! runtime's `update_flow` reconciles reporting centrally from `listener_wiring`.

use crate::runtime::{
    pin_mode, serde_utils, Component, ComponentBase, ComponentBuilder, ComponentValue,
    HardwareComponent, ListenerWiring, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProximityConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_string_or_number")]
    pub pin: String,
    #[serde(default = "default_controller")]
    pub controller: String,
    #[serde(default = "default_freq")]
    pub freq: u32,
}

fn default_pin() -> String {
    "A0".to_string()
}
fn default_controller() -> String {
    "GP2Y0A21YK".to_string()
}
fn default_freq() -> u32 {
    25
}

impl Default for ProximityConfig {
    fn default() -> Self {
        Self {
            pin: default_pin(),
            controller: default_controller(),
            freq: default_freq(),
        }
    }
}

impl ProximityConfig {
    /// Get the pin number for analog operations
    /// Handles both legacy "A0" format and new numeric format
    #[must_use]
    pub fn analog_pin(&self) -> u8 {
        // If it starts with 'A' or 'a', strip it and parse (legacy format)
        if self.pin.starts_with('A') || self.pin.starts_with('a') {
            // Legacy format like "A0" - but this shouldn't happen anymore
            // since UI now sends actual pin numbers
            self.pin[1..].parse().unwrap_or(0)
        } else {
            // New format: actual pin number (e.g., "14" for A0 on Arduino Uno)
            self.pin.parse().unwrap_or(0)
        }
    }
}

pub struct Proximity {
    base: ComponentBase,
    config: ProximityConfig,
    last_cm: f64,
}

impl Proximity {
    #[must_use]
    pub fn new(id: String, config: ProximityConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            last_cm: 0.0,
        }
    }

    fn raw_to_cm(&self, raw: u16) -> f64 {
        match self.config.controller.as_str() {
            "GP2Y0A21YK" => {
                let voltage = f64::from(raw) * 5.0 / 1024.0;
                if voltage > 0.42 {
                    (27.86 / (voltage - 0.42)).clamp(10.0, 80.0)
                } else {
                    80.0
                }
            }
            "GP2Y0A02YK0F" => {
                let voltage = f64::from(raw) * 5.0 / 1024.0;
                if voltage > 0.4 {
                    (60.0 / (voltage - 0.4)).clamp(20.0, 150.0)
                } else {
                    150.0
                }
            }
            "HCSR04" => (f64::from(raw) / 58.0).clamp(2.0, 400.0),
            _ => (f64::from(raw) * 200.0 / 1023.0).clamp(0.0, 200.0),
        }
    }

    fn process_reading(&mut self, raw: u16) {
        let cm = self.raw_to_cm(raw);
        if (cm - self.last_cm).abs() > 1.0 {
            self.last_cm = cm;
            self.base.set_value(ComponentValue::Number(cm));
        }
    }
}

impl Component for Proximity {
    fn ports() -> &'static [&'static str] {
        &["read"]
    }

    fn emits() -> &'static [&'static str] {
        &[ComponentBase::VALUE_HANDLE]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Proximity"
    }

    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        // Proximity has no threshold field; FlowRuntime previously defaulted to 1.
        vec![ListenerWiring::AnalogPin {
            pin: self.config.analog_pin(),
            threshold: 1,
        }]
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

impl HardwareComponent for Proximity {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().set_pin_mode(self.config.analog_pin(), pin_mode::ANALOG)?;
        Ok(())
    }

    fn on_pin_change(
        &mut self,
        value: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        if let Some(reading) = value.as_number() {
            self.process_reading(reading as u16);
        }
        Ok(())
    }
}

impl ComponentBuilder for Proximity {
    type Config = ProximityConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
