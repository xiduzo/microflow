//! Button Component - Input

use crate::runtime::base::{
    pin_mode, serde_utils, BoardCommand, BoardHandle, Component, ComponentBase, ComponentValue,
};
use crate::runtime::wiring::ListenerWiring;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    /// Timestamp of the last state change, used for debouncing
    last_change: Option<Instant>,
}

impl Button {
    #[must_use] 
    pub fn new(id: String, config: ButtonConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config, board: None, is_pressed: false, press_start: None,
            hold_emitted: false, polling_active: Arc::new(AtomicBool::new(false)), poll_handle: None,
            last_change: None,
        }
    }

    fn process_state(&mut self, pressed: bool) {
        if pressed != self.is_pressed {
            // Debounce: ignore state changes that arrive within XXXms of the last one.
            // Most mechanical switches settle within 5ms;
            // keeping latency imperceptible for real-time flows.
            if let Some(last) = self.last_change {
                if last.elapsed() < Duration::from_millis(20) {
                    return;
                }
            }
            self.last_change = Some(Instant::now());
            self.is_pressed = pressed;
            self.base.set_value(ComponentValue::Bool(pressed));
            if pressed {
                self.press_start = Some(Instant::now());
                self.hold_emitted = false;
                self.base.emit("event");
                self.base.emit("true");
            } else {
                self.press_start = None;
                self.hold_emitted = false;
                self.base.emit("event");
                self.base.emit("false");
            }
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
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Button" }

    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        vec![ListenerWiring::DigitalPin { pin: self.config.pin }]
    }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        let mode = if self.config.is_pullup { pin_mode::PULLUP } else { pin_mode::INPUT };
        board.send_command(BoardCommand::SetPinMode { pin: self.config.pin, mode })?;
        board.send_command(BoardCommand::EnableDigitalReporting { pin: self.config.pin })?;
        self.board = Some(board);
        self.polling_active.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "read" => Ok(()),
            "pin_change" => {
                if let Some(pressed) = args.as_bool() {
                    self.process_state(pressed);
                }
                Ok(())
            }
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) {
        self.stop_polling();
        if let Some(board) = &self.board {
            log::info!("Button {} destroy: disabling digital reporting for pin {}", self.base.id, self.config.pin);
            let _ = board.send_command(BoardCommand::DisableDigitalReporting { pin: self.config.pin });
        }
        self.board = None;
    }
}
