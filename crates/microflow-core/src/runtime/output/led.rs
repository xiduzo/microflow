//! LED Component — Output. Template port for the workflow node fan-out.

use crate::runtime::{
    pin_mode, Component, ComponentBase, ComponentBuilder, ComponentValue, HardwareComponent,
    RuntimeContext, RuntimeError,
};

pub use crate::config::led::LedConfig;

pub struct Led {
    base: ComponentBase,
    config: LedConfig,
    is_on: bool,
    brightness_value: u8,
}

impl Led {
    #[must_use]
    pub fn new(id: String, config: LedConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            is_on: false,
            brightness_value: 255,
        }
    }

    fn turn_on(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().digital_write(self.config.pin, true)?;
        self.is_on = true;
        self.base.set_value(ComponentValue::Number(1.0));
        Ok(())
    }

    fn turn_off(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
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
        ctx.board().set_pin_mode(self.config.pin, pin_mode::PWM)?;
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
}

impl ComponentBuilder for Led {
    type Config = LedConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
