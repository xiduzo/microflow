//! Relay Component - Output

use crate::runtime::base::{
    pin_mode, BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RelayType { NO, NC }

impl Default for RelayType { fn default() -> Self { RelayType::NO } }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayConfig {
    #[serde(default = "default_pin")]
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
    pub fn new(id: String, config: RelayConfig) -> Self {
        Self { base: ComponentBase::new(id, ComponentValue::Bool(false)), config, board: None, is_open: false }
    }

    pub fn open(&mut self) -> Result<(), String> {
        let signal = matches!(self.config.r#type, RelayType::NO);
        if let Some(board) = &self.board {
            board.with_board(|conn| conn.digital_write(self.config.pin, signal))?;
        }
        self.is_open = true;
        self.base.value = ComponentValue::Bool(true);
        self.base.emit("change");
        Ok(())
    }

    pub fn close(&mut self) -> Result<(), String> {
        let signal = matches!(self.config.r#type, RelayType::NC);
        if let Some(board) = &self.board {
            board.with_board(|conn| conn.digital_write(self.config.pin, signal))?;
        }
        self.is_open = false;
        self.base.value = ComponentValue::Bool(false);
        self.base.emit("change");
        Ok(())
    }

    pub fn toggle(&mut self) -> Result<(), String> {
        if self.is_open { self.close() } else { self.open() }
    }
}

impl Component for Relay {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Relay" }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String> {
        board.with_board(|conn| conn.set_pin_mode(self.config.pin, pin_mode::OUTPUT))?;
        self.board = Some(board);
        self.close()
    }

    fn update_config(&mut self, config: serde_json::Value) -> Result<(), String> {
        let new: RelayConfig = serde_json::from_value(config).map_err(|e| format!("Invalid config: {}", e))?;
        if new.pin != self.config.pin { return Err(format!("Cannot change pin from {} to {}", self.config.pin, new.pin)); }
        self.config = new;
        Ok(())
    }

    fn call_method(&mut self, method: &str, _args: ComponentValue) -> Result<(), String> {
        match method {
            "open" => self.open(),
            "close" => self.close(),
            "toggle" => self.toggle(),
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) { let _ = self.close(); self.board = None; }
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
