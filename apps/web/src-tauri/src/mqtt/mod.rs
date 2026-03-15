//! MQTT Module
//!
//! Provides MQTT broker connection management for `IoT` connectivity.
//! Supports multiple broker configurations with connection pooling.

pub mod broker;
pub mod commands;
pub mod manager;

pub use manager::MqttManager;
