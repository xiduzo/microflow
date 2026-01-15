//! Motion Sensor Component - Input

use crate::runtime::base::{
    pin_mode, serde_utils, BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MotionConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default = "default_controller")]
    pub controller: String,
}

fn default_pin() -> u8 { 8 }
fn default_controller() -> String { "HCSR501".to_string() }

impl Default for MotionConfig {
    fn default() -> Self { Self { pin: default_pin(), controller: default_controller() } }
}

pub struct Motion {
    base: ComponentBase,
    config: MotionConfig,
    board: Option<Arc<BoardHandle>>,
    motion_detected: bool,
    is_calibrated: bool,
    polling_active: Arc<AtomicBool>,
    poll_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Motion {
    pub fn new(id: String, config: MotionConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config, board: None, motion_detected: false, is_calibrated: false,
            polling_active: Arc::new(AtomicBool::new(false)), poll_handle: None,
        }
    }

    fn read_state(&self) -> Result<bool, String> {
        if let Some(board) = &self.board {
            board.with_board(|conn| conn.digital_read(self.config.pin))
        } else { Err("Board not connected".to_string()) }
    }

    fn process_state(&mut self, detected: bool) {
        if !self.is_calibrated { self.is_calibrated = true; }
        if detected != self.motion_detected {
            self.motion_detected = detected;
            self.base.value = ComponentValue::Bool(detected);
            self.base.emit(if detected { "motionstart" } else { "motionend" });
            self.base.emit("change");
        }
    }

    fn stop_polling(&mut self) {
        self.polling_active.store(false, Ordering::Relaxed);
        if let Some(handle) = self.poll_handle.take() { handle.abort(); }
    }
}

impl Component for Motion {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Motion" }
    fn requires_hardware(&self) -> bool { true }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String> {
        board.with_board(|conn| {
            conn.set_pin_mode(self.config.pin, pin_mode::INPUT)?;
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
