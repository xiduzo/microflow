//! Sensor Component — Input. Template port for the workflow node fan-out.
//!
//! Note vs. the desktop original: the vestigial `poll_handle` / `polling_active`
//! tokio polling fields are dropped (the board reader, now `feed_bytes`, drives
//! `on_pin_change`), and analog reporting is no longer enabled here — the
//! runtime's `update_flow` reconciles reporting centrally from `listener_wiring`.

use crate::firmata::PinProfile;
use crate::runtime::{
    pin_mode, serde_utils, Component, ComponentBase, ComponentBuilder, ComponentValue,
    HardwareComponent, ListenerWiring, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};

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
    /// The Firmata pin this sensor reads on `pins`. `data.pin` is either an
    /// analog channel label (`"A0"`, the default the frontend keeps until the
    /// pin is re-picked) or a pin number (`"54"`). `"A0"` is pin 14 on an Uno,
    /// 54 on a Mega, 18 on a Leonardo — only the board's analog mapping knows,
    /// so the label resolves through the [`PinProfile`] (the Uno layout when no
    /// board is described). A label the board lacks reads as pin 0; the pin
    /// check badges the node.
    #[must_use]
    pub(crate) fn analog_pin(&self, pins: &PinProfile) -> u8 {
        pins.resolve_label(&self.pin, 0)
    }
}

pub(crate) struct Sensor {
    base: ComponentBase,
    config: SensorConfig,
    /// `config.pin` resolved against the connected board (`bind_pins`).
    pin: u8,
    last_value: u16,
}

impl Sensor {
    #[must_use]
    pub(crate) fn new(id: String, config: SensorConfig) -> Self {
        let pin = config.analog_pin(&PinProfile::default());
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            pin,
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
            pin: self.pin,
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
    fn bind_pins(&mut self, pins: &PinProfile) {
        self.pin = self.config.analog_pin(pins);
    }

    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().set_pin_mode(self.pin, pin_mode::ANALOG)?;
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

    /// The "A0" label resolves through the board's analog mapping: on a Mega
    /// A0 is pin 54 and pin 14 is a plain digital pin.
    #[test]
    fn mega_a0_label_reads_pin_54() {
        let mut rig = sensor(BoardLayout::mega2560(), "A0", 1);
        assert!(rig.board.is_reporting_analog(0));
        assert_eq!(read(&mut rig, 54, 700), Some(ComponentValue::Number(700.0)));
    }

    /// The codec decodes analog channel n onto the pin the board maps it to,
    /// so a Mega/Leonardo reading reaches the sensor on that pin.
    #[test]
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
        // No board described: "A0" is channel 0 -> the Uno's pin 14 (not the
        // bare channel 0).
        let uno = PinProfile::default();
        assert_eq!(cfg("A0").analog_pin(&uno), 14);
        assert_eq!(cfg("A1").analog_pin(&uno), 15);
        assert_eq!(cfg("a2").analog_pin(&uno), 16);
        // Numeric format is the pin number directly.
        assert_eq!(cfg("14").analog_pin(&uno), 14);
        assert_eq!(cfg("20").analog_pin(&uno), 20);
        // The default config (pin "A0") must resolve to pin 14, not 0.
        assert_eq!(SensorConfig::default().analog_pin(&uno), 14);
    }

    #[test]
    fn analog_label_follows_the_board() {
        let infos: Vec<crate::firmata::PinInfo> = (0..30)
            .map(|pin| crate::firmata::PinInfo {
                pin,
                supported_modes: vec![],
                analog_channel: if pin >= 18 { pin as i32 - 18 } else { -1 },
            })
            .collect();
        let leonardo = PinProfile::from_pin_infos(&infos);
        assert_eq!(cfg("A0").analog_pin(&leonardo), 18);
        assert_eq!(cfg("A11").analog_pin(&leonardo), 29);
    }
}
