//! Motion Sensor Component - Input

use crate::runtime::base::{
    pin_mode, serde_utils, BoardHandle, Component, ComponentBase, ComponentValue,
};
use crate::runtime::wiring::ListenerWiring;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
    #[must_use] 
    pub fn new(id: String, config: MotionConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config, board: None, motion_detected: false, is_calibrated: false,
            polling_active: Arc::new(AtomicBool::new(false)), poll_handle: None,
        }
    }

    fn process_state(&mut self, detected: bool) {
        if !self.is_calibrated { self.is_calibrated = true; }
        if detected != self.motion_detected {
            self.motion_detected = detected;
            self.base.set_value(ComponentValue::Bool(detected));
            self.base.emit("event");
            self.base.emit(if detected { "true" } else { "false" });
        }
    }

    fn stop_polling(&mut self) {
        self.polling_active.store(false, Ordering::Relaxed);
        if let Some(handle) = self.poll_handle.take() { handle.abort(); }
    }
}

impl Component for Motion {
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Motion" }

    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        vec![ListenerWiring::DigitalPin { pin: self.config.pin }]
    }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        board.set_pin_mode(self.config.pin, pin_mode::INPUT)?;
        board.enable_digital_reporting(self.config.pin)?;
        self.board = Some(board);
        self.polling_active.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "read" => Ok(()),
            "pin_change" => {
                if let Some(detected) = args.as_bool() {
                    self.process_state(detected);
                }
                Ok(())
            }
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) {
        self.stop_polling();
        if let Some(board) = &self.board {
            log::info!("Motion {} destroy: disabling digital reporting for pin {}", self.base.id, self.config.pin);
            let _ = board.disable_digital_reporting(self.config.pin);
        }
        self.board = None;
    }
}
