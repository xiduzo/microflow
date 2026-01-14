//! Servo Component - Output

use crate::runtime::base::{
    pin_mode, BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use firmata_rs::Firmata;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ServoType { Standard, Continuous }

impl Default for ServoType { fn default() -> Self { ServoType::Standard } }

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
    #[serde(default = "default_pin")]
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
    pub fn new(id: String, config: ServoConfig) -> Self {
        let initial_pos = (config.range.min + config.range.max) / 2;
        Self { base: ComponentBase::new(id, ComponentValue::Number(initial_pos as f64)), config, board: None, current_position: initial_pos }
    }

    pub fn min(&mut self) -> Result<(), String> { self.to(self.config.range.min as f64) }
    pub fn max(&mut self) -> Result<(), String> { self.to(self.config.range.max as f64) }

    pub fn to(&mut self, position: f64) -> Result<(), String> {
        if position.is_nan() { return Ok(()); }
        let clamped = position.clamp(self.config.range.min as f64, self.config.range.max as f64) as u16;
        if let Some(board) = &self.board {
            board.with_board(|conn| conn.board.analog_write(self.config.pin as i32, clamped as i32).map_err(|e| format!("Failed to write servo: {}", e)))?;
        }
        self.current_position = clamped;
        self.base.value = ComponentValue::Number(clamped as f64);
        self.base.emit("change");
        Ok(())
    }

    pub fn rotate(&mut self, speed: f64) -> Result<(), String> {
        if self.config.r#type != ServoType::Continuous { return Err("Rotate only works with continuous servos".to_string()); }
        let servo_value = if speed.abs() < 0.05 { 90 } else { ((speed + 1.0) * 90.0).clamp(0.0, 180.0) as u16 };
        if let Some(board) = &self.board {
            board.with_board(|conn| conn.board.analog_write(self.config.pin as i32, servo_value as i32).map_err(|e| format!("Failed to write servo: {}", e)))?;
        }
        self.base.value = ComponentValue::Number(speed);
        self.base.emit("change");
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> { self.rotate(0.0) }
}

impl Component for Servo {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Servo" }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String> {
        board.with_board(|conn| conn.set_pin_mode(self.config.pin, pin_mode::SERVO))?;
        self.board = Some(board);
        let center = (self.config.range.min + self.config.range.max) / 2;
        self.to(center as f64)
    }

    fn update_config(&mut self, config: serde_json::Value) -> Result<(), String> {
        let new: ServoConfig = serde_json::from_value(config).map_err(|e| format!("Invalid config: {}", e))?;
        if new.pin != self.config.pin { return Err(format!("Cannot change pin from {} to {}", self.config.pin, new.pin)); }
        self.config = new;
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "min" => self.min(),
            "max" => self.max(),
            "to" => self.to(args.as_number().unwrap_or(90.0)),
            "rotate" => self.rotate(args.as_number().unwrap_or(0.0)),
            "stop" => self.stop(),
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) { let _ = self.to((self.config.range.min + self.config.range.max) as f64 / 2.0); self.board = None; }
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
