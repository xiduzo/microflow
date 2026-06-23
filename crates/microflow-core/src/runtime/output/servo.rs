//! Servo Component — Output. Template port for the workflow node fan-out.

use crate::runtime::{
    pin_mode, Component, ComponentBase, ComponentBuilder, ComponentValue, HardwareComponent,
    RuntimeContext, RuntimeError,
};

pub use crate::config::servo::{ServoConfig, ServoRange, ServoType};

pub struct Servo {
    base: ComponentBase,
    config: ServoConfig,
    current_position: u16,
}

impl Servo {
    #[must_use]
    pub fn new(id: String, config: ServoConfig) -> Self {
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
