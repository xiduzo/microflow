//! Event emission - single source of truth for all Tauri events
//!
//! All hardware-related events flow through this module, ensuring
//! consistent event naming and payload structure.

use super::port_monitor::SerialPortInfo;
use super::types::BoardState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Emitter;
use ts_rs::TS;

/// Callback invoked in-process for every `board-state` transition, before the
/// Tauri event is emitted. Lets the host runtime mutate `AppState`
/// (`board_connected`, `pending_flow`, …) without round-tripping through the
/// Tauri event bus.
pub type BoardStateObserver = Arc<dyn Fn(&BoardState) + Send + Sync>;

/// Event payload for serial port connection/disconnection
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SerialPortEvent {
    pub port: SerialPortInfo,
    pub event_type: String,
}

/// Centralized event emitter for hardware events
pub struct EventEmitter {
    app_handle: tauri::AppHandle,
    board_state_observer: Option<BoardStateObserver>,
}

impl EventEmitter {
    #[must_use]
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle, board_state_observer: None }
    }

    /// Construct with an in-process observer that runs for every board-state
    /// transition. Used by the host (`lib.rs`) to update `AppState` directly
    /// instead of subscribing to its own Tauri event bus.
    #[must_use]
    pub fn with_observer(app_handle: tauri::AppHandle, observer: BoardStateObserver) -> Self {
        Self { app_handle, board_state_observer: Some(observer) }
    }

    // ========================================================================
    // Board State Events
    // ========================================================================

    /// Notify in-process observer (if any), then emit to the Tauri event bus.
    /// Observer runs first so internal state (e.g. `AppState.board_connected`)
    /// is updated before any UI handler reacts to the same transition.
    pub fn board_state(&self, state: &BoardState) {
        if let Some(observer) = &self.board_state_observer {
            observer(state);
        }
        if let Err(e) = self.app_handle.emit("board-state", state) {
            log::error!("Failed to emit board-state: {e}");
        }
    }

    /// Emit connecting state
    pub fn board_connecting(&self) {
        self.board_state(&BoardState::Connecting {});
    }

    /// Emit flashing state
    pub fn board_flashing(&self, port: &str, board: &str) {
        self.board_state(&BoardState::Flashing {
            port: port.to_string(),
            board: board.to_string(),
        });
    }

    /// Emit disconnected state
    pub fn board_disconnected(&self) {
        self.board_state(&BoardState::Disconnected {});
    }

    /// Emit error state
    pub fn board_error(&self, message: &str) {
        self.board_state(&BoardState::Error {
            error: Some(message.to_string()),
        });
    }

    /// Emit error for port without Firmata
    pub fn no_firmata_error(&self, port_name: &str) {
        self.board_error(&format!("No Firmata detected on {port_name}"));
    }

    // ========================================================================
    // Port Events
    // ========================================================================

    /// Emit port connected event
    pub fn port_connected(&self, port: &SerialPortInfo) {
        let event = SerialPortEvent {
            port: port.clone(),
            event_type: "connected".to_string(),
        };
        if let Err(e) = self.app_handle.emit("serial-port-connected", &event) {
            log::error!("Failed to emit serial-port-connected: {e}");
        }
    }

    /// Emit port disconnected event
    pub fn port_disconnected(&self, port: &SerialPortInfo) {
        let event = SerialPortEvent {
            port: port.clone(),
            event_type: "disconnected".to_string(),
        };
        if let Err(e) = self.app_handle.emit("serial-port-disconnected", &event) {
            log::error!("Failed to emit serial-port-disconnected: {e}");
        }
    }
}
