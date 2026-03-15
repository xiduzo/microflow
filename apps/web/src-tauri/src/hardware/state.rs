//! Board Connection State Machine
//!
//! Provides a thread-safe state machine for managing board connection lifecycle.
//! Uses atomic operations to ensure race-free state transitions.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::RwLock;

/// Possible states for board connection lifecycle
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum BoardConnectionState {
    /// No board connected
    Disconnected = 0,
    /// Scanning port for board type
    Detecting = 1,
    /// Flashing firmware to board
    Flashing = 2,
    /// Establishing Firmata connection
    Connecting = 3,
    /// Board connected and ready
    Connected = 4,
    /// Error occurred during connection
    Error = 5,
}

impl BoardConnectionState {
    /// Convert from u8, returns Disconnected for invalid values
    #[must_use] 
    pub fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Detecting,
            2 => Self::Flashing,
            3 => Self::Connecting,
            4 => Self::Connected,
            5 => Self::Error,
            _ => Self::Disconnected,
        }
    }

    /// Get human-readable state name
    #[must_use] 
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Disconnected => "disconnected",
            Self::Detecting => "detecting",
            Self::Flashing => "flashing",
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Error => "error",
        }
    }
}

/// Thread-safe state machine for board connection lifecycle
///
/// Uses atomic operations for state storage to ensure thread-safe access
/// without requiring locks for state reads.
pub struct BoardStateMachine {
    /// Current state stored as atomic u8 for thread-safe access
    state: AtomicU8,
    /// Last error message for debugging failed transitions
    last_error: RwLock<Option<String>>,
}

impl BoardStateMachine {
    /// Create a new `BoardStateMachine` with initial Disconnected state
    #[must_use] 
    pub fn new() -> Self {
        Self {
            state: AtomicU8::new(BoardConnectionState::Disconnected as u8),
            last_error: RwLock::new(None),
        }
    }

    /// Get current state
    ///
    /// Uses `SeqCst` ordering to ensure consistent reads across threads.
    pub fn current(&self) -> BoardConnectionState {
        BoardConnectionState::from_u8(self.state.load(Ordering::SeqCst))
    }

    /// Force set the state to a specific value.
    ///
    /// This method bypasses the normal transition logic and directly sets the state.
    /// Primarily intended for testing purposes to set up specific initial states.
    ///
    /// # Arguments
    /// * `state` - The state to force set
    pub fn force_state(&self, state: BoardConnectionState) {
        self.state.store(state as u8, Ordering::SeqCst);
    }

    /// Force set the state from a raw u8 value.
    ///
    /// This method bypasses the normal transition logic and directly sets the state.
    /// Primarily intended for testing purposes to set up specific initial states.
    /// Invalid u8 values (>= 6) will be treated as Disconnected by `from_u8`.
    ///
    /// # Arguments
    /// * `value` - The raw u8 value to set as state
    pub fn force_state_raw(&self, value: u8) {
        self.state.store(value, Ordering::SeqCst);
    }

    /// Attempt atomic state transition
    ///
    /// Uses `compare_exchange` to atomically transition from one state to another.
    /// Returns true if transition succeeded (current state matched `from`),
    /// false if current state didn't match `from` (state remains unchanged).
    ///
    /// # Arguments
    /// * `from` - The expected current state
    /// * `to` - The desired new state
    ///
    /// # Returns
    /// * `true` - Transition succeeded, state is now `to`
    /// * `false` - Transition failed, state remains unchanged
    pub fn transition(
        &self,
        from: BoardConnectionState,
        to: BoardConnectionState,
    ) -> bool {
        self.state
            .compare_exchange(
                from as u8,
                to as u8,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }

    /// Get the current state as a raw u8 value.
    ///
    /// This is useful for testing to verify the exact internal state value.
    pub fn current_raw(&self) -> u8 {
        self.state.load(Ordering::SeqCst)
    }

    /// Set error state with message
    ///
    /// Stores the error message in `last_error` and forces transition to Error state.
    /// This is used when an error occurs during connection operations.
    ///
    /// # Arguments
    /// * `message` - The error message to store for debugging
    pub fn set_error(&self, message: String) {
        if let Ok(mut guard) = self.last_error.write() {
            *guard = Some(message);
        }
        // Force transition to Error state
        self.state.store(BoardConnectionState::Error as u8, Ordering::SeqCst);
    }

    /// Get last error message
    ///
    /// Retrieves the stored error message, if any. Returns None if no error
    /// has been set or if the lock cannot be acquired.
    ///
    /// # Returns
    /// * `Some(String)` - The last error message
    /// * `None` - No error stored or lock acquisition failed
    pub fn get_last_error(&self) -> Option<String> {
        self.last_error.read().ok().and_then(|g| g.clone())
    }

    /// Clear error and reset to Disconnected
    ///
    /// Clears the stored error message and resets the state machine to
    /// Disconnected state. This allows for retry after an error.
    pub fn reset(&self) {
        if let Ok(mut guard) = self.last_error.write() {
            *guard = None;
        }
        self.state.store(BoardConnectionState::Disconnected as u8, Ordering::SeqCst);
    }
}

impl Default for BoardStateMachine {
    fn default() -> Self {
        Self::new()
    }
}
