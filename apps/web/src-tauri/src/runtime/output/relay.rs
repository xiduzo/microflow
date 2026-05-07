//! Relay Component - Output

use crate::runtime::base::{
    pin_mode, serde_utils, BoardCommand, BoardHandle, Component, ComponentBase, ComponentValue,
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
            board.send_command(BoardCommand::DigitalWrite { pin: self.config.pin, value: signal })?;
        }
        self.is_open = true;
        self.base.set_value(ComponentValue::Bool(true));
        Ok(())
    }

    pub fn close(&mut self) -> Result<(), crate::error::RuntimeError> {
        let signal = matches!(self.config.r#type, RelayType::NC);
        if let Some(board) = &self.board {
            board.send_command(BoardCommand::DigitalWrite { pin: self.config.pin, value: signal })?;
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
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Relay" }
    fn requires_hardware(&self) -> bool { true }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        board.send_command(BoardCommand::SetPinMode { pin: self.config.pin, mode: pin_mode::OUTPUT })?;
        self.board = Some(board);
        self.close()
    }

    fn call_method(&mut self, method: &str, _args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "true" => self.open(),
            "false" => self.close(),
            "toggle" => self.toggle(),
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) { let _ = self.close(); self.board = None; }
}
