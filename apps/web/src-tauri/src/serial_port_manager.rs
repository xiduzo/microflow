//! Serial Port Manager
//!
//! This module handles serial port monitoring and Firmata board detection.
//! 
//! Architecture:
//! - `types`: Data structures for ports, pins, and events
//! - `port_utils`: Port name normalization and filtering logic
//! - `firmata_detector`: Firmata protocol detection on serial ports
//! - `event_emitter`: Tauri event emission abstraction
//! - `SerialPortManager`: Main orchestrator for monitoring

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

// ============================================================================
// Types Module - Data structures
// ============================================================================

mod types {
    use serde::{Deserialize, Serialize};

    /// Pin info matching frontend Pin type in board.ts
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PinInfo {
        pub pin: usize,
        pub supported_modes: Vec<u8>,
        pub analog_channel: i32, // -1 if not analog
    }

    /// Board state event matching frontend Board type in board.ts
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(tag = "state", rename_all = "camelCase")]
    pub enum BoardStateEvent {
        #[serde(rename = "connected")]
        Connected {
            port: String,
            firmware_name: String,
            firmware_version: String,
            pins: Vec<PinInfo>,
        },
        #[serde(rename = "connecting")]
        Connecting {},
        #[serde(rename = "disconnected")]
        Disconnected {},
        #[serde(rename = "error")]
        Error {
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<String>,
        },
    }

    /// Information about a serial port
    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
    pub struct SerialPortInfo {
        pub port_name: String,
        pub port_type: String,
        pub description: Option<String>,
        pub has_firmata: Option<bool>,
    }

    impl SerialPortInfo {
        pub fn is_usb(&self) -> bool {
            self.port_type == "USB"
        }
    }

    /// Event payload for serial port connection/disconnection
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct SerialPortEvent {
        pub port: SerialPortInfo,
        pub event_type: String,
    }

    impl SerialPortEvent {
        pub fn connected(port: SerialPortInfo) -> Self {
            Self { port, event_type: "connected".to_string() }
        }

        pub fn disconnected(port: SerialPortInfo) -> Self {
            Self { port, event_type: "disconnected".to_string() }
        }
    }
}

pub use types::{BoardStateEvent, SerialPortInfo};


// ============================================================================
// Port Utilities - Port name handling and filtering
// ============================================================================

mod port_utils {
    use super::types::SerialPortInfo;
    use serialport::SerialPortType;
    use std::collections::HashMap;

    /// Patterns that indicate system ports to skip during Firmata testing
    const SKIP_PATTERNS: &[&str] = &[
        // macOS system ports
        "debug-console", "bluetooth", "wlan", "blth",
        // Linux system ports
        "ttys", "ttysac", "ttyama", "ttygs",
    ];

    /// Extract canonical device identifier from port name.
    /// On macOS, removes /dev/cu. or /dev/tty. prefix to deduplicate device pairs.
    pub fn get_canonical_device_id(port_name: &str) -> String {
        port_name
            .strip_prefix("/dev/cu.")
            .or_else(|| port_name.strip_prefix("/dev/tty."))
            .unwrap_or(port_name)
            .to_string()
    }

    /// Check if a port should be skipped for Firmata testing.
    /// System ports (debug consoles, bluetooth) can hang when opened.
    pub fn should_skip_firmata_test(port_name: &str) -> bool {
        let port_lower = port_name.to_lowercase();
        
        let should_skip = SKIP_PATTERNS.iter().any(|pattern| port_lower.contains(pattern));
        
        if should_skip {
            log::debug!("Skipping Firmata test for system port: {}", port_name);
        }
        
        should_skip
    }

    /// Convert serialport type to our string representation
    fn port_type_to_string(port_type: &SerialPortType) -> (String, Option<String>) {
        match port_type {
            SerialPortType::UsbPort(info) => {
                let mut desc = format!("USB Device (VID: {:04X}, PID: {:04X})", info.vid, info.pid);
                if let Some(serial) = &info.serial_number {
                    desc.push_str(&format!(", Serial: {}", serial));
                }
                if let Some(product) = &info.product {
                    desc.push_str(&format!(", Product: {}", product));
                }
                ("USB".to_string(), Some(desc))
            }
            SerialPortType::PciPort => ("PCI".to_string(), Some("PCI Serial Port".to_string())),
            SerialPortType::BluetoothPort => ("Bluetooth".to_string(), Some("Bluetooth Serial Port".to_string())),
            SerialPortType::Unknown => ("Unknown".to_string(), None),
        }
    }

    /// On macOS, determine if we should prefer this port over an existing one.
    /// We prefer cu.* over tty.* for the same device.
    fn should_prefer_port(existing: &SerialPortInfo, new_port_name: &str) -> bool {
        if cfg!(target_os = "macos") {
            !existing.port_name.starts_with("/dev/cu.") && new_port_name.starts_with("/dev/cu.")
        } else {
            false
        }
    }

    /// Get deduplicated list of available serial ports.
    /// On macOS, deduplicates cu.*/tty.* pairs, preferring cu.* variants.
    pub fn get_available_ports() -> Result<Vec<SerialPortInfo>, Box<dyn std::error::Error>> {
        let ports = serialport::available_ports()?;
        let mut port_map: HashMap<String, SerialPortInfo> = HashMap::new();

        for port in ports {
            let (port_type, description) = port_type_to_string(&port.port_type);
            let port_info = SerialPortInfo {
                port_name: port.port_name.clone(),
                port_type,
                description,
                has_firmata: None,
            };

            let device_id = get_canonical_device_id(&port.port_name);
            
            let should_insert = match port_map.get(&device_id) {
                Some(existing) => should_prefer_port(existing, &port.port_name),
                None => true,
            };

            if should_insert {
                port_map.insert(device_id, port_info);
            }
        }

        Ok(port_map.into_values().collect())
    }
}


// ============================================================================
// Firmata Detector - Firmata protocol detection
// ============================================================================

mod firmata_detector {
    use super::types::{BoardStateEvent, PinInfo};
    use super::port_utils;
    use firmata_rs::{Board, Firmata};
    use std::fmt::Debug;
    use std::io::{Read, Write};
    use std::time::Duration;

    /// Baud rates to try when detecting Firmata (in order of preference)
    const BAUD_RATES: &[u32] = &[57600, 115200, 9600];
    
    /// Timeout for serial port operations
    const PORT_TIMEOUT_MS: u64 = 1500;
    
    /// Max iterations for reading firmware response
    const FIRMWARE_READ_ITERATIONS: usize = 10;
    
    /// Max iterations for reading capabilities/analog mapping
    const CAPABILITY_READ_ITERATIONS: usize = 20;

    /// Wrapper around Box<dyn SerialPort> to satisfy Board's Sized requirement
    struct SerialPortWrapper {
        port: Box<dyn serialport::SerialPort>,
    }

    impl SerialPortWrapper {
        fn new(port: Box<dyn serialport::SerialPort>) -> Self {
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

    /// Result of a successful Firmata detection
    struct FirmataInfo {
        firmware_name: String,
        firmware_version: String,
        pins: Vec<PinInfo>,
    }

    /// Open a serial port with the given baud rate
    fn open_port(port_name: &str, baud_rate: u32) -> Option<Box<dyn serialport::SerialPort>> {
        serialport::new(port_name, baud_rate)
            .timeout(Duration::from_millis(PORT_TIMEOUT_MS))
            .open()
            .map_err(|e| {
                log::debug!("Failed to open port {} at {} baud: {}", port_name, baud_rate, e);
                e
            })
            .ok()
    }

    /// Query and read firmware information from the board
    fn query_firmware(board: &mut Board<SerialPortWrapper>, port_name: &str, baud_rate: u32) -> bool {
        if let Err(e) = board.query_firmware() {
            log::debug!("Failed to query firmware on {} at {} baud: {}", port_name, baud_rate, e);
            return false;
        }

        for _ in 0..FIRMWARE_READ_ITERATIONS {
            match board.read_and_decode() {
                Ok(_) if !board.firmware_name.is_empty() => return true,
                Err(_) => break,
                _ => continue,
            }
        }

        log::debug!("No firmware response from {} at {} baud", port_name, baud_rate);
        false
    }

    /// Query capabilities and analog mapping from the board
    fn query_capabilities(board: &mut Board<SerialPortWrapper>) {
        if let Err(e) = board.query_capabilities() {
            log::warn!("Failed to query capabilities: {}", e);
        }

        if let Err(e) = board.query_analog_mapping() {
            log::warn!("Failed to query analog mapping: {}", e);
        }

        // Read responses
        for _ in 0..CAPABILITY_READ_ITERATIONS {
            if board.read_and_decode().is_err() {
                break;
            }
        }
    }

    /// Convert firmata-rs pins to our PinInfo structs
    fn extract_pins(board: &mut Board<SerialPortWrapper>) -> Vec<PinInfo> {
        board.pins()
            .iter()
            .enumerate()
            .map(|(index, pin)| PinInfo {
                pin: index,
                supported_modes: pin.modes.iter().map(|m| m.mode).collect(),
                analog_channel: if pin.analog { index as i32 } else { -1 },
            })
            .collect()
    }

    /// Test Firmata at a specific baud rate
    fn test_at_baud_rate(port_name: &str, baud_rate: u32) -> Option<FirmataInfo> {
        log::debug!("Testing Firmata on {} at {} baud", port_name, baud_rate);

        let port = open_port(port_name, baud_rate)?;
        let wrapper = SerialPortWrapper::new(port);

        let mut board = Board::new(Box::new(wrapper))
            .map_err(|e| {
                log::debug!("Failed to create Board for {} at {} baud: {}", port_name, baud_rate, e);
                e
            })
            .ok()?;

        if !query_firmware(&mut board, port_name, baud_rate) {
            return None;
        }

        log::info!(
            "✓ Firmata detected on port: {} at {} baud (firmware: {} v{})",
            port_name, baud_rate, board.firmware_name, board.firmware_version
        );

        query_capabilities(&mut board);
        let pins = extract_pins(&mut board);
        
        log::info!("Found {} pins on {}", pins.len(), port_name);

        Some(FirmataInfo {
            firmware_name: board.firmware_name.clone(),
            firmware_version: board.firmware_version.clone(),
            pins,
        })
    }

    /// Test if a serial port has Firmata running.
    /// Returns Some(BoardStateEvent::Connected) if Firmata is detected, None otherwise.
    pub fn detect(port_name: &str) -> Option<BoardStateEvent> {
        if port_utils::should_skip_firmata_test(port_name) {
            return None;
        }

        log::debug!("Testing Firmata on port: {}", port_name);

        for &baud_rate in BAUD_RATES {
            if let Some(info) = test_at_baud_rate(port_name, baud_rate) {
                return Some(BoardStateEvent::Connected {
                    port: port_name.to_string(),
                    firmware_name: info.firmware_name,
                    firmware_version: info.firmware_version,
                    pins: info.pins,
                });
            }
        }

        log::debug!("Firmata not detected on port: {}", port_name);
        None
    }
}


// ============================================================================
// Event Emitter - Tauri event emission abstraction
// ============================================================================

mod event_emitter {
    use super::types::{BoardStateEvent, SerialPortEvent, SerialPortInfo};
    use tauri::Emitter;

    /// Emit a board state event to the frontend
    pub fn emit_board_state(app_handle: &tauri::AppHandle, state: BoardStateEvent) {
        if let Err(e) = app_handle.emit("board-state", &state) {
            log::error!("Failed to emit board-state event: {}", e);
        }
    }

    /// Emit a serial port connected event
    pub fn emit_port_connected(app_handle: &tauri::AppHandle, port: &SerialPortInfo) {
        let event = SerialPortEvent::connected(port.clone());
        if let Err(e) = app_handle.emit("serial-port-connected", &event) {
            log::error!("Failed to emit serial-port-connected event: {}", e);
        }
    }

    /// Emit a serial port disconnected event
    pub fn emit_port_disconnected(app_handle: &tauri::AppHandle, port: &SerialPortInfo) {
        let event = SerialPortEvent::disconnected(port.clone());
        if let Err(e) = app_handle.emit("serial-port-disconnected", &event) {
            log::error!("Failed to emit serial-port-disconnected event: {}", e);
        }
    }

    /// Emit connecting state
    pub fn emit_connecting(app_handle: &tauri::AppHandle) {
        emit_board_state(app_handle, BoardStateEvent::Connecting {});
    }

    /// Emit disconnected state
    pub fn emit_disconnected(app_handle: &tauri::AppHandle) {
        emit_board_state(app_handle, BoardStateEvent::Disconnected {});
    }

    /// Emit error state for a port without Firmata
    pub fn emit_no_firmata_error(app_handle: &tauri::AppHandle, port_name: &str) {
        emit_board_state(
            app_handle,
            BoardStateEvent::Error {
                error: Some(format!("No Firmata detected on {}", port_name)),
            },
        );
    }
}


// ============================================================================
// Serial Port Manager - Main orchestrator
// ============================================================================

/// Manages serial port monitoring and Firmata detection
pub struct SerialPortManager {
    app_handle: Option<tauri::AppHandle>,
    monitoring: Arc<AtomicBool>,
    monitor_handle: Option<thread::JoinHandle<()>>,
}

impl SerialPortManager {
    const CHECK_INTERVAL_MS: u64 = 1000;

    pub fn new() -> Self {
        Self {
            app_handle: None,
            monitoring: Arc::new(AtomicBool::new(false)),
            monitor_handle: None,
        }
    }

    /// Start monitoring serial ports for connections/disconnections
    pub fn start_monitoring(&mut self, app_handle: tauri::AppHandle) {
        if self.monitoring.load(Ordering::Relaxed) {
            log::warn!("Serial port monitoring is already running");
            return;
        }

        self.app_handle = Some(app_handle.clone());
        self.monitoring.store(true, Ordering::Relaxed);

        let monitoring = Arc::clone(&self.monitoring);
        let handle = thread::spawn(move || {
            MonitorLoop::new(app_handle, monitoring).run();
        });

        self.monitor_handle = Some(handle);
        log::info!("Serial port monitoring started");
    }

    /// Stop monitoring serial ports
    pub fn stop_monitoring(&mut self) {
        if !self.monitoring.load(Ordering::Relaxed) {
            return;
        }

        self.monitoring.store(false, Ordering::Relaxed);

        if let Some(handle) = self.monitor_handle.take() {
            handle.join().ok();
        }

        log::info!("Serial port monitoring stopped");
    }

    /// Get list of available serial ports (public API)
    pub fn get_available_ports() -> Result<Vec<SerialPortInfo>, Box<dyn std::error::Error>> {
        port_utils::get_available_ports()
    }
}

impl Default for SerialPortManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SerialPortManager {
    fn drop(&mut self) {
        self.stop_monitoring();
    }
}


// ============================================================================
// Monitor Loop - Background monitoring logic
// ============================================================================

/// Encapsulates the monitoring loop logic
struct MonitorLoop {
    app_handle: tauri::AppHandle,
    monitoring: Arc<AtomicBool>,
    known_devices: HashMap<String, SerialPortInfo>,
}

impl MonitorLoop {
    fn new(app_handle: tauri::AppHandle, monitoring: Arc<AtomicBool>) -> Self {
        Self {
            app_handle,
            monitoring,
            known_devices: HashMap::new(),
        }
    }

    /// Main entry point - runs the monitoring loop
    fn run(&mut self) {
        log::info!("Monitor loop started");
        
        self.scan_initial_ports();
        self.poll_for_changes();
        
        log::info!("Monitor loop ended");
    }

    /// Scan and emit events for ports already connected at startup
    fn scan_initial_ports(&mut self) {
        log::info!("Getting initial port list...");
        
        match port_utils::get_available_ports() {
            Ok(ports) => {
                log::info!("Found {} initial ports", ports.len());
                for port in ports {
                    self.handle_new_port(port);
                }
            }
            Err(e) => {
                log::error!("Failed to get initial port list: {}", e);
            }
        }
        
        log::info!("Starting monitoring loop with {} known devices", self.known_devices.len());
    }

    /// Poll for port changes until monitoring is stopped
    fn poll_for_changes(&mut self) {
        let check_interval = Duration::from_millis(SerialPortManager::CHECK_INTERVAL_MS);

        while self.monitoring.load(Ordering::Relaxed) {
            if let Ok(current_ports) = port_utils::get_available_ports() {
                self.process_port_changes(current_ports);
            }
            thread::sleep(check_interval);
        }
    }

    /// Process changes between known and current ports
    fn process_port_changes(&mut self, current_ports: Vec<SerialPortInfo>) {
        let current_devices = self.build_device_map(current_ports);
        
        self.detect_new_ports(&current_devices);
        self.detect_disconnected_ports(&current_devices);
        
        // Update known_devices, preserving has_firmata from existing entries
        self.known_devices = current_devices
            .into_iter()
            .map(|(device_id, mut port)| {
                // Preserve has_firmata from previously known device
                if let Some(known) = self.known_devices.get(&device_id) {
                    port.has_firmata = known.has_firmata;
                }
                (device_id, port)
            })
            .collect();
    }

    /// Build a map of device_id -> port_info from a list of ports
    fn build_device_map(&self, ports: Vec<SerialPortInfo>) -> HashMap<String, SerialPortInfo> {
        ports
            .into_iter()
            .map(|port| {
                let device_id = port_utils::get_canonical_device_id(&port.port_name);
                (device_id, port)
            })
            .collect()
    }

    /// Detect and handle newly connected ports
    fn detect_new_ports(&mut self, current_devices: &HashMap<String, SerialPortInfo>) {
        for (device_id, port) in current_devices {
            if !self.known_devices.contains_key(device_id) {
                self.handle_new_port(port.clone());
            }
        }
    }

    /// Detect and handle disconnected ports
    fn detect_disconnected_ports(&self, current_devices: &HashMap<String, SerialPortInfo>) {
        for (device_id, port) in &self.known_devices {
            if !current_devices.contains_key(device_id) {
                self.handle_disconnected_port(port);
            }
        }
    }

    /// Handle a newly detected port
    fn handle_new_port(&mut self, mut port: SerialPortInfo) {
        let device_id = port_utils::get_canonical_device_id(&port.port_name);
        
        // Test Firmata only on USB ports (Arduinos are USB devices)
        let board_info = if port.is_usb() {
            log::info!("Testing Firmata on USB port: {}", port.port_name);
            event_emitter::emit_connecting(&self.app_handle);
            firmata_detector::detect(&port.port_name)
        } else {
            log::debug!("Skipping Firmata test for non-USB port: {} (type: {})", 
                port.port_name, port.port_type);
            None
        };
        
        port.has_firmata = Some(board_info.is_some());
        
        // Store in known devices
        self.known_devices.insert(device_id.clone(), port.clone());
        
        // Emit port connected event
        log::info!("Serial port connected: {} (device: {}, Firmata: {})", 
            port.port_name, device_id, board_info.is_some());
        event_emitter::emit_port_connected(&self.app_handle, &port);
        
        // Emit board state
        self.emit_board_state_for_port(&port, board_info);
    }

    /// Handle a disconnected port
    fn handle_disconnected_port(&self, port: &SerialPortInfo) {
        let device_id = port_utils::get_canonical_device_id(&port.port_name);
        
        log::info!("Serial port disconnected: {} (device: {}, has_firmata: {:?})", 
            port.port_name, device_id, port.has_firmata);
        event_emitter::emit_port_disconnected(&self.app_handle, port);
        
        // If this was a Firmata port, emit disconnected board state
        if port.has_firmata == Some(true) {
            log::info!("Emitting board-state (disconnected) event for {}", port.port_name);
            event_emitter::emit_disconnected(&self.app_handle);
        }
    }

    /// Emit appropriate board state based on Firmata detection result
    fn emit_board_state_for_port(&self, port: &SerialPortInfo, board_info: Option<BoardStateEvent>) {
        match board_info {
            Some(state) => {
                if let BoardStateEvent::Connected { ref pins, .. } = state {
                    log::info!("Emitting board-state (connected) event for {} with {} pins", 
                        port.port_name, pins.len());
                }
                event_emitter::emit_board_state(&self.app_handle, state);
            }
            None if port.is_usb() => {
                log::debug!("No Firmata detected on USB port: {}", port.port_name);
                event_emitter::emit_no_firmata_error(&self.app_handle, &port.port_name);
            }
            None => {}
        }
    }
}


// ============================================================================
// Tauri Commands
// ============================================================================

/// Tauri command to get the current list of available serial ports
#[tauri::command]
pub fn get_available_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    SerialPortManager::get_available_ports()
        .map(|ports| ports.into_iter().collect())
        .map_err(|e| format!("Failed to get serial ports: {}", e))
}
