//! Runtime Services — per-capability traits and registries for the desktop's
//! external (cloud) nodes.
//!
//! Since ADR-0021 that is MQTT alone: a direct publisher handle the cloud nodes
//! resolve at dispatch time, so broker reconfiguration takes effect without
//! rebuilding components. LLM generation left this layer entirely — the webview
//! performs it for both hosts and resolves providers from its own store.

pub mod mqtt;

pub use mqtt::{MqttPublishError, MqttPublisher, RecordedPublish, RecordingMqttPublisher};
