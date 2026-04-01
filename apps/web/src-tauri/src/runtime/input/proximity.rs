//! Proximity Sensor Component - Input

use crate::runtime::base::{
    pin_mode, serde_utils, BoardCommand, BoardHandle, Component, ComponentBase, ComponentEvent,
    ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProximityConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_string_or_number")]
    pub pin: String,
    #[serde(default = "default_controller")]
    pub controller: String,
    #[serde(default = "default_freq")]
    pub freq: u32,
}

fn default_pin() -> String { "A0".to_string() }
fn default_controller() -> String { "GP2Y0A21YK".to_string() }
fn default_freq() -> u32 { 25 }

impl Default for ProximityConfig {
    fn default() -> Self { Self { pin: default_pin(), controller: default_controller(), freq: default_freq() } }
}

impl ProximityConfig {
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

pub struct Proximity {
    base: ComponentBase,
    config: ProximityConfig,
    board: Option<Arc<BoardHandle>>,
    last_cm: f64,
    polling_active: Arc<AtomicBool>,
    poll_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Proximity {
    #[must_use] 
    pub fn new(id: String, config: ProximityConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config, board: None, last_cm: 0.0,
            polling_active: Arc::new(AtomicBool::new(false)), poll_handle: None,
        }
    }

    fn raw_to_cm(&self, raw: u16) -> f64 {
        match self.config.controller.as_str() {
            "GP2Y0A21YK" => {
                let voltage = f64::from(raw) * 5.0 / 1024.0;
                if voltage > 0.42 { (27.86 / (voltage - 0.42)).clamp(10.0, 80.0) } else { 80.0 }
            }
            "GP2Y0A02YK0F" => {
                let voltage = f64::from(raw) * 5.0 / 1024.0;
                if voltage > 0.4 { (60.0 / (voltage - 0.4)).clamp(20.0, 150.0) } else { 150.0 }
            }
            "HCSR04" => (f64::from(raw) / 58.0).clamp(2.0, 400.0),
            _ => (f64::from(raw) * 200.0 / 1023.0).clamp(0.0, 200.0),
        }
    }

    fn process_reading(&mut self, raw: u16) {
        let cm = self.raw_to_cm(raw);
        if (cm - self.last_cm).abs() > 1.0 {
            self.last_cm = cm;
            self.base.set_value(ComponentValue::Number(cm));
        }
    }

    fn stop_polling(&mut self) {
        self.polling_active.store(false, Ordering::Relaxed);
        if let Some(handle) = self.poll_handle.take() { handle.abort(); }
    }
}

impl Component for Proximity {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Proximity" }
    fn requires_hardware(&self) -> bool { true }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        let pin = self.config.analog_pin();
        log::info!("Proximity initialize: pin={pin}");
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
                // Handle immediate pin change event from Firmata callback
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
        // Disable analog reporting for this pin before releasing board
        if let Some(board) = &self.board {
            let pin = self.config.analog_pin();
            log::info!("Proximity {} destroy: disabling analog reporting for pin {}", self.base.id, pin);
            let _ = board.send_command(BoardCommand::DisableAnalogReporting { pin });
        }
        self.board = None;
    }
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
