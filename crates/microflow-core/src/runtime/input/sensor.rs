//! Sensor Component — Input. Template port for the workflow node fan-out.
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

/// Firmata pin number of analog channel 0 on an ATmega328 board (Uno/Nano):
/// `A0 == pin 14`. The codec's analog decode hard-codes the same base
/// (`pin = channel + 14`), so the two must agree.
const ANALOG_PIN_BASE: u8 = 14;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SensorType {
    #[default]
    Analog,
    Digital,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SensorConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_string_or_number")]
    pub pin: String,
    #[serde(default)]
    pub r#type: SensorType,
    #[serde(default = "default_freq")]
    pub freq: u32,
    #[serde(default = "default_threshold")]
    pub threshold: u16,
}

fn default_pin() -> String {
    "A0".to_string()
}
fn default_freq() -> u32 {
    25
}
fn default_threshold() -> u16 {
    1
}

impl Default for SensorConfig {
    fn default() -> Self {
        Self {
            pin: default_pin(),
            r#type: SensorType::default(),
            freq: default_freq(),
            threshold: default_threshold(),
        }
    }
}

impl SensorConfig {
    /// Pin number for analog operations. Handles both the `"A0"` channel format
    /// and the numeric pin format (e.g. `"14"` for A0 on an Uno).
    ///
    /// `"A0"` names analog *channel* 0, which is Firmata *pin* 14 on an
    /// ATmega328 board — matching the codec's analog decode (`pin = channel +
    /// 14`) and [`BufferBoardWriter::analog_channel_for`]. Returning the bare
    /// channel (0) here was a bug: reporting, pin-mode, and change-detection all
    /// then targeted the wrong pin, so the sensor never updated. The frontend
    /// leaves `data.pin` at its `"A0"` default until the pin is re-picked, so
    /// this path is the common one.
    #[must_use]
    pub fn analog_pin(&self) -> u8 {
        if self.pin.starts_with('A') || self.pin.starts_with('a') {
            ANALOG_PIN_BASE.saturating_add(self.pin[1..].parse::<u8>().unwrap_or(0))
        } else {
            self.pin.parse().unwrap_or(0)
        }
    }
}

pub struct Sensor {
    base: ComponentBase,
    config: SensorConfig,
    last_value: u16,
}

impl Sensor {
    #[must_use]
    pub fn new(id: String, config: SensorConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            last_value: 0,
        }
    }

    fn process_reading(&mut self, value: u16) {
        let diff = (i32::from(value) - i32::from(self.last_value)).unsigned_abs() as u16;
        if diff >= self.config.threshold {
            self.last_value = value;
            self.base.set_value(ComponentValue::Number(f64::from(value)));
        }
    }
}

impl Component for Sensor {
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
        "Sensor"
    }

    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        vec![ListenerWiring::AnalogPin {
            pin: self.config.analog_pin(),
            threshold: self.config.threshold,
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

impl HardwareComponent for Sensor {
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

impl ComponentBuilder for Sensor {
    type Config = SensorConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(pin: &str) -> SensorConfig {
        SensorConfig { pin: pin.to_string(), ..SensorConfig::default() }
    }

    #[test]
    fn analog_pin_maps_channel_format_to_firmata_pin() {
        // "A0" is channel 0 -> Firmata pin 14 (not the bare channel 0).
        assert_eq!(cfg("A0").analog_pin(), 14);
        assert_eq!(cfg("A1").analog_pin(), 15);
        assert_eq!(cfg("a2").analog_pin(), 16);
        // Numeric format is the pin number directly.
        assert_eq!(cfg("14").analog_pin(), 14);
        assert_eq!(cfg("20").analog_pin(), 20);
        // The default config (pin "A0") must resolve to pin 14, not 0.
        assert_eq!(SensorConfig::default().analog_pin(), 14);
    }
}
