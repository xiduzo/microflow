//! Relay Component - Output

use crate::runtime::base::{
    pin_mode, serde_utils, BoardHandle, Component, ComponentBase, ComponentValue,
    HardwareComponent,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum RelayType {
    #[default]
    NO,
    NC,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default)]
    pub r#type: RelayType,
}

fn default_pin() -> u8 { 10 }

impl Default for RelayConfig {
    fn default() -> Self { Self { pin: default_pin(), r#type: RelayType::default() } }
}

pub struct Relay {
    base: ComponentBase,
    config: RelayConfig,
    board: Option<Arc<BoardHandle>>,
    is_open: bool,
}

impl Relay {
    #[must_use] 
    pub fn new(id: String, config: RelayConfig) -> Self {
        Self { base: ComponentBase::new(id, ComponentValue::Bool(false)), config, board: None, is_open: false }
    }

    pub fn open(&mut self) -> Result<(), crate::error::RuntimeError> {
        let signal = matches!(self.config.r#type, RelayType::NO);
        if let Some(board) = &self.board {
            board.digital_write(self.config.pin, signal).ignore();
        }
        self.is_open = true;
        self.base.set_value(ComponentValue::Bool(true));
        Ok(())
    }

    pub fn close(&mut self) -> Result<(), crate::error::RuntimeError> {
        let signal = matches!(self.config.r#type, RelayType::NC);
        if let Some(board) = &self.board {
            board.digital_write(self.config.pin, signal).ignore();
        }
        self.is_open = false;
        self.base.set_value(ComponentValue::Bool(false));
        Ok(())
    }

    pub fn toggle(&mut self) -> Result<(), crate::error::RuntimeError> {
        if self.is_open { self.close() } else { self.open() }
    }
}

impl Component for Relay {
    fn ports() -> &'static [&'static str] { &["true", "false", "toggle"] }

    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Relay" }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> { Some(self) }

    fn dispatch(&mut self, method: &str, _args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "true" => self.open(),
            "false" => self.close(),
            "toggle" => self.toggle(),
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) { let _ = self.close(); self.board = None; }
}

impl HardwareComponent for Relay {
    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        board.set_pin_mode(self.config.pin, pin_mode::OUTPUT).ignore();
        self.board = Some(board);
        self.close()
    }
}
