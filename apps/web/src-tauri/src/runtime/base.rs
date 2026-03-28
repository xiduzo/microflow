//! Base component trait and common functionality
//!
//! Defines the interface that all hardware components must implement.

use firmata_rs::Firmata;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::Debug;
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Value that a component can hold
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
        ComponentValue::Number(f64::from(v))
    }
}

impl From<u8> for ComponentValue {
    fn from(v: u8) -> Self {
        ComponentValue::Number(f64::from(v))
    }
}

impl ComponentValue {
    /// Convert any `ComponentValue` to a boolean (truthy/falsy check)
    /// - Bool: direct value
    /// - Number: true if non-zero
    /// - String: true if non-empty
    /// - Rgba: always true (color exists)
    /// - Array: true if non-empty
    #[must_use] 
    pub fn as_bool(&self) -> Option<bool> {
        Some(match self {
            ComponentValue::Bool(v) => *v,
            ComponentValue::Number(v) => *v != 0.0,
            ComponentValue::String(v) => !v.is_empty(),
            ComponentValue::Rgba { .. } => true,
            ComponentValue::Array(v) => !v.is_empty(),
        })
    }

    /// Check if the value is truthy (convenience method that never returns None)
    #[must_use] 
    pub fn is_truthy(&self) -> bool {
        self.as_bool().unwrap_or(false)
    }

    #[must_use] 
    pub fn as_number(&self) -> Option<f64> {
        match self {
            ComponentValue::Number(v) => Some(*v),
            ComponentValue::Bool(v) => Some(if *v { 1.0 } else { 0.0 }),
            _ => None,
        }
    }

    #[must_use] 
    pub fn as_u8(&self) -> Option<u8> {
        self.as_number().map(|v| v.clamp(0.0, 255.0) as u8)
    }
}

/// Event emitted by a component
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentEvent {
    #[serde(deserialize_with = "deserialize_arc_str")]
    pub source: Arc<str>,
    #[serde(deserialize_with = "deserialize_arc_str")]
    pub source_handle: Arc<str>,
    pub value: ComponentValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<String>,
    #[serde(default)]
    pub sequence: u64,  // Flow version when event was created
}

/// Custom deserializer to convert String -> Arc<str>
fn deserialize_arc_str<'de, D>(deserializer: D) -> Result<Arc<str>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    Ok(Arc::from(s))
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
    #[must_use] 
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
    
    /// Whether this component aggregates multiple inputs on a handle
    /// When true, the executor will collect all input values and pass as array
    fn aggregates_inputs(&self) -> bool { false }

    /// Called when a raw MQTT message arrives for this component (topic-aware).
    /// Default no-op; override in components that need topic context (e.g. Figma).
    fn receive_raw_message(&mut self, _topic: &str, _payload: &[u8]) {}

    /// Whether this component requires hardware (board connection)
    fn requires_hardware(&self) -> bool { false }
}

/// Handle to the Firmata board for components to use.
///
/// The reader thread owns `BoardConnection` exclusively — no shared mutex on the hot path.
/// All write operations are sent via `send_command()` and processed between read cycles.
pub struct BoardHandle {
    /// Channel to send commands to the reader thread
    cmd_tx: std::sync::Mutex<Option<std::sync::mpsc::Sender<BoardCommand>>>,
    /// Whether the board is currently connected (cheap atomic check)
    connected: std::sync::atomic::AtomicBool,
    /// Flag to signal the reader thread to stop
    reader_running: std::sync::atomic::AtomicBool,
    /// Handle to the reader thread for joining on stop
    reader_handle: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl BoardHandle {
    #[must_use] 
    pub fn new() -> Self {
        Self {
            cmd_tx: std::sync::Mutex::new(None),
            connected: std::sync::atomic::AtomicBool::new(false),
            reader_running: std::sync::atomic::AtomicBool::new(false),
            reader_handle: std::sync::Mutex::new(None),
        }
    }

    /// Connect a board and immediately start the reader thread.
    /// The reader thread takes exclusive ownership of `connection`.
    pub fn connect(self: &Arc<Self>, connection: BoardConnection) {
        self.stop_reader();

        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<BoardCommand>();
        *self.cmd_tx.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(cmd_tx);
        self.connected.store(true, std::sync::atomic::Ordering::Release);
        self.reader_running.store(true, std::sync::atomic::Ordering::Release);

        let handle_clone = Arc::clone(self);
        let thread_handle = std::thread::spawn(move || {
            log::info!("Firmata reader thread started (exclusive ownership)");
            let mut conn = connection;

            loop {
                // 1. Drain all pending commands (non-blocking)
                loop {
                    match cmd_rx.try_recv() {
                        Ok(BoardCommand::Stop) => {
                            log::info!("Firmata reader thread: Stop received");
                            return;
                        }
                        Ok(BoardCommand::SetPinMode { pin, mode }) => {
                            let _ = conn.set_pin_mode(pin, mode);
                        }
                        Ok(BoardCommand::DigitalWrite { pin, value }) => {
                            let _ = conn.digital_write(pin, value);
                        }
                        Ok(BoardCommand::AnalogWrite { pin, value }) => {
                            let _ = conn.analog_write(pin, value);
                        }
                        Ok(BoardCommand::EnableAnalogReporting { pin }) => {
                            let _ = conn.enable_analog_reporting(pin);
                        }
                        Ok(BoardCommand::DisableAnalogReporting { pin }) => {
                            let _ = conn.disable_analog_reporting(pin);
                        }
                        Ok(BoardCommand::EnableDigitalReporting { pin }) => {
                            let _ = conn.set_reporting(pin, true);
                        }
                        Ok(BoardCommand::DisableDigitalReporting { pin }) => {
                            let _ = conn.set_reporting(pin, false);
                        }
                        Ok(BoardCommand::ResetAllReporting) => {
                            let _ = conn.reset_all_reporting();
                        }
                        Ok(BoardCommand::SetPinChangeCallback { callback }) => {
                            conn.set_pin_change_callback(callback);
                        }
                        Ok(BoardCommand::ClearPinCache) => {
                            conn.clear_pin_cache();
                        }
                        Ok(BoardCommand::RegisterActivePin { pin }) => {
                            conn.active_pins.insert(pin);
                        }
                        Err(std::sync::mpsc::TryRecvError::Empty) => break,
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                            log::info!("Firmata reader: command channel closed, stopping");
                            return;
                        }
                    }
                }

                // 2. Check stop flag
                if !handle_clone.reader_running.load(std::sync::atomic::Ordering::Acquire) {
                    break;
                }

                // 3. Read one Firmata message
                match conn.board.read_and_decode() {
                    Ok(_) => {
                        conn.detect_and_emit_changes();
                    }
                    Err(e) => {
                        let err_str = format!("{e}");
                        if err_str.contains("timed out") || err_str.contains("timeout") {
                            std::thread::sleep(std::time::Duration::from_millis(1));
                        } else {
                            log::warn!("Firmata reader: I/O error: {err_str}");
                            handle_clone.connected.store(false, std::sync::atomic::Ordering::Release);
                            break;
                        }
                    }
                }
            }

            log::info!("Firmata reader thread stopped");
        });

        *self.reader_handle.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(thread_handle);
    }

    pub fn disconnect(&self) {
        self.stop_reader();
        self.connected.store(false, std::sync::atomic::Ordering::Release);
        *self.cmd_tx.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(std::sync::atomic::Ordering::Acquire)
    }

    /// Send a command to the reader thread. Fire-and-forget, never blocks.
    pub fn send_command(&self, cmd: BoardCommand) -> Result<(), String> {
        match self.cmd_tx.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref() {
            Some(tx) => tx.send(cmd).map_err(|_| "Board command channel closed".to_string()),
            None => Err("Board not connected".to_string()),
        }
    }

    /// Stop the reader thread and wait for clean exit.
    pub fn stop_reader(&self) {
        self.reader_running.store(false, std::sync::atomic::Ordering::Release);
        if let Some(tx) = self.cmd_tx.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref() {
            let _ = tx.send(BoardCommand::Stop);
        }
        if let Some(handle) = self.reader_handle.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
            match handle.join() {
                Ok(()) => log::info!("Reader thread stopped cleanly"),
                Err(_) => log::warn!("Reader thread panicked during shutdown"),
            }
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
    #[must_use] 
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

/// Pin change event emitted when a pin value changes
#[derive(Debug, Clone)]
pub struct PinChangeEvent {
    pub pin: u8,
    pub value: u16,
    pub is_analog: bool,
}

/// Callback type for pin change events
pub type PinChangeCallback = Box<dyn Fn(PinChangeEvent) + Send + Sync>;

/// Commands sent to the reader thread for board operations.
/// The reader thread owns `BoardConnection` exclusively and processes
/// these between read cycles — no mutex contention on the hot path.
pub enum BoardCommand {
    SetPinMode { pin: u8, mode: u8 },
    DigitalWrite { pin: u8, value: bool },
    AnalogWrite { pin: u8, value: u16 },
    EnableAnalogReporting { pin: u8 },
    DisableAnalogReporting { pin: u8 },
    EnableDigitalReporting { pin: u8 },
    DisableDigitalReporting { pin: u8 },
    ResetAllReporting,
    SetPinChangeCallback { callback: Arc<PinChangeCallback> },
    ClearPinCache,
    /// Register a pin as active so `detect_and_emit_changes` checks it.
    RegisterActivePin { pin: u8 },
    Stop,
}

/// Wrapper around the firmata-rs Board
pub struct BoardConnection {
    pub board: firmata_rs::Board<SerialPortWrapper>,
    pub port_name: String,
    /// Track previous pin values for change detection
    pin_values: HashMap<u8, u16>,
    /// Callback for pin changes (set by runtime)
    pin_change_callback: Option<Arc<PinChangeCallback>>,
    /// Pins that have listeners registered. Only these are checked in `detect_and_emit_changes`.
    /// Empty means "check all pins" (safe fallback before listeners are registered).
    pub active_pins: std::collections::HashSet<u8>,
}

impl BoardConnection {
    /// Create a new `BoardConnection` with change tracking
    #[must_use] 
    pub fn new(board: firmata_rs::Board<SerialPortWrapper>, port_name: String) -> Self {
        Self {
            board,
            port_name,
            pin_values: HashMap::new(),
            pin_change_callback: None,
            active_pins: std::collections::HashSet::new(),
        }
    }

    /// Set the callback for pin change events
    pub fn set_pin_change_callback(&mut self, callback: Arc<PinChangeCallback>) {
        self.pin_change_callback = Some(callback);
        // Clear cached pin values so fresh comparisons happen
        self.pin_values.clear();
    }

    /// Clear cached pin values and active pin set (useful when flow changes)
    pub fn clear_pin_cache(&mut self) {
        self.pin_values.clear();
        self.active_pins.clear();
    }

    pub fn set_pin_mode(&mut self, pin: u8, mode: u8) -> Result<(), String> {
        self.board
            .set_pin_mode(i32::from(pin), mode)
            .map_err(|e| format!("Failed to set pin mode: {e}"))
    }

    pub fn digital_write(&mut self, pin: u8, value: bool) -> Result<(), String> {
        self.board
            .digital_write(i32::from(pin), i32::from(value))
            .map_err(|e| format!("Failed to digital write: {e}"))
    }

    pub fn analog_write(&mut self, pin: u8, value: u16) -> Result<(), String> {
        self.board
            .analog_write(i32::from(pin), i32::from(value))
            .map_err(|e| format!("Failed to analog write: {e}"))
    }

    pub fn digital_read(&mut self, pin: u8) -> Result<bool, String> {
        let port = pin / 8;
        self.board
            .report_digital(i32::from(port), 1)
            .map_err(|e| format!("Failed to enable digital reporting: {e}"))?;
        self.board
            .read_and_decode()
            .map_err(|e| format!("Failed to read: {e}"))?;
        let pins = self.board.pins();
        pins.get(pin as usize)
            .map(|p| p.value > 0)
            .ok_or_else(|| format!("Pin {pin} not found"))
    }

    /// Read analog value from a pin
    /// `pin` is the digital pin number (e.g., 14 for A0 on Arduino Uno)
    /// 
    /// Note: This assumes `report_analog` has already been enabled for this pin
    /// and `read_and_decode` has been called to update pin values.
    /// For best performance, call `read_and_decode()` once per poll cycle,
    /// then read pin values directly.
    pub fn analog_read(&mut self, pin: u8) -> Result<u16, String> {
        let pins = self.board.pins();
        
        pins.get(pin as usize)
            .map(|p| p.value as u16)
            .ok_or_else(|| format!("Analog pin {pin} not found"))
    }
    
    /// Enable analog reporting for a pin
    /// Call this once during initialization, not on every read
    pub fn enable_analog_reporting(&mut self, pin: u8) -> Result<(), String> {
        let pins = self.board.pins();
        
        // Verify this pin supports analog
        let pin_info = pins
            .get(pin as usize)
            .ok_or_else(|| format!("Pin {pin} not found"))?;
        
        if !pin_info.analog {
            return Err(format!("Pin {pin} is not an analog pin"));
        }
        
        // Find the analog channel index (0-based) by counting analog pins before this one
        let analog_channel = pins
            .iter()
            .take(pin as usize)
            .filter(|p| p.analog)
            .count() as i32;
        
        log::info!("Enabling analog reporting: pin={pin}, analog_channel={analog_channel}");
        
        self.board
            .report_analog(analog_channel, 1)
            .map_err(|e| format!("Failed to enable analog reporting: {e}"))
    }
    
    /// Process all pending messages from the board and emit change events
    /// Note: With the dedicated reader thread, this is mainly used as a fallback
    pub fn read_all(&mut self) -> Result<(), String> {
        // Just do a single read - the reader thread handles continuous reading
        match self.board.read_and_decode() {
            Ok(_) => {
                self.detect_and_emit_changes();
                Ok(())
            }
            Err(e) => {
                let err_str = format!("{e}");
                if err_str.contains("timed out") || err_str.contains("timeout") {
                    Ok(())
                } else {
                    Err(format!("Read error: {e}"))
                }
            }
        }
    }

    /// Detect pin value changes and emit events immediately.
    /// Only scans `active_pins` when registered; falls back to all pins if none registered yet.
    fn detect_and_emit_changes(&mut self) {
        if self.pin_change_callback.is_none() {
            return;
        }

        let pins = self.board.pins();
        let mut changes = Vec::new();

        // Fast path: only check pins with listeners.
        // Falls back to all pins only if no active pins registered yet.
        let indices: Box<dyn Iterator<Item = usize>> = if self.active_pins.is_empty() {
            Box::new(0..pins.len())
        } else {
            Box::new(self.active_pins.iter().map(|&p| p as usize))
        };

        for index in indices {
            let Some(pin) = pins.get(index) else { continue };
            let pin_num = index as u8;
            let current_value = pin.value as u16;
            let is_analog = pin.analog;

            let last_value = self.pin_values.get(&pin_num).copied();
            if last_value == Some(current_value) {
                continue;
            }

            let should_emit = if is_analog {
                match last_value {
                    Some(last) => (i32::from(current_value) - i32::from(last)).unsigned_abs() as u16 >= 1,
                    None => true,
                }
            } else {
                true
            };

            if should_emit {
                self.pin_values.insert(pin_num, current_value);
                changes.push(PinChangeEvent { pin: pin_num, value: current_value, is_analog });
            }
        }

        if let Some(callback) = &self.pin_change_callback {
            for change in changes {
                callback(change);
            }
        }
    }

    pub fn set_reporting(&mut self, pin: u8, enabled: bool) -> Result<(), String> {
        let port = pin / 8;
        self.board
            .report_digital(i32::from(port), i32::from(enabled))
            .map_err(|e| format!("Failed to set reporting: {e}"))
    }

    /// Disable analog reporting for a pin
    /// Call this during component cleanup to stop receiving updates
    pub fn disable_analog_reporting(&mut self, pin: u8) -> Result<(), String> {
        let pins = self.board.pins();
        
        // Verify this pin exists and is analog
        let pin_info = pins
            .get(pin as usize)
            .ok_or_else(|| format!("Pin {pin} not found"))?;
        
        if !pin_info.analog {
            // Not an analog pin, nothing to disable
            return Ok(());
        }
        
        // Find the analog channel index (0-based) by counting analog pins before this one
        let analog_channel = pins
            .iter()
            .take(pin as usize)
            .filter(|p| p.analog)
            .count() as i32;
        
        log::info!("Disabling analog reporting: pin={pin}, analog_channel={analog_channel}");
        
        // Remove from our cache
        self.pin_values.remove(&pin);
        
        self.board
            .report_analog(analog_channel, 0)
            .map_err(|e| format!("Failed to disable analog reporting: {e}"))
    }

    /// Disable digital reporting for a pin's port
    /// Note: This disables reporting for the entire port (8 pins)
    pub fn disable_digital_reporting(&mut self, pin: u8) -> Result<(), String> {
        let port = pin / 8;
        
        log::info!("Disabling digital reporting: pin={pin}, port={port}");
        
        // Remove from our cache
        self.pin_values.remove(&pin);
        
        self.board
            .report_digital(i32::from(port), 0)
            .map_err(|e| format!("Failed to disable digital reporting: {e}"))
    }

    /// Disable all reporting and clear state. Called inside the reader thread — no sleep needed.
    pub fn reset_all_reporting(&mut self) -> Result<(), String> {
        log::info!("Resetting all pin reporting");
        self.pin_values.clear();
        for channel in 0..16 {
            let _ = self.board.report_analog(channel, 0);
        }
        for port in 0..13 {
            let _ = self.board.report_digital(port, 0);
        }
        Ok(())
    }
}

/// Base implementation helper for components
pub struct ComponentBase {
    pub id: Arc<str>,
    pub value: ComponentValue,
    pub event_sender: Option<mpsc::UnboundedSender<ComponentEvent>>,
}

impl ComponentBase {
    #[must_use] 
    pub fn new(id: String, initial_value: ComponentValue) -> Self {
        Self {
            id: Arc::from(id),
            value: initial_value,
            event_sender: None,
        }
    }

    /// Set the value and automatically emit a "value" event if the value changed
    pub fn set_value(&mut self, value: ComponentValue) {
        if self.value != value {
            self.value = value;
            self.emit("value");
        }
    }

    /// Emit an event with the current value (borrows value)
    pub fn emit(&self, handle: &str) {
        self.emit_with_value(handle, Cow::Borrowed(&self.value));
    }

    /// Emit an event with a custom value using Cow semantics
    pub fn emit_with_value(&self, handle: &str, value: Cow<'_, ComponentValue>) {
        if let Some(sender) = &self.event_sender {
            let _ = sender.send(ComponentEvent {
                source: Arc::clone(&self.id),  // No allocation - just ref count increment
                source_handle: Arc::from(handle),  // Single allocation for handle
                value: value.into_owned(),
                edge_id: None,
                sequence: 0,  // Will be set by FlowRuntime when sequence tracking is enabled
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
        
        impl Visitor<'_> for StringOrNumberVisitor {
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
        
        impl Visitor<'_> for PinU8Visitor {
            type Value = u8;
            
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a string or number representing a pin (0-255)")
            }
            
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                v.parse().map_err(|_| de::Error::custom(format!("invalid pin: {v}")))
            }
            
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                v.parse().map_err(|_| de::Error::custom(format!("invalid pin: {v}")))
            }
            
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                u8::try_from(v).map_err(|_| de::Error::custom(format!("pin out of range: {v}")))
            }
            
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                u8::try_from(v).map_err(|_| de::Error::custom(format!("pin out of range: {v}")))
            }
            
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                let i = v as i64;
                u8::try_from(i).map_err(|_| de::Error::custom(format!("pin out of range: {v}")))
            }
        }
        
        deserializer.deserialize_any(PinU8Visitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_command_digital_write_round_trips() {
        let cmd = BoardCommand::DigitalWrite { pin: 13, value: true };
        match cmd {
            BoardCommand::DigitalWrite { pin, value } => {
                assert_eq!(pin, 13);
                assert!(value);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn board_command_reset_all_reporting_is_unit() {
        let cmd = BoardCommand::ResetAllReporting;
        assert!(matches!(cmd, BoardCommand::ResetAllReporting));
    }

    #[test]
    fn board_command_stop_is_unit() {
        let cmd = BoardCommand::Stop;
        assert!(matches!(cmd, BoardCommand::Stop));
    }

    #[test]
    fn new_board_handle_is_not_connected() {
        let handle = BoardHandle::new();
        assert!(!handle.is_connected());
    }

    #[test]
    fn send_command_returns_err_when_not_connected() {
        let handle = BoardHandle::new();
        let result = handle.send_command(BoardCommand::ResetAllReporting);
        assert!(result.is_err(), "send_command must fail when not connected");
        assert!(result.unwrap_err().contains("not connected"));
    }

    #[test]
    fn active_pins_tracking() {
        use std::collections::HashSet;
        let mut active: HashSet<u8> = HashSet::new();
        active.insert(2);
        active.insert(14);
        assert!(active.contains(&2));
        assert!(active.contains(&14));
        assert!(!active.contains(&13));
        active.clear();
        assert!(active.is_empty(), "clear_pin_cache should reset active pins");
    }
}
