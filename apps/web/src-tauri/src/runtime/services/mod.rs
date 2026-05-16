//! Runtime Services — per-capability traits, registries, and the typed
//! bundle threaded through component construction.
//!
//! This module replaces the ad-hoc split between:
//!
//! - `RuntimeContext` + build-time provider snapshot (LLM),
//! - `_mqtt_publish` event-out + `lib.rs` interceptor (MQTT/Figma),
//!
//! with one shape: every external kind gets a **Capability Trait** plus a
//! **Service Registry** (LLM) or a direct publisher handle (MQTT).
//! Components hold the relevant `Arc` and resolve the backing
//! implementation at dispatch time, so credential rotation and broker
//! reconfiguration take effect without rebuilding components.
//!
//! [`RuntimeServices`] is the typed bundle handed to the component registry
//! per flow_update; each `ComponentBuilder` impl declares which slice of
//! it the component needs via its associated `Deps` type. The
//! [`FromServices`] trait does the projection.

use std::sync::Arc;

pub mod llm;
pub mod mqtt;

pub use llm::{
    HttpLlmProvider, LlmError, LlmProvider, LlmRegistry, LlmRequest, LlmResponse,
    RecordingLlmProvider,
};
pub use mqtt::{MqttPublishError, MqttPublisher, RecordedPublish, RecordingMqttPublisher};

// ---------------------------------------------------------------------------
// RuntimeServices
// ---------------------------------------------------------------------------

/// Typed bundle of every external service the runtime can hand to a
/// component. One field per **Capability Trait** / **Service Registry**.
///
/// `Arc` everywhere — handing a `RuntimeServices` to a factory and then
/// projecting a `Deps` slice out of it is a series of cheap clones.
///
/// Built once at application startup and reused across every flow update.
/// `Clone` so it can be carried alongside a pending `FlowUpdate` on
/// `AppState::pending_flow` and replayed on board-connect without losing
/// any of the live registries.
#[derive(Clone)]
pub struct RuntimeServices {
    /// Live registry of [`LlmProvider`] implementations keyed by id. See
    /// `CONTEXT.md` § LLM Provider, § Service Registry.
    pub llm_registry: Arc<LlmRegistry>,
    /// Production MQTT publisher (the application's `MqttManager`,
    /// adapted to [`MqttPublisher`]). See `CONTEXT.md` § MQTT Publisher.
    pub mqtt_publisher: Arc<dyn MqttPublisher>,
}

impl RuntimeServices {
    /// Build a services bundle around the given shared handles.
    #[must_use]
    pub fn new(
        llm_registry: Arc<LlmRegistry>,
        mqtt_publisher: Arc<dyn MqttPublisher>,
    ) -> Self {
        Self {
            llm_registry,
            mqtt_publisher,
        }
    }

    /// Build a services bundle with freshly-allocated, empty registries.
    /// Used in unit tests that don't exercise external dispatch paths;
    /// production call sites should clone shared handles from
    /// `AppState` via [`RuntimeServices::new`].
    #[must_use]
    pub fn empty() -> Self {
        Self {
            llm_registry: Arc::new(LlmRegistry::new()),
            mqtt_publisher: Arc::new(RecordingMqttPublisher::new()),
        }
    }
}

impl Default for RuntimeServices {
    fn default() -> Self {
        Self::empty()
    }
}

// ---------------------------------------------------------------------------
// FromServices
// ---------------------------------------------------------------------------

/// Project a typed slice out of [`RuntimeServices`].
///
/// Every concrete `Deps` shape a [`crate::runtime::component::ComponentBuilder`]
/// declares must implement this trait, so the component registry's factory
/// closure can pull out the right slice without naming the specific impl:
///
/// ```ignore
/// let deps = <B::Deps as FromServices>::from_services(services);
/// B::build(id, config, deps)
/// ```
///
/// Adding a new external kind = add a new field to [`RuntimeServices`] and
/// add a `FromServices` impl for whatever `Arc<dyn ..>` / registry handle
/// components reach for. Zero touches in the 29 builders that need
/// nothing — they keep their `type Deps = ()`.
pub trait FromServices {
    fn from_services(services: &RuntimeServices) -> Self;
}

/// Builders that need nothing from the services bundle declare
/// `type Deps = ()`. The impl is a `()` constructor.
impl FromServices for () {
    fn from_services(_: &RuntimeServices) -> Self {}
}

impl FromServices for Arc<LlmRegistry> {
    fn from_services(services: &RuntimeServices) -> Self {
        Arc::clone(&services.llm_registry)
    }
}

impl FromServices for Arc<dyn MqttPublisher> {
    fn from_services(services: &RuntimeServices) -> Self {
        Arc::clone(&services.mqtt_publisher)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_services_unit_returns_unit() {
        let services = RuntimeServices::empty();
        let () = <() as FromServices>::from_services(&services);
    }

    #[test]
    fn from_services_llm_registry_shares_arc() {
        let services = RuntimeServices::empty();
        let a = <Arc<LlmRegistry> as FromServices>::from_services(&services);
        let b = <Arc<LlmRegistry> as FromServices>::from_services(&services);
        assert!(Arc::ptr_eq(&a, &b));
        assert!(Arc::ptr_eq(&a, &services.llm_registry));
    }

    #[test]
    fn from_services_mqtt_publisher_shares_arc() {
        let services = RuntimeServices::empty();
        let a = <Arc<dyn MqttPublisher> as FromServices>::from_services(&services);
        assert!(Arc::ptr_eq(&a, &services.mqtt_publisher));
    }
}
