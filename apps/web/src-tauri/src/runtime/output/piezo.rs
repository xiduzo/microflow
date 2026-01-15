//! Piezo Buzzer Component - Output

use crate::runtime::base::{
    pin_mode, serde_utils, BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PiezoType { Buzz, Song }

impl Default for PiezoType { fn default() -> Self { PiezoType::Buzz } }

pub type Note = (Option<String>, u32);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiezoConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default)]
    pub r#type: PiezoType,
    #[serde(default = "default_duration")]
    pub duration: u32,
    #[serde(default = "default_frequency")]
    pub frequency: u32,
    #[serde(default)]
    pub song: Vec<Note>,
    #[serde(default = "default_tempo")]
    pub tempo: u32,
}

fn default_pin() -> u8 { 11 }
fn default_duration() -> u32 { 500 }
fn default_frequency() -> u32 { 440 }
fn default_tempo() -> u32 { 120 }

impl Default for PiezoConfig {
    fn default() -> Self {
        Self { pin: default_pin(), r#type: PiezoType::default(), duration: default_duration(), frequency: default_frequency(), song: Vec::new(), tempo: default_tempo() }
    }
}

pub struct Piezo {
    base: ComponentBase,
    config: PiezoConfig,
    board: Option<Arc<BoardHandle>>,
    is_playing: bool,
    stop_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Piezo {
    pub fn new(id: String, config: PiezoConfig) -> Self {
        Self { base: ComponentBase::new(id, ComponentValue::Bool(false)), config, board: None, is_playing: false, stop_handle: None }
    }

    pub fn buzz(&mut self) -> Result<(), String> {
        self.stop()?;
        if self.config.r#type != PiezoType::Buzz { return Ok(()); }
        if let Some(board) = &self.board {
            board.with_board(|conn| conn.analog_write(self.config.pin, 128))?;
        }
        self.is_playing = true;
        self.base.set_value(ComponentValue::Bool(true));
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(handle) = self.stop_handle.take() { handle.abort(); }
        if let Some(board) = &self.board {
            board.with_board(|conn| conn.analog_write(self.config.pin, 0))?;
        }
        self.is_playing = false;
        self.base.set_value(ComponentValue::Bool(false));
        Ok(())
    }

    pub fn play(&mut self) -> Result<(), String> {
        self.stop()?;
        if self.config.r#type != PiezoType::Song { return Ok(()); }
        self.is_playing = true;
        self.base.set_value(ComponentValue::Bool(true));
        Ok(())
    }
}

impl Component for Piezo {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Piezo" }
    fn requires_hardware(&self) -> bool { true }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String> {
        board.with_board(|conn| {
            conn.set_pin_mode(self.config.pin, pin_mode::PWM)?;
            conn.analog_write(self.config.pin, 0)
        })?;
        self.board = Some(board);
        Ok(())
    }

    fn call_method(&mut self, method: &str, _args: ComponentValue) -> Result<(), String> {
        match method {
            "buzz" => self.buzz(),
            "stop" => self.stop(),
            "play" => self.play(),
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) { let _ = self.stop(); self.board = None; }
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
