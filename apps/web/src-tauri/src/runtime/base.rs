//! Base component trait and common functionality
//!
//! Defines the interface that all hardware components must implement.

use firmata_rs::Firmata;
use serde::{Deserialize, Serialize};
use std::fmt::Debug;
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Value that a component can hold
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ComponentValue {
    Bool(bool),
    Number(f64),
    String(String),
    Rgba { r: u8, g: u8, b: u8, a: f64 },
    Array(Vec<ComponentValue>),
}

impl Default for ComponentValue {
    fn default() -> Self {
        ComponentValue::Number(0.0)
    }
}

impl From<bool> for ComponentValue {
    fn from(v: bool) -> Self {
        ComponentValue::Bool(v)
    }
}

impl From<f64> for ComponentValue {
    fn from(v: f64) -> Self {
        ComponentValue::Number(v)
    }
}

impl From<i32> for ComponentValue {
    fn from(v: i32) -> Self {
        ComponentValue::Number(v as f64)
    }
}

impl From<u8> for ComponentValue {
    fn from(v: u8) -> Self {
        ComponentValue::Number(v as f64)
    }
}

impl ComponentValue {
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            ComponentValue::Bool(v) => Some(*v),
            ComponentValue::Number(v) => Some(*v != 0.0),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            ComponentValue::Number(v) => Some(*v),
            ComponentValue::Bool(v) => Some(if *v { 1.0 } else { 0.0 }),
            _ => None,
        }
    }

    pub fn as_u8(&self) -> Option<u8> {
        self.as_number().map(|v| v.clamp(0.0, 255.0) as u8)
    }
}

/// Event emitted by a component
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentEvent {
    pub source: String,
    pub source_handle: String,
    pub value: ComponentValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<String>,
}

/// Pin configuration for components
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
#[allow(dead_code)]
pub enum PinConfig {
    Single(u8),
    Named(String),
    Multiple(Vec<u8>),
    Rgb { red: u8, green: u8, blue: u8 },
    Matrix { data: u8, clock: u8, cs: u8 },
}

impl PinConfig {
    #[allow(dead_code)]
    pub fn as_single(&self) -> Option<u8> {
        match self {
            PinConfig::Single(p) => Some(*p),
            _ => None,
        }
    }
}

impl Default for PinConfig {
    fn default() -> Self {
        PinConfig::Single(13)
    }
}

/// Trait that all hardware components must implement
/// 
/// # Lifecycle
/// 1. `new()` - Create component with config
/// 2. `set_event_sender()` - Wire up event channel
/// 3. `initialize()` - Called when board connects (may be called multiple times)
/// 4. `call_method()` - Handle incoming events from flow edges
/// 5. `destroy()` - Cleanup when component is removed
pub trait Component: Send + Sync {
    /// Unique identifier for this component instance
    #[allow(dead_code)]
    fn id(&self) -> &str;
    
    /// Current value of the component
    #[allow(dead_code)]
    fn value(&self) -> ComponentValue;
    
    /// Set the component's value directly
    #[allow(dead_code)]
    fn set_value(&mut self, value: ComponentValue);
    
    /// Type name for logging/debugging (e.g., "Led", "Button")
    fn component_type(&self) -> &'static str;
    
    /// Initialize hardware resources. Called when board connects.
    /// May be called multiple times if board reconnects.
    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String>;
    
    /// Handle a method call from a flow edge or external command
    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String>;
    
    /// Cleanup resources when component is removed
    fn destroy(&mut self);
    
    /// Get the event sender for emitting events
    #[allow(dead_code)]
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>>;
    
    /// Set the event sender for emitting events
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>);
    
    /// Whether this component requires hardware (board connection)
    fn requires_hardware(&self) -> bool { false }
}

/// Handle to the Firmata board for components to use
pub struct BoardHandle {
    inner: std::sync::Mutex<Option<BoardConnection>>,
}

impl BoardHandle {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(None),
        }
    }

    pub fn connect(&self, connection: BoardConnection) {
        *self.inner.lock().unwrap() = Some(connection);
    }

    pub fn disconnect(&self) {
        *self.inner.lock().unwrap() = None;
    }

    pub fn is_connected(&self) -> bool {
        self.inner.lock().unwrap().is_some()
    }

    pub fn with_board<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut BoardConnection) -> Result<R, String>,
    {
        match self.inner.lock().unwrap().as_mut() {
            Some(conn) => f(conn),
            None => Err("Board not connected".to_string()),
        }
    }
}

impl Default for BoardHandle {
    fn default() -> Self {
        Self::new()
    }
}

/// Serial port wrapper for firmata-rs
pub struct SerialPortWrapper {
    port: Box<dyn serialport::SerialPort>,
}

impl SerialPortWrapper {
    pub fn new(port: Box<dyn serialport::SerialPort>) -> Self {
        Self { port }
    }
}

impl Read for SerialPortWrapper {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.port.read(buf)
    }
}

impl Write for SerialPortWrapper {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.port.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.port.flush()
    }
}

impl Debug for SerialPortWrapper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SerialPortWrapper")
            .field("port", &self.port.name())
            .finish()
    }
}

/// Wrapper around the firmata-rs Board
pub struct BoardConnection {
    pub board: firmata_rs::Board<SerialPortWrapper>,
    pub port_name: String,
}

impl BoardConnection {
    pub fn set_pin_mode(&mut self, pin: u8, mode: u8) -> Result<(), String> {
        self.board
            .set_pin_mode(pin as i32, mode)
            .map_err(|e| format!("Failed to set pin mode: {}", e))
    }

    pub fn digital_write(&mut self, pin: u8, value: bool) -> Result<(), String> {
        self.board
            .digital_write(pin as i32, if value { 1 } else { 0 })
            .map_err(|e| format!("Failed to digital write: {}", e))
    }

    pub fn analog_write(&mut self, pin: u8, value: u16) -> Result<(), String> {
        self.board
            .analog_write(pin as i32, value as i32)
            .map_err(|e| format!("Failed to analog write: {}", e))
    }

    pub fn digital_read(&mut self, pin: u8) -> Result<bool, String> {
        let port = pin / 8;
        self.board
            .report_digital(port as i32, 1)
            .map_err(|e| format!("Failed to enable digital reporting: {}", e))?;
        self.board
            .read_and_decode()
            .map_err(|e| format!("Failed to read: {}", e))?;
        let pins = self.board.pins();
        pins.get(pin as usize)
            .map(|p| p.value > 0)
            .ok_or_else(|| format!("Pin {} not found", pin))
    }

    /// Read analog value from a pin
    /// `pin` is the digital pin number (e.g., 14 for A0 on Arduino Uno)
    /// 
    /// Note: This assumes report_analog has already been enabled for this pin
    /// and read_and_decode has been called to update pin values.
    /// For best performance, call read_and_decode() once per poll cycle,
    /// then read pin values directly.
    pub fn analog_read(&mut self, pin: u8) -> Result<u16, String> {
        let pins = self.board.pins();
        
        pins.get(pin as usize)
            .map(|p| p.value as u16)
            .ok_or_else(|| format!("Analog pin {} not found", pin))
    }
    
    /// Enable analog reporting for a pin
    /// Call this once during initialization, not on every read
    pub fn enable_analog_reporting(&mut self, pin: u8) -> Result<(), String> {
        let pins = self.board.pins();
        
        // Verify this pin supports analog
        let pin_info = pins
            .get(pin as usize)
            .ok_or_else(|| format!("Pin {} not found", pin))?;
        
        if !pin_info.analog {
            return Err(format!("Pin {} is not an analog pin", pin));
        }
        
        // Find the analog channel index (0-based) by counting analog pins before this one
        let analog_channel = pins
            .iter()
            .take(pin as usize)
            .filter(|p| p.analog)
            .count() as i32;
        
        log::info!("Enabling analog reporting: pin={}, analog_channel={}", pin, analog_channel);
        
        self.board
            .report_analog(analog_channel, 1)
            .map_err(|e| format!("Failed to enable analog reporting: {}", e))
    }
    
    /// Process all pending messages from the board
    /// Call this once per poll cycle to update all pin values
    pub fn read_all(&mut self) -> Result<(), String> {
        // Read and decode all available messages (non-blocking if no data)
        match self.board.read_and_decode() {
            Ok(_) => Ok(()),
            Err(e) => {
                // Timeout is expected when no data available
                let err_str = format!("{}", e);
                if err_str.contains("timed out") || err_str.contains("timeout") {
                    Ok(())
                } else {
                    Err(format!("Read error: {}", e))
                }
            }
        }
    }

    pub fn set_reporting(&mut self, pin: u8, enabled: bool) -> Result<(), String> {
        let port = pin / 8;
        self.board
            .report_digital(port as i32, if enabled { 1 } else { 0 })
            .map_err(|e| format!("Failed to set reporting: {}", e))
    }
}

/// Base implementation helper for components
pub struct ComponentBase {
    pub id: String,
    pub value: ComponentValue,
    pub event_sender: Option<mpsc::UnboundedSender<ComponentEvent>>,
}

impl ComponentBase {
    pub fn new(id: String, initial_value: ComponentValue) -> Self {
        Self { id, value: initial_value, event_sender: None }
    }

    pub fn emit(&self, handle: &str) {
        if let Some(sender) = &self.event_sender {
            let _ = sender.send(ComponentEvent {
                source: self.id.clone(),
                source_handle: handle.to_string(),
                value: self.value.clone(),
                edge_id: None,
            });
        }
    }

    pub fn emit_with_value(&self, handle: &str, value: ComponentValue) {
        if let Some(sender) = &self.event_sender {
            let _ = sender.send(ComponentEvent {
                source: self.id.clone(),
                source_handle: handle.to_string(),
                value,
                edge_id: None,
            });
        }
    }
}

pub mod pin_mode {
    pub const INPUT: u8 = 0;
    pub const OUTPUT: u8 = 1;
    pub const ANALOG: u8 = 2;
    pub const PWM: u8 = 3;
    pub const SERVO: u8 = 4;
    pub const PULLUP: u8 = 11;
}

/// Serde utilities for component configs
pub mod serde_utils {
    use serde::de::{self, Visitor};
    
    /// Deserialize a pin value from either a string or number to String
    /// Handles: "A0", "14", 14, 14.0 -> "A0", "14", "14", "14"
    pub fn deserialize_string_or_number<'de, D>(deserializer: D) -> Result<String, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct StringOrNumberVisitor;
        
        impl<'de> Visitor<'de> for StringOrNumberVisitor {
            type Value = String;
            
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a string or number")
            }
            
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(v.to_string())
            }
            
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(v)
            }
            
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(v.to_string())
            }
            
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(v.to_string())
            }
            
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok((v as i64).to_string())
            }
        }
        
        deserializer.deserialize_any(StringOrNumberVisitor)
    }
    
    /// Deserialize a pin value from string or number to u8
    /// Handles: "14", 14, 14.0 -> 14u8
    pub fn deserialize_pin_u8<'de, D>(deserializer: D) -> Result<u8, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct PinU8Visitor;
        
        impl<'de> Visitor<'de> for PinU8Visitor {
            type Value = u8;
            
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a string or number representing a pin (0-255)")
            }
            
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                v.parse().map_err(|_| de::Error::custom(format!("invalid pin: {}", v)))
            }
            
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                v.parse().map_err(|_| de::Error::custom(format!("invalid pin: {}", v)))
            }
            
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                u8::try_from(v).map_err(|_| de::Error::custom(format!("pin out of range: {}", v)))
            }
            
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                u8::try_from(v).map_err(|_| de::Error::custom(format!("pin out of range: {}", v)))
            }
            
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                let i = v as i64;
                u8::try_from(i).map_err(|_| de::Error::custom(format!("pin out of range: {}", v)))
            }
        }
        
        deserializer.deserialize_any(PinU8Visitor)
    }
}
