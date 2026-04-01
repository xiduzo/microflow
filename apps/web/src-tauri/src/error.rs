//! Unified error types for the Microflow Tauri runtime.
//!
//! This module provides structured error types with context for all runtime operations,
//! enabling better error handling and diagnostics.

use thiserror::Error;

/// Top-level runtime error type
#[derive(Error, Debug)]
pub enum RuntimeError {
    /// No Firmata board is connected
    #[error("Board not connected")]
    BoardNotConnected,

    /// Referenced component doesn't exist
    #[error("Component '{0}' not found")]
    ComponentNotFound(String),

    /// Pin configuration is invalid
    #[error("Invalid pin configuration: {0}")]
    InvalidPin(String),

    /// Hardware-level failure
    #[error("Hardware error: {0}")]
    Hardware(#[from] HardwareError),

    /// MQTT operation failure
    #[error("MQTT error: {0}")]
    Mqtt(#[from] MqttError),

    /// JSON serialization failure
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// Mutex was poisoned
    #[error("Lock poisoned: {0}")]
    LockPoisoned(String),

    /// Generic component error (for component-specific failures)
    #[error("{0}")]
    ComponentError(String),
}

/// Hardware-specific errors with context
#[derive(Error, Debug)]
pub enum HardwareError {
    /// Failed to open serial port
    #[error("Failed to open port '{port}': {reason}")]
    PortOpen { port: String, reason: String },

    /// Firmata protocol error
    #[error("Firmata communication failed: {0}")]
    FirmataCommunication(String),

    /// Pin doesn't support requested mode
    #[error("Pin {pin} does not support mode {mode}")]
    UnsupportedPinMode { pin: u8, mode: u8 },
}

/// MQTT-specific errors
#[derive(Error, Debug)]
pub enum MqttError {
    /// Broker is not connected
    #[error("Broker '{0}' not connected")]
    NotConnected(String),

    /// Connection to broker failed
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    /// Failed to subscribe to topic
    #[error("Subscribe failed for topic '{topic}': {reason}")]
    SubscribeFailed { topic: String, reason: String },
}

impl RuntimeError {
    /// Convert to a frontend-friendly error message
    #[must_use] 
    pub fn to_frontend_message(&self) -> String {
        self.to_string()
    }
}

/// Conversion from `RuntimeError` to String for Tauri command error handling
impl From<RuntimeError> for String {
    fn from(err: RuntimeError) -> String {
        err.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_board_not_connected_error() {
        let err = RuntimeError::BoardNotConnected;
        assert_eq!(err.to_string(), "Board not connected");
    }

    #[test]
    fn test_component_not_found_error() {
        let err = RuntimeError::ComponentNotFound("button-1".to_string());
        let msg = err.to_string();
        assert!(msg.contains("button-1"));
        assert!(msg.contains("not found"));
    }

    #[test]
    fn test_invalid_pin_error() {
        let err = RuntimeError::InvalidPin("Pin 13 is already in use".to_string());
        let msg = err.to_string();
        assert!(msg.contains("Pin 13 is already in use"));
    }

    #[test]
    fn test_hardware_error_port_open() {
        let err = HardwareError::PortOpen {
            port: "/dev/ttyUSB0".to_string(),
            reason: "Permission denied".to_string(),
        };
        let msg = err.to_string();
        assert!(msg.contains("/dev/ttyUSB0"));
        assert!(msg.contains("Permission denied"));
    }

    #[test]
    fn test_hardware_error_firmata_communication() {
        let err = HardwareError::FirmataCommunication("Timeout waiting for response".to_string());
        let msg = err.to_string();
        assert!(msg.contains("Timeout waiting for response"));
    }

    #[test]
    fn test_hardware_error_unsupported_pin_mode() {
        let err = HardwareError::UnsupportedPinMode { pin: 13, mode: 3 };
        let msg = err.to_string();
        assert!(msg.contains("13"));
        assert!(msg.contains('3'));
    }

    #[test]
    fn test_mqtt_error_not_connected() {
        let err = MqttError::NotConnected("mqtt://localhost:1883".to_string());
        let msg = err.to_string();
        assert!(msg.contains("mqtt://localhost:1883"));
        assert!(msg.contains("not connected"));
    }

    #[test]
    fn test_mqtt_error_connection_failed() {
        let err = MqttError::ConnectionFailed("Connection refused".to_string());
        let msg = err.to_string();
        assert!(msg.contains("Connection refused"));
    }

    #[test]
    fn test_mqtt_error_subscribe_failed() {
        let err = MqttError::SubscribeFailed {
            topic: "sensors/temperature".to_string(),
            reason: "Not authorized".to_string(),
        };
        let msg = err.to_string();
        assert!(msg.contains("sensors/temperature"));
        assert!(msg.contains("Not authorized"));
    }

    #[test]
    fn test_lock_poisoned_error() {
        let err = RuntimeError::LockPoisoned("flow_runtime".to_string());
        let msg = err.to_string();
        assert!(msg.contains("flow_runtime"));
        assert!(msg.contains("poisoned"));
    }

    #[test]
    fn test_hardware_error_converts_to_runtime_error() {
        let hw_err = HardwareError::PortOpen {
            port: "COM3".to_string(),
            reason: "Access denied".to_string(),
        };
        let runtime_err: RuntimeError = hw_err.into();
        let msg = runtime_err.to_string();
        assert!(msg.contains("COM3"));
        assert!(msg.contains("Access denied"));
    }

    #[test]
    fn test_mqtt_error_converts_to_runtime_error() {
        let mqtt_err = MqttError::ConnectionFailed("Timeout".to_string());
        let runtime_err: RuntimeError = mqtt_err.into();
        let msg = runtime_err.to_string();
        assert!(msg.contains("Timeout"));
    }

    #[test]
    fn test_to_frontend_message() {
        let err = RuntimeError::ComponentNotFound("led-2".to_string());
        let frontend_msg = err.to_frontend_message();
        assert!(frontend_msg.contains("led-2"));
    }

    #[test]
    fn test_runtime_error_to_string_conversion() {
        let err = RuntimeError::BoardNotConnected;
        let s: String = err.into();
        assert_eq!(s, "Board not connected");
    }
}
