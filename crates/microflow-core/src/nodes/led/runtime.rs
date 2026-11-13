//! LED Component — Output. Template port for the workflow node fan-out.

use crate::runtime::{
    pin_mode, Component, ComponentBase, ComponentBuilder, ComponentValue, HardwareComponent,
    RuntimeContext, RuntimeError,
};

use super::config::LedConfig;

pub(crate) struct Led {
    base: ComponentBase,
    config: LedConfig,
    is_on: bool,
    brightness_value: u8,
    /// Whether the pin is in PWM mode (set by the first `value`). `StandardFirmata`
    /// ignores digital writes to a PWM pin, so `true`/`false`/`toggle` must put
    /// it back into OUTPUT first — as Arduino's `digitalWrite` turns PWM off.
    pwm: bool,
}

impl Led {
    #[must_use]
    pub(crate) fn new(id: String, config: LedConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            is_on: false,
            brightness_value: 255,
            pwm: false,
        }
    }

    /// Leave PWM mode before a digital write, or the firmware drops the write.
    fn digital_mode(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        if self.pwm {
            ctx.board().set_pin_mode(self.config.pin, pin_mode::OUTPUT)?;
            self.pwm = false;
        }
        Ok(())
    }

    fn turn_on(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.digital_mode(ctx)?;
        ctx.board().digital_write(self.config.pin, true)?;
        self.is_on = true;
        self.base.set_value(ComponentValue::Number(1.0));
        Ok(())
    }

    fn turn_off(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.digital_mode(ctx)?;
        ctx.board().digital_write(self.config.pin, false)?;
        self.is_on = false;
        self.base.set_value(ComponentValue::Number(0.0));
        Ok(())
    }

    fn toggle(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        if self.is_on {
            self.turn_off(ctx)
        } else {
            self.turn_on(ctx)
        }
    }

    fn brightness(&mut self, ctx: &mut RuntimeContext, value: u8) -> Result<(), RuntimeError> {
        // Enter PWM once: `StandardFirmata` answers every PWM `SET_PIN_MODE`
        // with `analogWrite(pin, 0)`, so re-sending it per value flickers off.
        if !self.pwm {
            ctx.board().set_pin_mode(self.config.pin, pin_mode::PWM)?;
            self.pwm = true;
        }
        ctx.board().analog_write(self.config.pin, u16::from(value))?;
        self.brightness_value = value;
        self.is_on = value > 0;
        self.base.set_value(ComponentValue::Number(f64::from(value) / 255.0));
        Ok(())
    }
}

impl Component for Led {
    fn ports() -> &'static [&'static str] {
        &["true", "false", "toggle", "value"]
    }

    fn emits() -> &'static [&'static str] {
        // Only the implicit value emit (turn_on/off/toggle/brightness → set_value).
        &[ComponentBase::VALUE_HANDLE]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Led"
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
            "true" => self.turn_on(ctx),
            "false" => self.turn_off(ctx),
            "toggle" => self.toggle(ctx),
            "value" => self.brightness(ctx, args.as_u8().unwrap_or(255)),
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}

impl HardwareComponent for Led {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().set_pin_mode(self.config.pin, pin_mode::OUTPUT)?;
        ctx.board().digital_write(self.config.pin, false)?;
        Ok(())
    }

    /// An LED is a plain output: light it again as it was. 1.0 is on (a
    /// digital HIGH), a fraction is a PWM duty. Mirrors `turn_on` /
    /// `brightness` without their `set_value` emit.
    fn restore_output(
        &mut self,
        last: &ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        let Some(level) = last.as_number().filter(|l| *l > 0.0) else { return Ok(()) };
        if level >= 1.0 {
            ctx.board().digital_write(self.config.pin, true)?;
        } else {
            let duty = (level * 255.0).round() as u8;
            ctx.board().set_pin_mode(self.config.pin, pin_mode::PWM)?;
            ctx.board().analog_write(self.config.pin, u16::from(duty))?;
            self.pwm = true;
            self.brightness_value = duty;
        }
        self.is_on = true;
        self.set_value(last.clone());
        Ok(())
    }
}

impl ComponentBuilder for Led {
    type Config = LedConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

#[cfg(test)]
mod sim_tests {
    use crate::firmata::sim::rig::{node, SimRig};
    use crate::firmata::sim::{BoardLayout, SimBoard};
    use crate::firmata::{MODE_OUTPUT, MODE_PWM};
    use crate::runtime::ComponentValue;
    use serde_json::json;

    fn led_on(pin: u8) -> SimRig {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(vec![node("led", "Led", json!({ "pin": pin }))], vec![]);
        rig
    }

    #[test]
    fn initialize_makes_the_pin_an_output_driven_low() {
        let rig = led_on(13);
        assert_eq!(rig.board.pin(13).mode(), Some(MODE_OUTPUT));
        assert!(!rig.board.pin(13).is_high());
        assert!(rig.board.violations().is_empty(), "{:?}", rig.board.violations());
    }

    #[test]
    fn true_false_and_toggle_drive_the_pin() {
        let mut rig = led_on(13);
        rig.dispatch("led", "true", true);
        assert!(rig.board.pin(13).is_high());
        rig.dispatch("led", "false", true);
        assert!(!rig.board.pin(13).is_high());
        rig.dispatch("led", "toggle", true);
        assert!(rig.board.pin(13).is_high());
        rig.dispatch("led", "toggle", true);
        assert!(!rig.board.pin(13).is_high());
        assert_eq!(rig.last_value("led"), Some(&ComponentValue::Number(0.0)));
    }

    #[test]
    fn value_sets_pwm_duty_on_a_pwm_pin() {
        let mut rig = led_on(9);
        rig.dispatch("led", "value", 128.0);
        assert_eq!(rig.board.pin(9).pwm(), Some(128));
        rig.dispatch("led", "value", 300.0);
        assert_eq!(rig.board.pin(9).pwm(), Some(255), "clamped to 8 bits");
        assert!(rig.board.violations().is_empty(), "{:?}", rig.board.violations());
    }

    /// The firmware drops a digital write to a pin in PWM mode, so after a
    /// `value` the `true` / `false` / `toggle` ports used to go dead.
    #[test]
    fn digital_ports_still_work_after_a_brightness_value() {
        let mut rig = led_on(9);
        rig.dispatch("led", "value", 40.0);
        rig.dispatch("led", "true", true);
        assert_eq!(rig.board.pin(9).mode(), Some(MODE_OUTPUT));
        assert!(rig.board.pin(9).is_high());
        rig.dispatch("led", "value", 200.0);
        assert_eq!(rig.board.pin(9).mode(), Some(MODE_PWM));
        assert_eq!(rig.board.pin(9).pwm(), Some(200));
        rig.dispatch("led", "false", true);
        assert!(!rig.board.pin(9).is_high());
    }

    /// On a pin without PWM (pin 13 on an Uno) `StandardFirmata` refuses the
    /// PWM mode and drops the analog write, so `value` does nothing; a sketch's
    /// `analogWrite` on the same pin thresholds at 128 instead.
    #[test]
    #[ignore = "open (no track): Led value on a non-PWM pin is dropped by the firmware; the runtime has no pin capabilities to fall back to digital"]
    fn value_on_a_pin_without_pwm_still_lights_the_led() {
        let mut rig = led_on(13);
        rig.dispatch("led", "value", 200.0);
        assert!(rig.board.pin(13).level(), "{:?}", rig.board.violations());
    }
}
