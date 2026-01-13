use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt::Debug;
use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::Emitter;
use serialport::SerialPortType;
use firmata_rs::{Board, Firmata};

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

/// Information about a serial port
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct SerialPortInfo {
    pub port_name: String,
    pub port_type: String,
    pub description: Option<String>,
    pub has_firmata: Option<bool>, // None = not tested, Some(true) = has Firmata, Some(false) = no Firmata
}

/// Event payload for serial port connection/disconnection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialPortEvent {
    pub port: SerialPortInfo,
    pub event_type: String, // "connected" or "disconnected"
}

/// Manages serial port monitoring and notifications
pub struct SerialPortManager {
    app_handle: Option<tauri::AppHandle>,
    monitoring: Arc<std::sync::atomic::AtomicBool>,
    monitor_handle: Option<thread::JoinHandle<()>>,
}

impl SerialPortManager {
    pub fn new() -> Self {
        Self {
            app_handle: None,
            monitoring: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            monitor_handle: None,
        }
    }

    /// Start monitoring serial ports
    pub fn start_monitoring(&mut self, app_handle: tauri::AppHandle) {
        if self.monitoring.load(std::sync::atomic::Ordering::Relaxed) {
            log::warn!("Serial port monitoring is already running");
            return;
        }

        self.app_handle = Some(app_handle.clone());
        self.monitoring.store(true, std::sync::atomic::Ordering::Relaxed);

        let monitoring = Arc::clone(&self.monitoring);
        let handle = thread::spawn(move || {
            Self::monitor_loop(app_handle, monitoring);
        });

        self.monitor_handle = Some(handle);
        log::info!("Serial port monitoring started");
    }

    /// Stop monitoring serial ports
    pub fn stop_monitoring(&mut self) {
        if !self.monitoring.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }

        self.monitoring.store(false, std::sync::atomic::Ordering::Relaxed);

        if let Some(handle) = self.monitor_handle.take() {
            handle.join().ok();
        }

        log::info!("Serial port monitoring stopped");
    }

    /// Extract canonical device identifier from port name
    /// On macOS, removes /dev/cu. or /dev/tty. prefix to get the base device name
    /// On other platforms, returns the port name as-is
    fn get_canonical_device_id(port_name: &str) -> String {
        // On macOS, /dev/cu.* and /dev/tty.* are pairs representing the same device
        // We use the base name (without prefix) as the canonical identifier
        if port_name.starts_with("/dev/cu.") {
            port_name.strip_prefix("/dev/cu.").unwrap_or(port_name).to_string()
        } else if port_name.starts_with("/dev/tty.") {
            port_name.strip_prefix("/dev/tty.").unwrap_or(port_name).to_string()
        } else {
            port_name.to_string()
        }
    }

    /// Check if a port should be skipped for Firmata testing
    /// Some system ports (like debug consoles) can hang when opened
    fn should_skip_firmata_test(port_name: &str) -> bool {
        let port_lower = port_name.to_lowercase();
        
        // Common patterns across all platforms
        let skip_patterns = [
            // macOS system ports
            "debug-console",
            "bluetooth",
            "wlan",
            "blth",
            // Linux system ports
            "ttys",      // Virtual console ports
            "ttysac",    // Samsung serial ports
            "ttyama",    // Raspberry Pi serial
            "ttygs",     // USB gadget serial
            // Windows system ports (usually COM1-COM4 are legacy/system)
            // We don't skip COM ports by number since USB devices can be any COM port
        ];
        
        for pattern in &skip_patterns {
            if port_lower.contains(pattern) {
                log::debug!("Skipping Firmata test for system port: {}", port_name);
                return true;
            }
        }
        false
    }

    /// Test if a serial port has Firmata running using the firmata-rs Board API
    /// Returns true if Firmata is detected, false otherwise
    fn test_firmata(port_name: &str) -> bool {
        // Skip system ports that can hang
        if Self::should_skip_firmata_test(port_name) {
            return false;
        }
        
        log::debug!("Testing Firmata on port: {}", port_name);
        
        // Try multiple baud rates (Firmata typically uses 57600, but can be 115200 or others)
        let baud_rates = [57600, 115200, 9600];
        
        for &baud_rate in &baud_rates {
            log::debug!("Testing Firmata on {} at {} baud using Board API", port_name, baud_rate);
            if Self::test_firmata_with_board(port_name, baud_rate) {
                return true;
            }
        }
        
        log::debug!("Firmata not detected on port: {}", port_name);
        false
    }
    
    /// Test Firmata using the firmata-rs Board API
    fn test_firmata_with_board(port_name: &str, baud_rate: u32) -> bool {
        log::debug!("Testing Firmata on {} at {} baud using Board API", port_name, baud_rate);
        
        let port = match serialport::new(port_name, baud_rate)
            .timeout(Duration::from_millis(1500))
            .open()
        {
            Ok(p) => p,
            Err(e) => {
                log::debug!("Failed to open port {} at {} baud: {}", port_name, baud_rate, e);
                return false;
            }
        };
        
        log::debug!("Port opened, creating Board wrapper for {}", port_name);
        
        // Wrap the serial port to satisfy Board's Sized requirement
        let wrapper = SerialPortWrapper::new(port);
        
        // Create a Board instance - this handles the Firmata protocol
        // Note: Board::new may block while it tries to communicate with the device
        log::debug!("Creating Board instance for {}", port_name);
        let mut board = match Board::new(Box::new(wrapper)) {
            Ok(b) => {
                log::debug!("Board created successfully for {}", port_name);
                b
            }
            Err(e) => {
                log::debug!("Failed to create Board for {} at {} baud: {}", port_name, baud_rate, e);
                return false;
            }
        };
        
        // Query firmware - this will populate firmware_name and firmware_version if Firmata responds
        log::debug!("Querying firmware on {}", port_name);
        match board.query_firmware() {
            Ok(()) => {
                log::debug!("Firmware query sent, reading response from {}", port_name);
                // Read and decode the response
                // We need to call read_and_decode to process the firmware response
                for i in 0..10 {
                    match board.read_and_decode() {
                        Ok(_) => {
                            // Check if firmware_name was populated
                            if !board.firmware_name.is_empty() {
                                log::info!(
                                    "✓ Firmata detected on port: {} at {} baud (firmware: {} v{})",
                                    port_name,
                                    baud_rate,
                                    board.firmware_name,
                                    board.firmware_version
                                );
                                return true;
                            }
                        }
                        Err(e) => {
                            log::debug!("read_and_decode attempt {} failed for {}: {}", i, port_name, e);
                            break;
                        }
                    }
                }
                log::debug!("No firmware response from {} at {} baud", port_name, baud_rate);
                false
            }
            Err(e) => {
                log::debug!("Failed to query firmware on {} at {} baud: {}", port_name, baud_rate, e);
                false
            }
        }
    }

    /// Main monitoring loop that runs in a background thread
    fn monitor_loop(app_handle: tauri::AppHandle, monitoring: Arc<std::sync::atomic::AtomicBool>) {
        log::info!("Monitor loop started");
        
        // Track ports by canonical device ID (to deduplicate cu.*/tty.* pairs on macOS)
        let mut previous_devices: HashMap<String, SerialPortInfo> = HashMap::new();
        let check_interval = Duration::from_millis(1000); // Check every second

        // Get initial port list and emit events for ports already connected
        log::info!("Getting initial port list...");
        match Self::get_available_ports_deduplicated() {
            Ok(ports) => {
                log::info!("Found {} initial ports", ports.len());
                for mut port in ports {
                    let device_id = Self::get_canonical_device_id(&port.port_name);
                    
                    // Only test Firmata on USB ports (Arduinos are USB devices)
                    let has_firmata = if port.port_type == "USB" {
                        log::info!("Testing Firmata on USB port: {}", port.port_name);
                        Self::test_firmata(&port.port_name)
                    } else {
                        log::debug!("Skipping Firmata test for non-USB port: {} (type: {})", port.port_name, port.port_type);
                        false
                    };
                    port.has_firmata = Some(has_firmata);
                    
                    previous_devices.insert(device_id.clone(), port.clone());
                    
                    // Emit event for ports that are already connected at startup
                    log::info!("Serial port already connected: {} (device: {}, Firmata: {})", 
                        port.port_name, device_id, has_firmata);
                    let event = SerialPortEvent {
                        port: port.clone(),
                        event_type: "connected".to_string(),
                    };
                    if let Err(e) = app_handle.emit("serial-port-connected", &event) {
                        log::error!("Failed to emit serial-port-connected event: {}", e);
                    }
                }
            }
            Err(e) => {
                log::error!("Failed to get initial port list: {}", e);
            }
        }
        
        log::info!("Starting monitoring loop with {} known devices", previous_devices.len());

        while monitoring.load(std::sync::atomic::Ordering::Relaxed) {
            match Self::get_available_ports_deduplicated() {
                Ok(current_ports) => {
                    // Build current devices map
                    let mut current_devices: HashMap<String, SerialPortInfo> = HashMap::new();
                    for port in current_ports {
                        let device_id = Self::get_canonical_device_id(&port.port_name);
                        current_devices.insert(device_id, port);
                    }

                    // Find newly connected devices
                    for (device_id, port) in &mut current_devices {
                        if !previous_devices.contains_key(device_id) {
                            // Only test Firmata on USB ports
                            let has_firmata = if port.port_type == "USB" {
                                log::info!("New USB port detected, testing Firmata: {}", port.port_name);
                                Self::test_firmata(&port.port_name)
                            } else {
                                log::debug!("Skipping Firmata test for non-USB port: {}", port.port_name);
                                false
                            };
                            port.has_firmata = Some(has_firmata);
                            
                            log::info!("Serial port connected: {} (device: {}, Firmata: {})", 
                                port.port_name, device_id, has_firmata);
                            let event = SerialPortEvent {
                                port: port.clone(),
                                event_type: "connected".to_string(),
                            };
                            if let Err(e) = app_handle.emit("serial-port-connected", &event) {
                                log::error!("Failed to emit serial-port-connected event: {}", e);
                            }
                        }
                    }

                    // Find disconnected devices
                    for (device_id, port) in &previous_devices {
                        if !current_devices.contains_key(device_id) {
                            log::info!("Serial port disconnected: {} (device: {})", port.port_name, device_id);
                            let event = SerialPortEvent {
                                port: port.clone(),
                                event_type: "disconnected".to_string(),
                            };
                            if let Err(e) = app_handle.emit("serial-port-disconnected", &event) {
                                log::error!("Failed to emit serial-port-disconnected event: {}", e);
                            }
                        }
                    }

                    previous_devices = current_devices;
                }
                Err(e) => {
                    log::error!("Error getting serial ports: {}", e);
                }
            }

            // Sleep for the check interval
            thread::sleep(check_interval);
        }
        
        log::info!("Monitor loop ended");
    }

    /// Get list of available serial ports (with deduplication of cu.*/tty.* pairs on macOS)
    fn get_available_ports_deduplicated() -> Result<Vec<SerialPortInfo>, Box<dyn std::error::Error>> {
        let ports = serialport::available_ports()?;
        let mut port_map: HashMap<String, SerialPortInfo> = HashMap::new();

        for port in ports {
            let (port_type, description) = match &port.port_type {
                    SerialPortType::UsbPort(info) => {
                        let mut desc = format!("USB Device (VID: {:04X}, PID: {:04X})", 
                            info.vid, info.pid);
                        if let Some(serial) = &info.serial_number {
                            desc.push_str(&format!(", Serial: {}", serial));
                        }
                        if let Some(product) = &info.product {
                            desc.push_str(&format!(", Product: {}", product));
                        }
                        ("USB".to_string(), Some(desc))
                    }
                    SerialPortType::PciPort => {
                        ("PCI".to_string(), Some("PCI Serial Port".to_string()))
                    }
                    SerialPortType::BluetoothPort => {
                        ("Bluetooth".to_string(), Some("Bluetooth Serial Port".to_string()))
                    }
                    SerialPortType::Unknown => {
                        ("Unknown".to_string(), None)
                    }
                };
            
            let port_info = SerialPortInfo {
                port_name: port.port_name.clone(),
                port_type,
                description,
                has_firmata: None, // Will be tested when port is detected
            };

            // On macOS, prefer cu.* over tty.* for the same device
            let device_id = Self::get_canonical_device_id(&port.port_name);
            let should_insert = if cfg!(target_os = "macos") {
                // If we already have a port for this device, prefer cu.* over tty.*
                if let Some(existing) = port_map.get(&device_id) {
                    // Keep existing if it's cu.*, otherwise replace with cu.*
                    if existing.port_name.starts_with("/dev/cu.") {
                        false // Keep existing cu.*
                    } else if port.port_name.starts_with("/dev/cu.") {
                        true // Replace tty.* with cu.*
                    } else {
                        false // Keep existing if neither is cu.*
                    }
                } else {
                    true // New device, always insert
                }
            } else {
                true // On other platforms, always insert
            };

            if should_insert {
                port_map.insert(device_id, port_info);
            }
        }

        Ok(port_map.into_values().collect())
    }

    /// Get list of available serial ports (for public API, returns deduplicated list)
    fn get_available_ports() -> Result<HashSet<SerialPortInfo>, Box<dyn std::error::Error>> {
        let ports = Self::get_available_ports_deduplicated()?;
        Ok(ports.into_iter().collect())
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

/// Tauri command to get the current list of available serial ports
#[tauri::command]
pub fn get_available_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    match SerialPortManager::get_available_ports() {
        Ok(ports) => Ok(ports.into_iter().collect()),
        Err(e) => Err(format!("Failed to get serial ports: {}", e)),
    }
}
