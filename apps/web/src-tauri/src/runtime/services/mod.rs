//! Runtime Services — per-capability traits for the desktop's external (cloud)
//! nodes.
//!
//! Since ADR-0021 that is MQTT alone: the broker pool the `CloudPerformer`
//! publishes and subscribes through, resolved by broker id at call time, so
//! broker reconfiguration takes effect without rebuilding components. LLM
//! generation left this layer entirely — the webview performs it for both hosts
//! and resolves providers from its own store.

pub mod mqtt;

pub use mqtt::{
    BrokerCall, BrokerOp, BrokerSession, LastWord, MqttBrokers, MqttError, RecordedPublish, RecordingMqttBrokers,
};
