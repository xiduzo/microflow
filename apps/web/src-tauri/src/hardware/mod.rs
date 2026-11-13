//! Hardware Module
//!
//! Orchestrates all hardware-related operations: port monitoring, board detection,
//! firmware flashing, and Firmata communication.
//!
//! # Architecture
//!
//! ```text
//! hardware/
//! ├── mod.rs           - Module exports, HardwareService, the desktop LinkIo adapter
//! ├── board_link.rs    - BoardLink: the one owner of board connection state
//! ├── types.rs         - Shared types (BoardState, events, etc.)
//! ├── port_monitor.rs  - Serial port discovery and monitoring
//! ├── firmata.rs       - Firmata protocol detection
//! └── events.rs        - Event emission (single source of truth)
//! ```
//!
//! # Design Principles
//!
//! 1. **One owner of connection state**: [`board_link`] decides which port is
//!    the board and whether it is connected; port scans and the runtime actor
//!    only feed it facts
//! 2. **Dependency Inversion**: `HardwareService` orchestrates, submodules don't know each other
//! 3. **Event Centralization**: All Tauri events flow through `events.rs`
//! 4. **Clean Boundaries**: Flasher module is called, never calls back

mod board_link;
mod events;
mod firmata;
mod port_monitor;
mod types;

pub use board_link::{FlashAnswer, OfferId, SessionId};
pub use events::{BoardStateObserver, EventEmitter};
pub use port_monitor::{PortMonitor, SerialPortInfo};
pub use types::BoardState;

use crate::flasher::{BoardType, Flasher};
use crate::runtime::host::ActorLink;
use board_link::{BoardLink, LinkIo};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

/// Central orchestrator for all hardware operations.
///
/// Coordinates between port monitoring, Firmata detection, and flashing
/// while maintaining a clean separation of concerns.
pub struct HardwareService {
    app_handle: Option<tauri::AppHandle>,
    monitoring: Arc<AtomicBool>,
    monitor_handle: Option<thread::JoinHandle<()>>,
    /// The UI's answers to a flash offer, drained by the monitor loop.
    flash_answers: Option<Sender<FlashAnswer>>,
}

impl HardwareService {
    const POLL_INTERVAL_MS: u64 = 250;

    #[must_use]
    pub fn new() -> Self {
        Self {
            app_handle: None,
            monitoring: Arc::new(AtomicBool::new(false)),
            monitor_handle: None,
            flash_answers: None,
        }
    }

    /// Start monitoring for hardware changes.
    /// When Firmata is detected the open port is handed to the runtime actor
    /// through `actor`; the actor reports a failed session back on
    /// `session_ended`. The `observer` runs in-process on every `board-state`
    /// transition (before the Tauri emit) so the host can mutate `AppState`
    /// without listening to its own event bus.
    pub fn start_monitoring(
        &mut self,
        app_handle: tauri::AppHandle,
        actor: ActorLink,
        session_ended: Receiver<SessionId>,
        observer: BoardStateObserver,
    ) {
        if self.monitoring.load(Ordering::Relaxed) {
            log::warn!("Hardware monitoring already running");
            return;
        }

        self.app_handle = Some(app_handle.clone());
        self.monitoring.store(true, Ordering::Relaxed);

        let monitoring = Arc::clone(&self.monitoring);
        let (answers_tx, flash_answers) = mpsc::channel();
        self.flash_answers = Some(answers_tx);
        let handle = thread::spawn(move || {
            let io = DesktopLinkIo {
                events: EventEmitter::with_observer(app_handle, observer),
                actor,
            };
            HardwareMonitorLoop { monitoring, link: BoardLink::new(io), session_ended, flash_answers }
                .run();
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

    /// Hand the user's answer to a flash offer to the monitor loop. Never
    /// blocks: the loop picks it up on its next tick.
    ///
    /// # Errors
    /// When monitoring is not running.
    pub fn answer_flash(&self, answer: FlashAnswer) -> Result<(), String> {
        let sender = self.flash_answers.as_ref().ok_or("Hardware monitoring is not running")?;
        sender.send(answer).map_err(|_| "Hardware monitoring has stopped".to_string())
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

/// The poll loop: every tick it feeds the [`BoardLink`] the facts — sessions
/// the runtime reported ended, then the ports present — and the link decides.
struct HardwareMonitorLoop {
    monitoring: Arc<AtomicBool>,
    link: BoardLink<DesktopLinkIo>,
    session_ended: Receiver<SessionId>,
    flash_answers: Receiver<FlashAnswer>,
}

impl HardwareMonitorLoop {
    fn run(&mut self) {
        log::info!("Hardware monitor loop started");

        let interval = Duration::from_millis(HardwareService::POLL_INTERVAL_MS);
        while self.monitoring.load(Ordering::Relaxed) {
            self.tick();
            thread::sleep(interval);
        }

        log::info!("Hardware monitor loop ended");
    }

    fn tick(&mut self) {
        self.link.drain_session_ends(&self.session_ended);
        self.link.drain_flash_answers(&self.flash_answers);
        match PortMonitor::get_ports() {
            Ok(ports) => self.link.scan(ports),
            Err(e) => log::debug!("Port scan failed: {e}"),
        }
    }
}

/// The desktop implementation of the board link's [`LinkIo`] seam: real serial
/// probe, real flasher, the runtime actor, and Tauri events. Owns the I/O and
/// its timing (boot/settle sleeps) only — no decisions.
struct DesktopLinkIo {
    events: EventEmitter,
    actor: ActorLink,
}

impl LinkIo for DesktopLinkIo {
    fn probe(&mut self, port: &str, after_flash: bool, session: SessionId) -> Option<BoardState> {
        if after_flash {
            // Wait for the board to reboot into the fresh sketch.
            thread::sleep(Duration::from_millis(2500));
        }
        let detected = firmata::detect(port)?;
        // The actor seeds its codec from the pin table and (re)applies the
        // active flow against the fresh board.
        self.actor.connect_board(detected.port, detected.pins_json, session);
        log::info!("Board on {port} handed to runtime actor as session {session}");
        Some(detected.state)
    }

    fn flash(&mut self, port: &str, board: BoardType) -> Result<(), String> {
        // Small delay for port readiness after the failed probe.
        thread::sleep(Duration::from_millis(500));
        let result = Flasher::flash_standard_firmata(port, board).map_err(|e| e.to_string())?;
        log::info!("Flash successful: {}", result.message);
        Ok(())
    }

    fn close(&mut self) {
        self.actor.disconnect();
    }

    fn board_state(&mut self, state: &BoardState) {
        self.events.board_state(state);
    }

    fn port_connected(&mut self, port: &SerialPortInfo) {
        self.events.port_connected(port);
    }

    fn port_disconnected(&mut self, port: &SerialPortInfo) {
        self.events.port_disconnected(port);
    }

    fn now(&self) -> Instant {
        Instant::now()
    }

    fn device_at(&mut self, port: &str) -> Option<SerialPortInfo> {
        PortMonitor::get_ports().ok()?.into_iter().find(|p| p.port_name == port)
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

/// The user said yes to the `confirmFlash` board state: flash the offered board.
/// `port`/`vid`/`pid` name the offer answered; a stale answer is ignored.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn confirm_board_flash(
    state: tauri::State<'_, crate::AppState>,
    port: String,
    vid: u16,
    pid: u16,
) -> Result<(), String> {
    answer_board_flash(&state, FlashAnswer::Confirm(OfferId { port, vid, pid }))
}

/// The user said no to the `confirmFlash` board state: leave the device alone.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn decline_board_flash(
    state: tauri::State<'_, crate::AppState>,
    port: String,
    vid: u16,
    pid: u16,
) -> Result<(), String> {
    answer_board_flash(&state, FlashAnswer::Decline(OfferId { port, vid, pid }))
}

fn answer_board_flash(state: &crate::AppState, answer: FlashAnswer) -> Result<(), String> {
    state
        .hardware_service
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .answer_flash(answer)
}
