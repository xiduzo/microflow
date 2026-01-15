//! LED Component - Output

use crate::runtime::base::{
    pin_mode, serde_utils, BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
}

fn default_pin() -> u8 { 13 }

impl Default for LedConfig {
    fn default() -> Self { Self { pin: default_pin() } }
}

pub struct Led {
    base: ComponentBase,
    config: LedConfig,
    board: Option<Arc<BoardHandle>>,
    is_on: bool,
    brightness_value: u8,
    blink_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Led {
    pub fn new(id: String, config: LedConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config, board: None, is_on: false, brightness_value: 255, blink_handle: None,
        }
    }

    pub fn turn_on(&mut self) -> Result<(), String> {
        self.stop_blink();
        if let Some(board) = &self.board {
            board.with_board(|conn| conn.digital_write(self.config.pin, true))?;
        }
        self.is_on = true;
        self.base.value = ComponentValue::Number(1.0);
        self.base.emit("change");
        Ok(())
    }

    pub fn turn_off(&mut self) -> Result<(), String> {
        self.stop_blink();
        if let Some(board) = &self.board {
            board.with_board(|conn| conn.digital_write(self.config.pin, false))?;
        }
        self.is_on = false;
        self.base.value = ComponentValue::Number(0.0);
        self.base.emit("change");
        Ok(())
    }

    pub fn toggle(&mut self) -> Result<(), String> {
        if self.is_on { self.turn_off() } else { self.turn_on() }
    }

    pub fn brightness(&mut self, value: u8) -> Result<(), String> {
        self.stop_blink();
        if let Some(board) = &self.board {
            board.with_board(|conn| {
                conn.set_pin_mode(self.config.pin, pin_mode::PWM)?;
                conn.analog_write(self.config.pin, value as u16)
            })?;
        }
        self.brightness_value = value;
        self.is_on = value > 0;
        self.base.value = ComponentValue::Number(value as f64 / 255.0);
        self.base.emit("change");
        Ok(())
    }

    fn stop_blink(&mut self) {
        if let Some(handle) = self.blink_handle.take() { handle.abort(); }
    }
}

impl Component for Led {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Led" }
    fn requires_hardware(&self) -> bool { true }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String> {
        board.with_board(|conn| {
            conn.set_pin_mode(self.config.pin, pin_mode::OUTPUT)?;
            conn.digital_write(self.config.pin, false)
        })?;
        self.board = Some(board);
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "turnOn" => self.turn_on(),
            "turnOff" => self.turn_off(),
            "toggle" => self.toggle(),
            "brightness" => self.brightness(args.as_u8().unwrap_or(255)),
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) { 
        self.stop_blink(); 
        let _ = self.turn_off(); 
        self.board = None; 
    }
    
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
