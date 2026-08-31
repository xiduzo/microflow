//! RGB LED Component — Output. Template port for the workflow node fan-out.

use crate::runtime::{
    pin_mode, Component, ComponentBase, ComponentBuilder, ComponentValue,
    HardwareComponent, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};

pub use crate::config::rgb::{RgbConfig, RgbPins};


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RgbaColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: f64,
}

impl Default for RgbaColor {
    fn default() -> Self {
        Self { r: 0, g: 0, b: 0, a: 1.0 }
    }
}

impl From<RgbaColor> for ComponentValue {
    fn from(c: RgbaColor) -> Self {
        ComponentValue::Rgba { r: c.r, g: c.g, b: c.b, a: c.a }
    }
}

pub struct Rgb {
    base: ComponentBase,
    config: RgbConfig,
    color: RgbaColor,
}

impl Rgb {
    #[must_use]
    pub fn new(id: String, config: RgbConfig) -> Self {
        Self {
            base: ComponentBase::new(id, RgbaColor::default().into()),
            config,
            color: RgbaColor::default(),
        }
    }

    fn red(&mut self, ctx: &mut RuntimeContext, value: u8) -> Result<(), RuntimeError> {
        self.color.r = value;
        self.update_hardware(ctx)
    }

    fn green(&mut self, ctx: &mut RuntimeContext, value: u8) -> Result<(), RuntimeError> {
        self.color.g = value;
        self.update_hardware(ctx)
    }

    fn blue(&mut self, ctx: &mut RuntimeContext, value: u8) -> Result<(), RuntimeError> {
        self.color.b = value;
        self.update_hardware(ctx)
    }

    fn alpha(&mut self, ctx: &mut RuntimeContext, value: f64) -> Result<(), RuntimeError> {
        self.color.a = (value / 100.0).clamp(0.0, 1.0);
        self.update_hardware(ctx)
    }

    fn off(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.color = RgbaColor::default();
        self.update_hardware(ctx)
    }

    fn update_hardware(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        let (r, g, b) = self.apply_intensity();
        let (r, g, b) = self.apply_anode(r, g, b);
        ctx.board().analog_write(self.config.pins.red, u16::from(r))?;
        ctx.board().analog_write(self.config.pins.green, u16::from(g))?;
        ctx.board().analog_write(self.config.pins.blue, u16::from(b))?;
        self.base.set_value(self.color.clone().into());
        Ok(())
    }

    fn apply_intensity(&self) -> (u8, u8, u8) {
        (
            (f64::from(self.color.r) * self.color.a) as u8,
            (f64::from(self.color.g) * self.color.a) as u8,
            (f64::from(self.color.b) * self.color.a) as u8,
        )
    }

    fn apply_anode(&self, r: u8, g: u8, b: u8) -> (u8, u8, u8) {
        if self.config.is_anode {
            (255 - r, 255 - g, 255 - b)
        } else {
            (r, g, b)
        }
    }
}

impl Component for Rgb {
    fn ports() -> &'static [&'static str] {
        &["red", "green", "blue", "alpha", "off"]
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
        "Rgb"
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
            "red" => self.red(ctx, args.as_u8().unwrap_or(0)),
            "green" => self.green(ctx, args.as_u8().unwrap_or(0)),
            "blue" => self.blue(ctx, args.as_u8().unwrap_or(0)),
            "alpha" => self.alpha(ctx, args.as_number().unwrap_or(100.0)),
            "off" => self.off(ctx),
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}

impl HardwareComponent for Rgb {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().set_pin_mode(self.config.pins.red, pin_mode::PWM)?;
        ctx.board().set_pin_mode(self.config.pins.green, pin_mode::PWM)?;
        ctx.board().set_pin_mode(self.config.pins.blue, pin_mode::PWM)?;
        self.off(ctx)
    }
}

impl ComponentBuilder for Rgb {
    type Config = RgbConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
