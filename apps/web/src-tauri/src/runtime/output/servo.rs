//! Servo Component - Output

use crate::runtime::base::{
    pin_mode, serde_utils, BoardHandle, Component, ComponentBase, ComponentValue,
    HardwareComponent,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ServoType {
    #[default]
    Standard,
    Continuous,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServoRange {
    #[serde(default = "default_min")]
    pub min: u16,
    #[serde(default = "default_max")]
    pub max: u16,
}

fn default_min() -> u16 { 0 }
fn default_max() -> u16 { 180 }

impl Default for ServoRange {
    fn default() -> Self { Self { min: default_min(), max: default_max() } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServoConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default)]
    pub range: ServoRange,
    #[serde(default)]
    pub r#type: ServoType,
}

fn default_pin() -> u8 { 3 }

impl Default for ServoConfig {
    fn default() -> Self { Self { pin: default_pin(), range: ServoRange::default(), r#type: ServoType::default() } }
}

pub struct Servo {
    base: ComponentBase,
    config: ServoConfig,
    board: Option<Arc<BoardHandle>>,
    current_position: u16,
}

impl Servo {
    #[must_use] 
    pub fn new(id: String, config: ServoConfig) -> Self {
        let initial_pos = (config.range.min + config.range.max) / 2;
        Self { base: ComponentBase::new(id, ComponentValue::Number(f64::from(initial_pos))), config, board: None, current_position: initial_pos }
    }

    pub fn min(&mut self) -> Result<(), crate::error::RuntimeError> { self.to(f64::from(self.config.range.min)) }
    pub fn max(&mut self) -> Result<(), crate::error::RuntimeError> { self.to(f64::from(self.config.range.max)) }

    pub fn to(&mut self, position: f64) -> Result<(), crate::error::RuntimeError> {
        if position.is_nan() { return Ok(()); }
        let clamped = position.clamp(f64::from(self.config.range.min), f64::from(self.config.range.max)) as u16;
        if let Some(board) = &self.board {
            board.analog_write(self.config.pin, clamped)?;
        }
        self.current_position = clamped;
        self.base.set_value(ComponentValue::Number(f64::from(clamped)));
        Ok(())
    }

    pub fn rotate(&mut self, speed: f64) -> Result<(), crate::error::RuntimeError> {
        if self.config.r#type != ServoType::Continuous { return Err(crate::error::RuntimeError::ComponentError("Rotate only works with continuous servos".to_string())); }
        let servo_value = if speed.abs() < 0.05 { 90 } else { ((speed + 1.0) * 90.0).clamp(0.0, 180.0) as u16 };
        if let Some(board) = &self.board {
            board.analog_write(self.config.pin, servo_value)?;
        }
        self.base.set_value(ComponentValue::Number(speed));
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), crate::error::RuntimeError> { self.rotate(0.0) }
}

impl Component for Servo {
    fn ports() -> &'static [&'static str] { &["min", "max", "value", "rotate", "stop"] }

    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Servo" }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> { Some(self) }

    fn dispatch(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "min" => self.min(),
            "max" => self.max(),
            "value" => match self.config.r#type {
                ServoType::Standard => self.to(args.as_number().unwrap_or(90.0)),
                ServoType::Continuous => self.rotate(args.as_number().unwrap_or(0.0)),
            },
            "rotate" => self.rotate(args.as_number().unwrap_or(0.0)),
            "stop" => self.stop(),
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) { let _ = self.to(f64::from(self.config.range.min + self.config.range.max) / 2.0); self.board = None; }
}

impl HardwareComponent for Servo {
    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        board.set_pin_mode(self.config.pin, pin_mode::SERVO)?;
        self.board = Some(board);
        let center = (self.config.range.min + self.config.range.max) / 2;
        self.to(f64::from(center))
    }
}
