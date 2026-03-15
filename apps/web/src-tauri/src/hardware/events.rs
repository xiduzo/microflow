//! Event emission - single source of truth for all Tauri events
//!
//! All hardware-related events flow through this module, ensuring
//! consistent event naming and payload structure.

use super::port_monitor::SerialPortInfo;
use super::types::BoardState;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

/// Event payload for serial port connection/disconnection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialPortEvent {
    pub port: SerialPortInfo,
    pub event_type: String,
}

/// Centralized event emitter for hardware events
pub struct EventEmitter {
    app_handle: tauri::AppHandle,
}

impl EventEmitter {
    #[must_use] 
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle }
    }

    // ========================================================================
    // Board State Events
    // ========================================================================

    /// Emit any board state
    pub fn board_state(&self, state: BoardState) {
        if let Err(e) = self.app_handle.emit("board-state", &state) {
            log::error!("Failed to emit board-state: {e}");
        }
    }

    /// Emit connecting state
    pub fn board_connecting(&self) {
        self.board_state(BoardState::Connecting {});
    }

    /// Emit flashing state
    pub fn board_flashing(&self, port: &str, board: &str) {
        self.board_state(BoardState::Flashing {
            port: port.to_string(),
            board: board.to_string(),
        });
    }

    /// Emit disconnected state
    pub fn board_disconnected(&self) {
        self.board_state(BoardState::Disconnected {});
    }

    /// Emit error state
    pub fn board_error(&self, message: &str) {
        self.board_state(BoardState::Error {
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
