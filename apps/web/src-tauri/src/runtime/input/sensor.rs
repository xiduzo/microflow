//! Sensor Component - Input

use crate::runtime::base::{
    pin_mode, BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use firmata_rs::Firmata;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SensorType { Analog, Digital }

impl Default for SensorType { fn default() -> Self { SensorType::Analog } }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SensorConfig {
    #[serde(default = "default_pin")]
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
    pub fn analog_pin(&self) -> u8 {
        if self.pin.starts_with('A') || self.pin.starts_with('a') {
            self.pin[1..].parse().unwrap_or(0)
        } else { self.pin.parse().unwrap_or(0) }
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

    fn read_value(&self) -> Result<u16, String> {
        if let Some(board) = &self.board {
            board.with_board(|conn| conn.analog_read(self.config.analog_pin()))
        } else { Err("Board not connected".to_string()) }
    }

    fn process_reading(&mut self, value: u16) {
        let diff = (value as i32 - self.last_value as i32).unsigned_abs() as u16;
        if diff >= self.config.threshold {
            self.last_value = value;
            self.base.value = ComponentValue::Number(value as f64);
            self.base.emit("change");
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
        board.with_board(|conn| {
            conn.set_pin_mode(pin, pin_mode::ANALOG)?;
            conn.board.report_analog(pin as i32, 1).map_err(|e| format!("Failed to enable analog reporting: {}", e))
        })?;
        self.board = Some(board);
        self.polling_active.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn call_method(&mut self, method: &str, _args: ComponentValue) -> Result<(), String> {
        match method {
            "read" => { let v = self.read_value()?; self.process_reading(v); Ok(()) }
            _ => Err(format!("Unknown method: {}", method)),
        }
    }

    fn destroy(&mut self) { self.stop_polling(); self.board = None; }
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> { self.base.event_sender.clone() }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) { self.base.event_sender = Some(sender); }
}
