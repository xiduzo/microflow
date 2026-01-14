//! Board Connection Manager
//!
//! Manages the Firmata board connection and provides a thread-safe
//! interface for components to interact with the hardware.

use super::types::{BoardState, PinInfo};
use crate::runtime::{BoardConnection, BoardHandle, SerialPortWrapper};
use firmata_rs::{Board, Firmata};
use std::sync::Arc;
use std::time::Duration;

/// Board manager handles the lifecycle of a Firmata connection
pub struct BoardManager {
    handle: Arc<BoardHandle>,
    port_name: Option<String>,
}

impl BoardManager {
    pub fn new() -> Self {
        Self {
            handle: Arc::new(BoardHandle::new()),
            port_name: None,
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

    /// Get the current port name
    pub fn port_name(&self) -> Option<&str> {
        self.port_name.as_deref()
    }

    /// Connect to a board on the specified port
    pub fn connect(&mut self, port_name: &str, baud_rate: u32) -> Result<BoardState, String> {
        // Disconnect existing connection
        self.disconnect();

        log::info!("Connecting to board on {} at {} baud", port_name, baud_rate);

        // Open serial port
        let port = serialport::new(port_name, baud_rate)
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(|e| format!("Failed to open port: {}", e))?;

        // Create wrapper for firmata-rs
        let wrapper = SerialPortWrapper::new(port);
        let mut board = Board::new(Box::new(wrapper))
            .map_err(|e| format!("Failed to create board: {}", e))?;

        // Query firmware info
        board
            .query_firmware()
            .map_err(|e| format!("Failed to query firmware: {}", e))?;

        // Read firmware response
        for _ in 0..10 {
            match board.read_and_decode() {
                Ok(_) if !board.firmware_name.is_empty() => break,
                Err(e) => {
                    log::debug!("Read error during firmware query: {}", e);
                }
                _ => continue,
            }
        }

        if board.firmware_name.is_empty() {
            return Err("Failed to get firmware info".to_string());
        }

        let firmware_name = board.firmware_name.clone();
        let firmware_version = board.firmware_version.clone();

        log::info!(
            "Connected to {} v{} on {}",
            firmware_name,
            firmware_version,
            port_name
        );

        // Query capabilities
        let _ = board.query_capabilities();
        let _ = board.query_analog_mapping();

        for _ in 0..10 {
            if board.read_and_decode().is_err() {
                break;
            }
        }

        // Extract pin info
        let pins: Vec<PinInfo> = board
            .pins()
            .iter()
            .enumerate()
            .map(|(index, pin)| PinInfo {
                pin: index,
                supported_modes: pin.modes.iter().map(|m| m.mode).collect(),
                analog_channel: if pin.analog { index as i32 } else { -1 },
            })
            .collect();

        log::info!("Found {} pins", pins.len());

        // Create connection wrapper
        let connection = BoardConnection {
            board,
            port_name: port_name.to_string(),
        };

        // Store in handle
        self.handle.connect(connection);
        self.port_name = Some(port_name.to_string());

        Ok(BoardState::Connected {
            port: port_name.to_string(),
            firmware_name,
            firmware_version,
            pins,
        })
    }

    /// Disconnect from the board
    pub fn disconnect(&mut self) {
        if self.is_connected() {
            log::info!("Disconnecting from board");
            self.handle.disconnect();
            self.port_name = None;
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
