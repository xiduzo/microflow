//! Proximity Sensor Component — Input. Template port for the workflow node fan-out.
//!
//! Note vs. the desktop original: the vestigial `poll_handle` / `polling_active`
//! tokio polling fields are dropped (the board reader, now `feed_bytes`, drives
//! `on_pin_change`), and analog reporting is no longer enabled here — the
//! runtime's `update_flow` reconciles reporting centrally from `listener_wiring`.

use crate::firmata::PinProfile;
use crate::runtime::{
    pin_mode, Component, ComponentBase, ComponentBuilder, ComponentValue,
    HardwareComponent, ListenerWiring, RuntimeContext, RuntimeError,
};

use super::config::{ProximityConfig, MIN_MOVE_CM};

pub(crate) struct Proximity {
    base: ComponentBase,
    config: ProximityConfig,
    /// The Firmata pin this sensor reads: `config.pin` (`"A0"` or a pin
    /// number) resolved against the connected board's analog mapping
    /// (`bind_pins`; the Uno layout until a board is described). Reading the
    /// label's index as a pin put the default `"A0"` on pin 0 — the serial RX
    /// pin — and the sensor never reported.
    pin: u8,
    last_cm: f64,
}

impl Proximity {
    #[must_use]
    pub(crate) fn new(id: String, config: ProximityConfig) -> Self {
        let pin = PinProfile::default().resolve(config.pin).unwrap_or(0);
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            pin,
            last_cm: 0.0,
        }
    }

    /// Hand on the distance `raw` stands for, once it has moved more than
    /// [`MIN_MOVE_CM`] from the last one — the rule the sketch applies too.
    fn process_reading(&mut self, raw: u16) {
        let cm = self.config.ranging().centimetres(raw);
        if (cm - self.last_cm).abs() > MIN_MOVE_CM {
            self.last_cm = cm;
            self.base.set_value(ComponentValue::Number(cm));
        }
    }
}

impl Component for Proximity {
    fn ports() -> &'static [&'static str] {
        // An input: it reports what the board reads and takes no edge.
        &[]
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
            pin: self.pin,
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
        Err(RuntimeError::ComponentError(format!("Unknown method: {method}")))
    }
}

impl HardwareComponent for Proximity {
    fn bind_pins(&mut self, pins: &PinProfile) {
        self.pin = pins.resolve(self.config.pin).unwrap_or(0);
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

impl ComponentBuilder for Proximity {
    type Config = ProximityConfig;
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

    fn proximity(pin: &str) -> SimRig {
        proximity_on(BoardLayout::uno(), pin)
    }

    fn proximity_on(layout: BoardLayout, pin: &str) -> SimRig {
        let mut rig = SimRig::connect(SimBoard::new(layout));
        rig.apply_flow(
            vec![node("ir", "Proximity", json!({ "pin": pin, "controller": "GP2Y0A21YK" }))],
            vec![],
        );
        rig
    }

    fn distance(rig: &SimRig) -> f64 {
        match rig.last_value("ir") {
            Some(ComponentValue::Number(cm)) => *cm,
            other => panic!("no distance: {other:?} / {:?}", rig.events()),
        }
    }

    #[test]
    fn numeric_pin_reads_and_converts_to_centimetres() {
        let mut rig = proximity("15");
        assert_eq!(rig.board.pin(15).mode(), Some(MODE_ANALOG));
        rig.board.set_analog(15, 307); // ≈ 1.5 V → ≈ 25.8 cm
        rig.sample();
        assert!((distance(&rig) - 25.8).abs() < 0.1, "{}", distance(&rig));
    }

    /// The node's default pin is `"A0"`, which resolved to Firmata pin 0 (the
    /// serial RX pin) — the bug the Sensor node had and fixed.
    #[test]
    fn default_a0_label_reads_analog_channel_zero() {
        let mut rig = proximity("A0");
        assert_eq!(rig.board.pin(14).mode(), Some(MODE_ANALOG));
        assert!(rig.board.is_reporting_analog(0), "{:?}", rig.board.violations());
        rig.board.set_analog(14, 307);
        rig.sample();
        assert!((distance(&rig) - 25.8).abs() < 0.1, "{}", distance(&rig));
    }

    /// The same label on a Mega reads its A0, pin 54.
    #[test]
    fn a0_label_follows_the_board() {
        let mut rig = proximity_on(BoardLayout::mega2560(), "A0");
        assert_eq!(rig.board.pin(54).mode(), Some(MODE_ANALOG));
        rig.board.set_analog(54, 307);
        rig.sample();
        assert!((distance(&rig) - 25.8).abs() < 0.1, "{}", distance(&rig));
    }
}
