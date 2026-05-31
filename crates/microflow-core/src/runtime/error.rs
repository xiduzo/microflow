//! Runtime error types, mirrored from the desktop crate so component node code
//! moves into core unchanged. The cloud-only `Mqtt` variant is gated behind the
//! `cloud` feature so the browser wasm build doesn't pull it in.

use thiserror::Error;

/// Top-level runtime error type.
#[derive(Error, Debug)]
pub enum RuntimeError {
    /// No Firmata board is connected.
    #[error("Board not connected")]
    BoardNotConnected,

    /// Referenced component doesn't exist.
    #[error("Component '{0}' not found")]
    ComponentNotFound(String),

    /// Pin configuration is invalid.
    #[error("Invalid pin configuration: {0}")]
    InvalidPin(String),

    /// Hardware-level failure.
    #[error("Hardware error: {0}")]
    Hardware(#[from] HardwareError),

    /// MQTT operation failure.
    #[cfg(feature = "cloud")]
    #[error("MQTT error: {0}")]
    Mqtt(#[from] MqttError),

    /// JSON serialization failure.
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// Mutex was poisoned (desktop host only; kept for node-code parity).
    #[error("Lock poisoned: {0}")]
    LockPoisoned(String),

    /// Component config failed to deserialize against the expected `Config` type.
    #[error("Component '{component}' has invalid config: {source}")]
    ConfigDeserialize {
        component: String,
        #[source]
        source: serde_json::Error,
    },

    /// Generic component error (for component-specific failures).
    #[error("{0}")]
    ComponentError(String),
}

/// Hardware-specific errors with context.
#[derive(Error, Debug)]
pub enum HardwareError {
    /// Failed to open serial port.
    #[error("Failed to open port '{port}': {reason}")]
    PortOpen { port: String, reason: String },

    /// Firmata protocol error.
    #[error("Firmata communication failed: {0}")]
    FirmataCommunication(String),

    /// Pin doesn't support the requested mode.
    #[error("Pin {pin} does not support mode {mode}")]
    UnsupportedPinMode { pin: u8, mode: u8 },

    /// The board transport shut down before the command could be processed.
    #[error("Board IO loop disconnected before command completed")]
    Disconnected,
}

/// MQTT-specific errors (cloud feature only).
#[cfg(feature = "cloud")]
#[derive(Error, Debug)]
pub enum MqttError {
    /// Broker is not connected.
    #[error("Broker '{0}' not connected")]
    NotConnected(String),

    /// Connection to broker failed.
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    /// Failed to subscribe to topic.
    #[error("Subscribe failed for topic '{topic}': {reason}")]
    SubscribeFailed { topic: String, reason: String },
}

impl RuntimeError {
    /// Convert to a frontend-friendly error message.
    #[must_use]
    pub fn to_frontend_message(&self) -> String {
        self.to_string()
    }
}

impl From<RuntimeError> for String {
    fn from(err: RuntimeError) -> String {
        err.to_string()
    }
}
