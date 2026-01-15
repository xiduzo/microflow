//! Button Component - Input

use crate::runtime::base::{
    pin_mode, serde_utils, BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default)]
    pub is_pullup: bool,
    #[serde(default)]
    pub is_pulldown: bool,
    #[serde(default = "default_holdtime")]
    pub holdtime: u64,
    #[serde(default)]
    pub invert: bool,
}

fn default_pin() -> u8 { 6 }
fn default_holdtime() -> u64 { 500 }

impl Default for ButtonConfig {
    fn default() -> Self {
        Self { pin: default_pin(), is_pullup: false, is_pulldown: false, holdtime: default_holdtime(), invert: false }
    }
}

pub struct Button {
    base: ComponentBase,
    config: ButtonConfig,
    board: Option<Arc<BoardHandle>>,
    is_pressed: bool,
    press_start: Option<Instant>,
    hold_emitted: bool,
    polling_active: Arc<AtomicBool>,
    poll_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Button {
    pub fn new(id: String, config: ButtonConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config, board: None, is_pressed: false, press_start: None,
            hold_emitted: false, polling_active: Arc::new(AtomicBool::new(false)), poll_handle: None,
        }
    }

    fn read_state(&self) -> Result<bool, String> {
        if let Some(board) = &self.board {
            let raw = board.with_board(|conn| conn.digital_read(self.config.pin))?;
            Ok(if self.config.invert { !raw } else if self.config.is_pullup { !raw } else { raw })
        } else {
            Err("Board not connected".to_string())
        }
    }

    fn process_state(&mut self, pressed: bool) {
        if pressed != self.is_pressed {
            self.is_pressed = pressed;
            self.base.value = ComponentValue::Bool(pressed);
            if pressed {
                self.press_start = Some(Instant::now());
                self.hold_emitted = false;
                self.base.emit("active");
            } else {
                self.press_start = None;
                self.hold_emitted = false;
                self.base.emit("inactive");
            }
            self.base.emit("change");
        } else if pressed && !self.hold_emitted {
            if let Some(start) = self.press_start {
                if start.elapsed() >= Duration::from_millis(self.config.holdtime) {
                    self.hold_emitted = true;
                    self.base.emit("hold");
                }
            }
        }
    }

    fn stop_polling(&mut self) {
        self.polling_active.store(false, Ordering::Relaxed);
        if let Some(handle) = self.poll_handle.take() { handle.abort(); }
    }
}

impl Component for Button {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Button" }
    fn requires_hardware(&self) -> bool { true }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String> {
        let mode = if self.config.is_pullup { pin_mode::PULLUP } else { pin_mode::INPUT };
        board.with_board(|conn| {
            conn.set_pin_mode(self.config.pin, mode)?;
            conn.set_reporting(self.config.pin, true)
        })?;
        self.board = Some(board);
        self.polling_active.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn call_method(&mut self, method: &str, _args: ComponentValue) -> Result<(), String> {
        match method {
            "read" => { let state = self.read_state()?; self.process_state(state); Ok(()) }
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) { self.stop_polling(); self.board = None; }
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
