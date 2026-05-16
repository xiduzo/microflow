//! Runtime Services — per-capability traits and registries for external resources.
//!
//! This module replaces the ad-hoc split between:
//!
//! - `RuntimeContext` + build-time provider snapshot (LLM),
//! - `_mqtt_publish` event-out + lib.rs interceptor (MQTT/Figma),
//!
//! with one shape: every external kind gets a **Capability Trait** plus a
//! **Service Registry**. Components hold `Arc<Registry>` and resolve the
//! backing implementation at dispatch time, so credential rotation and
//! broker reconfiguration take effect without rebuilding components.
//!
//! Pairing each trait with a recording test impl (e.g.
//! [`llm::RecordingLlmProvider`]) makes the trait a **real seam** — the
//! second adapter is what turns a hypothetical seam into a real one
//! (see `CONTEXT.md` § Capability Trait, § LLM Provider).
//!
//! Rollout follows `docs/adr/0002-per-capability-service-traits.md`:
//!
//! - Phase 1 (this commit): [`llm`] module — trait, HTTP impl, recording
//!   impl, registry. No migration of the `Llm` component yet.
//! - Phase 2: `Llm` component holds `Arc<LlmRegistry>` and dispatches via
//!   the trait.
//! - Phase 3: same shape for MQTT.
//! - Phase 4: `RuntimeServices` bundle + `ComponentBuilder::Deps`.

pub mod llm;
pub mod mqtt;

pub use llm::{
    HttpLlmProvider, LlmError, LlmProvider, LlmRegistry, LlmRequest, LlmResponse,
    RecordingLlmProvider,
};
pub use mqtt::{MqttPublishError, MqttPublisher, RecordedPublish, RecordingMqttPublisher};
