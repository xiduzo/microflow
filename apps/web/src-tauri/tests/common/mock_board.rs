//! Mock board handle for testing components without hardware
//!
//! This module provides a `MockBoardHandle` that simulates hardware board
//! interactions for testing purposes, allowing tests to run without
//! actual hardware connected.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

/// Mock board handle for testing components without hardware
///
/// Provides a thread-safe simulation of a hardware board with:
/// - Pin value tracking via a `HashMap`
/// - Connection state via an `AtomicBool`
///
/// # Example
/// ```
/// use mock_board::MockBoardHandle;
///
/// let board = MockBoardHandle::new();
/// assert!(board.is_connected());
///
/// board.set_pin(13, 255);
/// assert_eq!(board.get_pin(13), Some(255));
///
/// board.disconnect();
/// assert!(!board.is_connected());
/// ```
pub struct MockBoardHandle {
    /// Pin values stored as pin number -> value mapping
    /// Uses `RwLock` for thread-safe read/write access
    pin_values: RwLock<HashMap<u8, u16>>,
    /// Connection state - true when "connected" to mock hardware
    /// Uses `AtomicBool` for lock-free thread-safe access
    connected: AtomicBool,
}

impl MockBoardHandle {
    /// Create a new mock board handle
    ///
    /// The board starts in a connected state with no pin values set.
    pub fn new() -> Self {
        Self {
            pin_values: RwLock::new(HashMap::new()),
            connected: AtomicBool::new(true),
        }
    }

    /// Set a pin value on the mock board
    ///
    /// # Arguments
    /// * `pin` - The pin number (0-255)
    /// * `value` - The value to set (0-65535 for analog, typically 0/1 for digital)
    ///
    /// # Note
    /// If the `RwLock` is poisoned, this operation silently fails.
    pub fn set_pin(&self, pin: u8, value: u16) {
        if let Ok(mut guard) = self.pin_values.write() {
            guard.insert(pin, value);
        }
    }

    /// Get a pin value from the mock board
    ///
    /// # Arguments
    /// * `pin` - The pin number to read
    ///
    /// # Returns
    /// * `Some(value)` if the pin has been set
    /// * `None` if the pin has never been set or the `RwLock` is poisoned
    pub fn get_pin(&self, pin: u8) -> Option<u16> {
        self.pin_values.read().ok().and_then(|g| g.get(&pin).copied())
    }

    /// Check if the mock board is connected
    ///
    /// # Returns
    /// * `true` if the board is in connected state
    /// * `false` if `disconnect()` has been called
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// Disconnect the mock board
    ///
    /// Sets the connection state to false. This can be used to test
    /// component behavior when hardware becomes unavailable.
    pub fn disconnect(&self) {
        self.connected.store(false, Ordering::SeqCst);
    }
}

impl Default for MockBoardHandle {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_board_is_connected() {
        let board = MockBoardHandle::new();
        assert!(board.is_connected());
    }

    #[test]
    fn test_set_and_get_pin() {
        let board = MockBoardHandle::new();
        
        // Pin should be None initially
        assert_eq!(board.get_pin(13), None);
        
        // Set pin value
        board.set_pin(13, 255);
        assert_eq!(board.get_pin(13), Some(255));
        
        // Update pin value
        board.set_pin(13, 128);
        assert_eq!(board.get_pin(13), Some(128));
    }

    #[test]
    fn test_multiple_pins() {
        let board = MockBoardHandle::new();
        
        board.set_pin(0, 0);
        board.set_pin(13, 255);
        board.set_pin(255, 1023);
        
        assert_eq!(board.get_pin(0), Some(0));
        assert_eq!(board.get_pin(13), Some(255));
        assert_eq!(board.get_pin(255), Some(1023));
        assert_eq!(board.get_pin(1), None); // Unset pin
    }

    #[test]
    fn test_disconnect() {
        let board = MockBoardHandle::new();
        
        assert!(board.is_connected());
        board.disconnect();
        assert!(!board.is_connected());
    }

    #[test]
    fn test_default_trait() {
        let board = MockBoardHandle::default();
        assert!(board.is_connected());
        assert_eq!(board.get_pin(0), None);
    }
}
