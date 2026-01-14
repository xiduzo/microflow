//! Board Connection Manager
//!
//! Manages the Firmata board connection and provides a thread-safe
//! interface for components to interact with the hardware.

use crate::runtime::BoardHandle;
use firmata_rs::Firmata;
use std::sync::Arc;

/// Board manager handles the lifecycle of a Firmata connection.
/// The actual connection is managed by the hardware monitor and stored
/// in the shared BoardHandle.
pub struct BoardManager {
    handle: Arc<BoardHandle>,
}

impl BoardManager {
    pub fn new() -> Self {
        Self {
            handle: Arc::new(BoardHandle::new()),
        }
    }

    /// Get a handle to the board for components to use
    pub fn handle(&self) -> Arc<BoardHandle> {
        Arc::clone(&self.handle)
    }

    /// Check if connected
    pub fn is_connected(&self) -> bool {
        self.handle.is_connected()
    }

    /// Disconnect from the board
    pub fn disconnect(&mut self) {
        if self.is_connected() {
            log::info!("Disconnecting from board");
            self.handle.disconnect();
        }
    }

    /// Execute a read cycle to get latest pin states
    pub fn poll(&self) -> Result<(), String> {
        self.handle.with_board(|conn| {
            conn.board
                .read_and_decode()
                .map(|_| ())
                .map_err(|e| format!("Poll error: {}", e))
        })
    }
}

impl Default for BoardManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for BoardManager {
    fn drop(&mut self) {
        self.disconnect();
    }
}
