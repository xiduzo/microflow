//! LED Component - Output

use crate::runtime::base::{
    pin_mode, serde_utils, BoardHandle, Component, ComponentBase, ComponentValue,
    HardwareComponent,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

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
    #[must_use] 
    pub fn new(id: String, config: LedConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config, board: None, is_on: false, brightness_value: 255, blink_handle: None,
        }
    }

    pub fn turn_on(&mut self) -> Result<(), crate::error::RuntimeError> {
        self.stop_blink();
        if let Some(board) = &self.board {
            board.digital_write(self.config.pin, true)?;
        }
        self.is_on = true;
        self.base.set_value(ComponentValue::Number(1.0));
        Ok(())
    }

    pub fn turn_off(&mut self) -> Result<(), crate::error::RuntimeError> {
        self.stop_blink();
        if let Some(board) = &self.board {
            board.digital_write(self.config.pin, false)?;
        }
        self.is_on = false;
        self.base.set_value(ComponentValue::Number(0.0));
        Ok(())
    }

    pub fn toggle(&mut self) -> Result<(), crate::error::RuntimeError> {
        if self.is_on { self.turn_off() } else { self.turn_on() }
    }

    pub fn brightness(&mut self, value: u8) -> Result<(), crate::error::RuntimeError> {
        self.stop_blink();
        if let Some(board) = &self.board {
            board.set_pin_mode(self.config.pin, pin_mode::PWM)?;
            board.analog_write(self.config.pin, u16::from(value))?;
        }
        self.brightness_value = value;
        self.is_on = value > 0;
        self.base.set_value(ComponentValue::Number(f64::from(value) / 255.0));
        Ok(())
    }

    fn stop_blink(&mut self) {
        if let Some(handle) = self.blink_handle.take() { handle.abort(); }
    }
}

impl Component for Led {
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Led" }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> { Some(self) }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "true" => self.turn_on(),
            "false" => self.turn_off(),
            "toggle" => self.toggle(),
            "value" => self.brightness(args.as_u8().unwrap_or(255)),
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) {
        self.stop_blink();
        let _ = self.turn_off();
        self.board = None;
    }
}

impl HardwareComponent for Led {
    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        board.set_pin_mode(self.config.pin, pin_mode::OUTPUT)?;
        board.digital_write(self.config.pin, false)?;
        self.board = Some(board);
        Ok(())
    }
}
