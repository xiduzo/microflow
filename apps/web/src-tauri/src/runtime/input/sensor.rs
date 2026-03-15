//! Sensor Component - Input

use crate::runtime::base::{
    pin_mode, serde_utils, BoardCommand, BoardHandle, Component, ComponentBase, ComponentEvent,
    ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SensorType {
    #[default]
    Analog,
    Digital,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SensorConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_string_or_number")]
    pub pin: String,
    #[serde(default)]
    pub r#type: SensorType,
    #[serde(default = "default_freq")]
    pub freq: u32,
    #[serde(default = "default_threshold")]
    pub threshold: u16,
}

fn default_pin() -> String { "A0".to_string() }
fn default_freq() -> u32 { 25 }
fn default_threshold() -> u16 { 1 }

impl Default for SensorConfig {
    fn default() -> Self { Self { pin: default_pin(), r#type: SensorType::default(), freq: default_freq(), threshold: default_threshold() } }
}

impl SensorConfig {
    /// Get the pin number for analog operations
    /// Handles both legacy "A0" format and new numeric format
    pub fn analog_pin(&self) -> u8 {
        // If it starts with 'A' or 'a', strip it and parse (legacy format)
        if self.pin.starts_with('A') || self.pin.starts_with('a') {
            // Legacy format like "A0" - but this shouldn't happen anymore
            // since UI now sends actual pin numbers
            self.pin[1..].parse().unwrap_or(0)
        } else {
            // New format: actual pin number (e.g., "14" for A0 on Arduino Uno)
            self.pin.parse().unwrap_or(0)
        }
    }
}

pub struct Sensor {
    base: ComponentBase,
    config: SensorConfig,
    board: Option<Arc<BoardHandle>>,
    last_value: u16,
    polling_active: Arc<AtomicBool>,
    poll_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Sensor {
    pub fn new(id: String, config: SensorConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config, board: None, last_value: 0,
            polling_active: Arc::new(AtomicBool::new(false)), poll_handle: None,
        }
    }

    fn process_reading(&mut self, value: u16) {
        let diff = (value as i32 - self.last_value as i32).unsigned_abs() as u16;
        log::debug!("Sensor {} process_reading: value={}, last={}, diff={}, threshold={}", 
            self.base.id, value, self.last_value, diff, self.config.threshold);
        if diff >= self.config.threshold {
            self.last_value = value;
            self.base.set_value(ComponentValue::Number(value as f64));
        }
    }

    fn stop_polling(&mut self) {
        self.polling_active.store(false, Ordering::Relaxed);
        if let Some(handle) = self.poll_handle.take() { handle.abort(); }
    }
}

impl Component for Sensor {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Sensor" }
    fn requires_hardware(&self) -> bool { true }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String> {
        let pin = self.config.analog_pin();
        log::info!("Sensor initialize: pin={}", pin);
        board.send_command(BoardCommand::SetPinMode { pin, mode: pin_mode::ANALOG })?;
        board.send_command(BoardCommand::EnableAnalogReporting { pin })?;
        self.board = Some(board);
        self.polling_active.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "read" => Ok(()),
            "pin_change" => {
                // Handle immediate pin change event from Firmata callback
                if let Some(value) = args.as_number() {
                    self.process_reading(value as u16);
                }
                Ok(())
            }
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) {
        self.stop_polling();
        // Disable analog reporting for this pin before releasing board
        if let Some(board) = &self.board {
            let pin = self.config.analog_pin();
            log::info!("Sensor {} destroy: disabling analog reporting for pin {}", self.base.id, pin);
            let _ = board.send_command(BoardCommand::DisableAnalogReporting { pin });
        }
        self.board = None;
    }
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
