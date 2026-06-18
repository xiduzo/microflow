//! Runtime Services — per-capability traits and registries for the desktop's
//! external (cloud) nodes.
//!
//! Each external kind gets a **Capability Trait** plus a **Service Registry**
//! (LLM) or a direct publisher handle (MQTT). The cloud nodes in
//! [`super::cloud`] hold the relevant `Arc` (captured by the actor's cloud
//! factories) and resolve the backing implementation at dispatch time, so
//! credential rotation and broker reconfiguration take effect without
//! rebuilding components.

pub mod llm;
pub mod mqtt;

pub use llm::{
    HttpLlmProvider, LlmError, LlmProvider, LlmRegistry, LlmRequest, LlmResponse,
    RecordingLlmProvider,
};
pub use mqtt::{MqttPublishError, MqttPublisher, RecordedPublish, RecordingMqttPublisher};
