//! RGB LED Component - Output

use crate::runtime::base::{
    pin_mode, BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RgbPins {
    #[serde(default = "default_red")]
    pub red: u8,
    #[serde(default = "default_green")]
    pub green: u8,
    #[serde(default = "default_blue")]
    pub blue: u8,
}

fn default_red() -> u8 { 9 }
fn default_green() -> u8 { 10 }
fn default_blue() -> u8 { 11 }

impl Default for RgbPins {
    fn default() -> Self { Self { red: default_red(), green: default_green(), blue: default_blue() } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RgbConfig {
    #[serde(default)]
    pub pins: RgbPins,
    #[serde(default)]
    pub is_anode: bool,
}

impl Default for RgbConfig {
    fn default() -> Self { Self { pins: RgbPins::default(), is_anode: false } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RgbaColor { pub r: u8, pub g: u8, pub b: u8, pub a: f64 }

impl Default for RgbaColor {
    fn default() -> Self { Self { r: 0, g: 0, b: 0, a: 1.0 } }
}

impl From<RgbaColor> for ComponentValue {
    fn from(c: RgbaColor) -> Self { ComponentValue::Rgba { r: c.r, g: c.g, b: c.b, a: c.a } }
}

pub struct Rgb {
    base: ComponentBase,
    config: RgbConfig,
    board: Option<Arc<BoardHandle>>,
    color: RgbaColor,
}

impl Rgb {
    pub fn new(id: String, config: RgbConfig) -> Self {
        Self { base: ComponentBase::new(id, RgbaColor::default().into()), config, board: None, color: RgbaColor::default() }
    }

    pub fn red(&mut self, value: u8) -> Result<(), String> { self.color.r = value; self.update_hardware() }
    pub fn green(&mut self, value: u8) -> Result<(), String> { self.color.g = value; self.update_hardware() }
    pub fn blue(&mut self, value: u8) -> Result<(), String> { self.color.b = value; self.update_hardware() }
    pub fn alpha(&mut self, value: f64) -> Result<(), String> { self.color.a = (value / 100.0).clamp(0.0, 1.0); self.update_hardware() }

    pub fn off(&mut self) -> Result<(), String> { self.color = RgbaColor::default(); self.update_hardware() }

    fn update_hardware(&mut self) -> Result<(), String> {
        if let Some(board) = &self.board {
            let (r, g, b) = self.apply_intensity();
            let (r, g, b) = self.apply_anode(r, g, b);
            board.with_board(|conn| {
                conn.analog_write(self.config.pins.red, r as u16)?;
                conn.analog_write(self.config.pins.green, g as u16)?;
                conn.analog_write(self.config.pins.blue, b as u16)
            })?;
        }
        self.base.value = self.color.clone().into();
        self.base.emit("change");
        Ok(())
    }

    fn apply_intensity(&self) -> (u8, u8, u8) {
        ((self.color.r as f64 * self.color.a) as u8, (self.color.g as f64 * self.color.a) as u8, (self.color.b as f64 * self.color.a) as u8)
    }

    fn apply_anode(&self, r: u8, g: u8, b: u8) -> (u8, u8, u8) {
        if self.config.is_anode { (255 - r, 255 - g, 255 - b) } else { (r, g, b) }
    }
}

impl Component for Rgb {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Rgb" }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String> {
        board.with_board(|conn| {
            conn.set_pin_mode(self.config.pins.red, pin_mode::PWM)?;
            conn.set_pin_mode(self.config.pins.green, pin_mode::PWM)?;
            conn.set_pin_mode(self.config.pins.blue, pin_mode::PWM)
        })?;
        self.board = Some(board);
        self.off()
    }

    fn update_config(&mut self, config: serde_json::Value) -> Result<(), String> {
        let new: RgbConfig = serde_json::from_value(config).map_err(|e| format!("Invalid config: {}", e))?;
        if new.pins.red != self.config.pins.red || new.pins.green != self.config.pins.green || new.pins.blue != self.config.pins.blue {
            return Err("Cannot change pins at runtime".to_string());
        }
        self.config = new;
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "red" => self.red(args.as_u8().unwrap_or(0)),
            "green" => self.green(args.as_u8().unwrap_or(0)),
            "blue" => self.blue(args.as_u8().unwrap_or(0)),
            "alpha" => self.alpha(args.as_number().unwrap_or(100.0)),
            "off" => self.off(),
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) { let _ = self.off(); self.board = None; }
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
