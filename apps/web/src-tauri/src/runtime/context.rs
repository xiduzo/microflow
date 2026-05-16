//! Read-only bundle passed to component factories at construction time.
//!
//! Hands a component the registries / typed services it needs to talk to
//! the outside world. Today the bundle carries an [`LlmRegistry`]; in
//! Phase 4 of ADR-0002 this whole struct is replaced by a typed
//! `RuntimeServices` and per-impl `ComponentBuilder::Deps`.
//!
//! See `CONTEXT.md` § Runtime Context (deprecation note) and
//! `docs/adr/0002-per-capability-service-traits.md`.

use std::sync::Arc;

use super::services::{LlmRegistry, MqttPublisher, RecordingMqttPublisher};

/// Construction-time bundle. Holds shared service handles via `Arc` so
/// live config rotation is visible to every component that already holds
/// a handle. Each external **Capability Trait** gets one field.
#[derive(Clone)]
pub struct RuntimeContext {
    /// Shared LLM provider registry. `Llm` resolves its `provider_id`
    /// against this at dispatch time — credential rotation takes effect
    /// on the next request without rebuilding the component.
    pub llm_registry: Arc<LlmRegistry>,
    /// Shared MQTT publish handle. `Mqtt` and `Figma` call
    /// [`MqttPublisher::publish`] directly from their `dispatch` arms,
    /// replacing the legacy `_mqtt_publish` event-out pattern (ADR-0002
    /// Phase 3).
    pub mqtt_publisher: Arc<dyn MqttPublisher>,
}

impl RuntimeContext {
    /// Build a context wrapping freshly-allocated, empty services. Used in
    /// unit tests that don't exercise the external dispatch paths; most
    /// production call sites should clone shared handles from `AppState`
    /// via [`RuntimeContext::with_services`].
    #[must_use]
    pub fn empty() -> Self {
        Self {
            llm_registry: Arc::new(LlmRegistry::new()),
            mqtt_publisher: Arc::new(RecordingMqttPublisher::new()),
        }
    }

    /// Build a context around shared service handles.
    #[must_use]
    pub fn with_services(
        llm_registry: Arc<LlmRegistry>,
        mqtt_publisher: Arc<dyn MqttPublisher>,
    ) -> Self {
        Self {
            llm_registry,
            mqtt_publisher,
        }
    }
}

impl Default for RuntimeContext {
    fn default() -> Self {
        Self::empty()
    }
}
