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

/// Firmata pin number of analog channel 0 on an `ATmega328` board (Uno/Nano):
/// `A0 == pin 14`. The codec's analog decode hard-codes the same base
/// (`pin = channel + 14`), so the two must agree.
const ANALOG_PIN_BASE: u8 = 14;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SensorType {
    #[default]
    Analog,
    Digital,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SensorConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_string_or_number")]
    pub(crate) pin: String,
    #[serde(default)]
    pub(crate) r#type: SensorType,
    #[serde(default = "default_freq")]
    pub(crate) freq: u32,
    #[serde(default = "default_threshold")]
    pub(crate) threshold: u16,
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
    /// `ATmega328` board — matching the codec's analog decode (`pin = channel +
    /// 14`) and [`BufferBoardWriter::analog_channel_for`]. Returning the bare
    /// channel (0) here was a bug: reporting, pin-mode, and change-detection all
    /// then targeted the wrong pin, so the sensor never updated. The frontend
    /// leaves `data.pin` at its `"A0"` default until the pin is re-picked, so
    /// this path is the common one.
    #[must_use]
    pub(crate) fn analog_pin(&self) -> u8 {
        if self.pin.starts_with('A') || self.pin.starts_with('a') {
            ANALOG_PIN_BASE.saturating_add(self.pin[1..].parse::<u8>().unwrap_or(0))
        } else {
            self.pin.parse().unwrap_or(0)
        }
    }
}

pub(crate) struct Sensor {
    base: ComponentBase,
    config: SensorConfig,
    last_value: u16,
}

impl Sensor {
    #[must_use]
    pub(crate) fn new(id: String, config: SensorConfig) -> Self {
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
mod sim_tests {
    use crate::firmata::sim::rig::{node, SimRig};
    use crate::firmata::sim::{BoardLayout, SimBoard};
    use crate::firmata::MODE_ANALOG;
    use crate::runtime::ComponentValue;
    use serde_json::json;

    fn sensor(layout: BoardLayout, pin: &str, threshold: u16) -> SimRig {
        let mut rig = SimRig::connect(SimBoard::new(layout));
        rig.apply_flow(
            vec![node("pot", "Sensor", json!({ "pin": pin, "type": "analog", "threshold": threshold }))],
            vec![],
        );
        rig
    }

    fn read(rig: &mut SimRig, pin: u8, value: u16) -> Option<ComponentValue> {
        rig.take_events();
        rig.board.set_analog(pin, value);
        rig.sample();
        rig.last_value("pot").cloned()
    }

    #[test]
    fn uno_a0_streams_readings_past_the_threshold() {
        let mut rig = sensor(BoardLayout::uno(), "A0", 10);
        assert_eq!(rig.board.pin(14).mode(), Some(MODE_ANALOG));
        assert!(rig.board.is_reporting_analog(0));
        assert_eq!(read(&mut rig, 14, 512), Some(ComponentValue::Number(512.0)));
        assert_eq!(read(&mut rig, 14, 515), None, "below the threshold");
        assert_eq!(read(&mut rig, 14, 530), Some(ComponentValue::Number(530.0)));
    }

    /// The "A0" label resolves to the Uno's pin 14 on every board; on a Mega
    /// A0 is pin 54 and pin 14 is a plain digital pin.
    #[test]
    #[ignore = "track I: the A<n> label resolves to 14 + n on every board (Mega A0 = 54, Leonardo A0 = 18)"]
    fn mega_a0_label_reads_pin_54() {
        let mut rig = sensor(BoardLayout::mega2560(), "A0", 1);
        assert!(rig.board.is_reporting_analog(0));
        assert_eq!(read(&mut rig, 54, 700), Some(ComponentValue::Number(700.0)));
    }

    /// Even with the right pin number, the codec decodes analog channel n as
    /// pin 14 + n, so a Mega/Leonardo reading lands on the wrong pin.
    #[test]
    #[ignore = "track I: codec maps ANALOG_MESSAGE channel n to pin 14 + n regardless of the board's analog mapping"]
    fn mega_and_leonardo_analog_readings_reach_the_sensor() {
        for (layout, pin) in [(BoardLayout::mega2560(), 54u8), (BoardLayout::leonardo(), 18)] {
            let mut rig = sensor(layout, &pin.to_string(), 1);
            assert!(rig.board.is_reporting_analog(0));
            assert_eq!(read(&mut rig, pin, 321), Some(ComponentValue::Number(321.0)), "pin {pin}");
        }
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
