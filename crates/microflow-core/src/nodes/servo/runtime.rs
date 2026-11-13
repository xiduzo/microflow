//! Servo Component — Output. Template port for the workflow node fan-out.

use crate::runtime::{
    pin_mode, Component, ComponentBase, ComponentBuilder, ComponentValue, HardwareComponent,
    RuntimeContext, RuntimeError,
};

use super::config::{ServoConfig, ServoType};

pub(crate) struct Servo {
    base: ComponentBase,
    config: ServoConfig,
    current_position: u16,
}

impl Servo {
    #[must_use]
    pub(crate) fn new(id: String, config: ServoConfig) -> Self {
        let initial_pos = (config.range.min + config.range.max) / 2;
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(f64::from(initial_pos))),
            config,
            current_position: initial_pos,
        }
    }

    fn min(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.to(f64::from(self.config.range.min), ctx)
    }

    fn max(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.to(f64::from(self.config.range.max), ctx)
    }

    fn to(&mut self, position: f64, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        if position.is_nan() {
            return Ok(());
        }
        let clamped =
            position.clamp(f64::from(self.config.range.min), f64::from(self.config.range.max)) as u16;
        ctx.board().analog_write(self.config.pin, clamped)?;
        self.current_position = clamped;
        self.base.set_value(ComponentValue::Number(f64::from(clamped)));
        Ok(())
    }

    fn rotate(&mut self, speed: f64, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        if self.config.r#type != ServoType::Continuous {
            return Err(RuntimeError::ComponentError(
                "Rotate only works with continuous servos".to_string(),
            ));
        }
        let servo_value = if speed.abs() < 0.05 {
            90
        } else {
            ((speed + 1.0) * 90.0).clamp(0.0, 180.0) as u16
        };
        ctx.board().analog_write(self.config.pin, servo_value)?;
        self.base.set_value(ComponentValue::Number(speed));
        Ok(())
    }

    fn stop(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.rotate(0.0, ctx)
    }
}

impl Component for Servo {
    fn ports() -> &'static [&'static str] {
        &["min", "max", "value", "rotate", "stop"]
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
        "Servo"
    }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> {
        Some(self)
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "min" => self.min(ctx),
            "max" => self.max(ctx),
            "value" => match self.config.r#type {
                ServoType::Standard => self.to(args.as_number().unwrap_or(90.0), ctx),
                ServoType::Continuous => self.rotate(args.as_number().unwrap_or(0.0), ctx),
            },
            "rotate" => self.rotate(args.as_number().unwrap_or(0.0), ctx),
            "stop" => self.stop(ctx),
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}

impl HardwareComponent for Servo {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().set_pin_mode(self.config.pin, pin_mode::SERVO)?;
        let center = (self.config.range.min + self.config.range.max) / 2;
        self.to(f64::from(center), ctx)
    }
}

impl ComponentBuilder for Servo {
    type Config = ServoConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

#[cfg(test)]
mod sim_tests {
    use crate::firmata::sim::rig::{node, SimRig};
    use crate::firmata::sim::{BoardLayout, SimBoard};
    use crate::firmata::MODE_SERVO;
    use serde_json::json;

    fn servo_on(layout: BoardLayout, data: serde_json::Value) -> SimRig {
        let mut rig = SimRig::connect(SimBoard::new(layout));
        rig.apply_flow(vec![node("servo", "Servo", data)], vec![]);
        rig
    }

    #[test]
    fn initialize_attaches_the_servo_and_centres_it() {
        let rig = servo_on(BoardLayout::uno(), json!({ "pin": 3, "range": { "min": 20, "max": 160 } }));
        assert_eq!(rig.board.pin(3).mode(), Some(MODE_SERVO));
        assert_eq!(rig.board.pin(3).servo(), Some(90));
        assert!(rig.board.violations().is_empty(), "{:?}", rig.board.violations());
    }

    #[test]
    fn value_min_and_max_move_within_the_range() {
        let mut rig = servo_on(BoardLayout::uno(), json!({ "pin": 3, "range": { "min": 20, "max": 160 } }));
        rig.dispatch("servo", "value", 45.0);
        assert_eq!(rig.board.pin(3).servo(), Some(45));
        rig.dispatch("servo", "value", 170.0);
        assert_eq!(rig.board.pin(3).servo(), Some(160), "clamped to range.max");
        rig.dispatch("servo", "min", true);
        assert_eq!(rig.board.pin(3).servo(), Some(20));
        rig.dispatch("servo", "max", true);
        assert_eq!(rig.board.pin(3).servo(), Some(160));
    }

    #[test]
    fn continuous_servo_maps_speed_onto_the_pulse_and_stops_at_90() {
        let mut rig = servo_on(BoardLayout::uno(), json!({ "pin": 5, "type": "continuous" }));
        rig.dispatch("servo", "rotate", 1.0);
        assert_eq!(rig.board.pin(5).servo(), Some(180));
        rig.dispatch("servo", "value", -0.5);
        assert_eq!(rig.board.pin(5).servo(), Some(45));
        rig.dispatch("servo", "stop", true);
        assert_eq!(rig.board.pin(5).servo(), Some(90));
    }

    /// `ANALOG_MESSAGE` carries the pin in its status byte's low nibble, so a
    /// servo on a Mega pin past 15 must go out as `EXTENDED_ANALOG` or it lands
    /// on `pin & 0x0F` (44 → 12).
    #[test]
    fn servo_on_a_mega_pin_past_15_moves() {
        let mut rig = servo_on(BoardLayout::mega2560(), json!({ "pin": 44 }));
        rig.dispatch("servo", "value", 30.0);
        assert_eq!(rig.board.pin(44).servo(), Some(30), "{:?}", rig.board.violations());
    }
}
