//! Sensor Component - Input

use crate::runtime::base::{
    pin_mode, serde_utils, BoardCommand, BoardHandle, Component, ComponentBase, ComponentValue,
};
use crate::runtime::wiring::ListenerWiring;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
    #[must_use] 
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
    #[must_use] 
    pub fn new(id: String, config: SensorConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config, board: None, last_value: 0,
            polling_active: Arc::new(AtomicBool::new(false)), poll_handle: None,
        }
    }

    fn process_reading(&mut self, value: u16) {
        let diff = (i32::from(value) - i32::from(self.last_value)).unsigned_abs() as u16;
        log::debug!("Sensor {} process_reading: value={}, last={}, diff={}, threshold={}", 
            self.base.id, value, self.last_value, diff, self.config.threshold);
        if diff >= self.config.threshold {
            self.last_value = value;
            self.base.set_value(ComponentValue::Number(f64::from(value)));
        }
    }

    fn stop_polling(&mut self) {
        self.polling_active.store(false, Ordering::Relaxed);
        if let Some(handle) = self.poll_handle.take() { handle.abort(); }
    }
}

impl Component for Sensor {
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Sensor" }

    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        vec![ListenerWiring::AnalogPin {
            pin: self.config.analog_pin(),
            threshold: self.config.threshold,
        }]
    }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        let pin = self.config.analog_pin();
        log::info!("Sensor initialize: pin={pin}");
        board.send_command(BoardCommand::SetPinMode { pin, mode: pin_mode::ANALOG })?;
        board.send_command(BoardCommand::EnableAnalogReporting { pin })?;
        self.board = Some(board);
        self.polling_active.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "read" => Ok(()),
            "pin_change" => {
                if let Some(value) = args.as_number() {
                    self.process_reading(value as u16);
                }
                Ok(())
            }
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) {
        self.stop_polling();
        if let Some(board) = &self.board {
            let pin = self.config.analog_pin();
            log::info!("Sensor {} destroy: disabling analog reporting for pin {}", self.base.id, pin);
            let _ = board.send_command(BoardCommand::DisableAnalogReporting { pin });
        }
        self.board = None;
    }
}
