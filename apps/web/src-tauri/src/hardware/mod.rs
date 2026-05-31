//! Hardware Module
//!
//! Orchestrates all hardware-related operations: port monitoring, board detection,
//! firmware flashing, and Firmata communication.
//!
//! # Architecture
//!
//! ```text
//! hardware/
//! ├── mod.rs           - Module exports and HardwareService
//! ├── types.rs         - Shared types (BoardState, events, etc.)
//! ├── port_monitor.rs  - Serial port discovery and monitoring
//! ├── firmata.rs       - Firmata protocol detection
//! └── events.rs        - Event emission (single source of truth)
//! ```
//!
//! # Design Principles
//!
//! 1. **Single Responsibility**: Each submodule has one job
//! 2. **Dependency Inversion**: `HardwareService` orchestrates, submodules don't know each other
//! 3. **Event Centralization**: All Tauri events flow through `events.rs`
//! 4. **Clean Boundaries**: Flasher module is called, never calls back

mod events;
mod firmata;
mod port_monitor;
mod types;

pub use events::{BoardStateObserver, EventEmitter};
pub use port_monitor::{PortMonitor, SerialPortInfo};
pub use types::BoardState;

use crate::flasher::{BoardConfig, Flasher};
use crate::runtime::host::BoardLink;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Central orchestrator for all hardware operations.
///
/// Coordinates between port monitoring, Firmata detection, and flashing
/// while maintaining a clean separation of concerns.
pub struct HardwareService {
    app_handle: Option<tauri::AppHandle>,
    monitoring: Arc<AtomicBool>,
    monitor_handle: Option<thread::JoinHandle<()>>,
}

impl HardwareService {
    const POLL_INTERVAL_MS: u64 = 250;

    #[must_use] 
    pub fn new() -> Self {
        Self {
            app_handle: None,
            monitoring: Arc::new(AtomicBool::new(false)),
            monitor_handle: None,
        }
    }

    /// Start monitoring for hardware changes.
    /// The `board` is shared with the runtime - when Firmata is detected,
    /// the connection is stored directly in this handle. The `observer` runs
    /// in-process on every `board-state` transition (before the Tauri emit) so
    /// the host can mutate `AppState` without listening to its own event bus.
    pub fn start_monitoring(
        &mut self,
        app_handle: tauri::AppHandle,
        board: BoardLink,
        observer: BoardStateObserver,
    ) {
        if self.monitoring.load(Ordering::Relaxed) {
            log::warn!("Hardware monitoring already running");
            return;
        }

        self.app_handle = Some(app_handle.clone());
        self.monitoring.store(true, Ordering::Relaxed);

        let monitoring = Arc::clone(&self.monitoring);
        let handle = thread::spawn(move || {
            HardwareMonitorLoop::new(app_handle, monitoring, board, observer).run();
        });

        self.monitor_handle = Some(handle);
        log::info!("Hardware monitoring started");
    }

    /// Stop monitoring
    pub fn stop_monitoring(&mut self) {
        if !self.monitoring.load(Ordering::Relaxed) {
            return;
        }

        self.monitoring.store(false, Ordering::Relaxed);

        if let Some(handle) = self.monitor_handle.take() {
            let _ = handle.join();
        }

        log::info!("Hardware monitoring stopped");
    }

    /// Get available serial ports (static method for commands)
    pub fn get_available_ports() -> Result<Vec<SerialPortInfo>, String> {
        PortMonitor::get_ports().map_err(|e| e.to_string())
    }
}

impl Default for HardwareService {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for HardwareService {
    fn drop(&mut self) {
        self.stop_monitoring();
    }
}

// ============================================================================
// Monitor Loop - Background orchestration
// ============================================================================

/// Encapsulates the monitoring loop and board lifecycle management
struct HardwareMonitorLoop {
    events: EventEmitter,
    monitoring: Arc<AtomicBool>,
    board: BoardLink,
    known_devices: HashMap<String, SerialPortInfo>,
}

impl HardwareMonitorLoop {
    fn new(
        app_handle: tauri::AppHandle,
        monitoring: Arc<AtomicBool>,
        board: BoardLink,
        observer: BoardStateObserver,
    ) -> Self {
        Self {
            events: EventEmitter::with_observer(app_handle, observer),
            monitoring,
            board,
            known_devices: HashMap::new(),
        }
    }

    fn run(&mut self) {
        log::info!("Hardware monitor loop started");

        // Initial scan
        self.scan_initial_ports();

        // Poll loop
        let interval = Duration::from_millis(HardwareService::POLL_INTERVAL_MS);
        while self.monitoring.load(Ordering::Relaxed) {
            self.poll_for_changes();
            thread::sleep(interval);
        }

        log::info!("Hardware monitor loop ended");
    }

    fn scan_initial_ports(&mut self) {
        match PortMonitor::get_ports() {
            Ok(ports) => {
                log::info!("Found {} initial ports", ports.len());
                for port in ports {
                    self.handle_port_connected(port);
                }
            }
            Err(e) => log::error!("Failed to get initial ports: {e}"),
        }
    }

    fn poll_for_changes(&mut self) {
        let Ok(current_ports) = PortMonitor::get_ports() else { return };

        let current_map: HashMap<String, SerialPortInfo> = current_ports
            .into_iter()
            .map(|p| (PortMonitor::canonical_id(&p.port_name), p))
            .collect();

        // Detect implicit disconnect: board reset without USB disconnect.
        // The reader thread sets is_connected=false on I/O error, but the USB port
        // stays present, so the normal disconnect detection never fires.
        if !self.board.is_connected() {
            let stale: Vec<_> = self
                .known_devices
                .iter()
                .filter(|(id, port)| port.has_firmata == Some(true) && current_map.contains_key(*id))
                .map(|(id, _)| id.clone())
                .collect();
            for id in stale {
                if let Some(port) = self.known_devices.remove(&id) {
                    log::info!("Board on {} lost connection without USB disconnect, re-detecting", port.port_name);
                    self.board.disconnect();
                    self.events.board_disconnected();
                }
            }
        }

        // Detect new ports (including any cleared by implicit disconnect above)
        for (device_id, port) in &current_map {
            if !self.known_devices.contains_key(device_id) {
                self.handle_port_connected(port.clone());
            }
        }

        // Detect disconnected ports
        let disconnected: Vec<_> = self
            .known_devices
            .iter()
            .filter(|(id, _)| !current_map.contains_key(*id))
            .map(|(_, port)| port.clone())
            .collect();

        for port in disconnected {
            self.handle_port_disconnected(&port);
        }

        // Update known devices (preserve has_firmata)
        self.known_devices = current_map
            .into_iter()
            .map(|(id, mut port)| {
                if let Some(known) = self.known_devices.get(&id) {
                    port.has_firmata = known.has_firmata;
                }
                (id, port)
            })
            .collect();
    }

    fn handle_port_connected(&mut self, mut port: SerialPortInfo) {
        let device_id = PortMonitor::canonical_id(&port.port_name);

        // Skip system ports entirely (Bluetooth, debug consoles, etc.)
        if PortMonitor::should_skip_firmata_test(&port.port_name) {
            log::debug!("Skipping system port: {}", port.port_name);
            port.has_firmata = Some(false);
            self.known_devices.insert(device_id, port);
            return;
        }

        // Check if this is a known board type before processing
        let is_known_board = port
            .usb_ids()
            .and_then(|(vid, pid)| BoardConfig::detect_from_usb(vid, pid))
            .is_some();

        // Only process USB ports for board detection
        let board_state = if port.is_usb() {
            self.process_usb_port(&port)
        } else {
            log::debug!("Skipping non-USB port: {}", port.port_name);
            None
        };

        port.has_firmata = Some(board_state.is_some());
        self.known_devices.insert(device_id.clone(), port.clone());

        // Emit events
        log::info!(
            "Port connected: {} (Firmata: {})",
            port.port_name,
            port.has_firmata.unwrap_or(false)
        );
        self.events.port_connected(&port);

        match board_state {
            Some(state) => self.events.board_state(&state),
            // Only emit error for known boards that failed - unknown USB devices
            // without Firmata are just ignored (no board_disconnected spam)
            None if is_known_board => self.events.no_firmata_error(&port.port_name),
            None => {} // Don't emit board_disconnected for unknown devices
        }
    }

    fn handle_port_disconnected(&self, port: &SerialPortInfo) {
        log::info!("Port disconnected: {}", port.port_name);
        self.events.port_disconnected(port);

        if port.has_firmata == Some(true) {
            // Disconnect the shared board handle
            self.board.disconnect();
            self.events.board_disconnected();
        }
    }

    /// Process a USB port: detect board, flash if needed, detect Firmata
    fn process_usb_port(&self, port: &SerialPortInfo) -> Option<BoardState> {
        // Try to identify board by USB IDs
        let board_type = port
            .usb_ids()
            .and_then(|(vid, pid)| BoardConfig::detect_from_usb(vid, pid));

        if let Some(bt) = board_type {
            log::info!("Detected {:?} on {} by USB IDs", bt, port.port_name);
            return self.handle_known_board(port, bt);
        }

        // Unknown USB device - just try Firmata detection
        log::info!("Unknown USB device on {}, trying Firmata", port.port_name);
        self.events.board_connecting();
        firmata::detect_and_connect(&port.port_name, &self.board)
    }

    /// Handle a known Arduino board type
    fn handle_known_board(
        &self,
        port: &SerialPortInfo,
        board_type: crate::flasher::BoardType,
    ) -> Option<BoardState> {
        // First check if Firmata is already running
        self.events.board_connecting();
        if let Some(state) = firmata::detect_and_connect(&port.port_name, &self.board) {
            log::info!("Firmata already running on {board_type:?}");
            return Some(state);
        }

        // No Firmata - flash StandardFirmata
        log::info!("No Firmata on {board_type:?}, flashing...");
        self.flash_and_detect(port, board_type)
    }

    /// Flash `StandardFirmata` and detect
    fn flash_and_detect(
        &self,
        port: &SerialPortInfo,
        board_type: crate::flasher::BoardType,
    ) -> Option<BoardState> {
        self.events.board_flashing(&port.port_name, board_type.as_str());

        // Small delay for port readiness
        thread::sleep(Duration::from_millis(500));

        match Flasher::flash_standard_firmata(&port.port_name, board_type) {
            Ok(result) => {
                log::info!("Flash successful: {}", result.message);

                // Wait for board reset
                thread::sleep(Duration::from_millis(2500));

                // Detect Firmata and connect
                self.events.board_connecting();
                firmata::detect_and_connect(&port.port_name, &self.board)
            }
            Err(e) => {
                log::error!("Flash failed: {e}");
                self.events.board_error(&format!("Flash failed: {e}"));
                None
            }
        }
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Get available serial ports
#[tauri::command]
pub fn get_available_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    HardwareService::get_available_ports()
}
