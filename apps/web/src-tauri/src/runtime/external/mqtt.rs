//! MQTT Component - External
//!
//! Publishes to MQTT brokers and surfaces incoming messages on subscribe nodes.
//!
//! # Architecture
//!
//! - **Subscribe nodes** — describe their interest via
//!   [`Component::subscriber_wiring`] and receive messages via
//!   [`Component::receive_raw_message`] / `receive_message`, routed by the
//!   runtime against the broker manager. Unchanged in ADR-0002 Phase 3.
//! - **Publish nodes** — on `dispatch("trigger")`, the component calls
//!   [`MqttPublisher::publish`] directly through its held `Arc<dyn ..>`
//!   handle. Replaces the legacy `_mqtt_publish` event-out pattern, which
//!   walked through `lib.rs`'s event-forwarding thread and a dedicated
//!   publish handler thread. See `docs/adr/0002-per-capability-service-traits.md`.

use crate::runtime::base::{Component, ComponentBase, ComponentValue};
use crate::runtime::services::MqttPublisher;
use crate::runtime::wiring::SubscriberWiring;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttConfig {
    #[serde(default)]
    pub broker_id: String,
    #[serde(default)]
    pub direction: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default = "default_qos")]
    pub qos: String,
    #[serde(default)]
    pub retain: bool,
}

fn default_qos() -> String {
    "1".to_string()
}

impl Default for MqttConfig {
    fn default() -> Self {
        Self {
            broker_id: String::new(),
            direction: "subscribe".to_string(),
            topic: String::new(),
            qos: "1".to_string(),
            retain: false,
        }
    }
}

pub struct Mqtt {
    base: ComponentBase,
    config: MqttConfig,
    /// Shared MQTT publish handle. Used only by `direction = "publish"`
    /// nodes; subscribe nodes ignore it.
    publisher: Arc<dyn MqttPublisher>,
    /// Tokio handle captured at construction so `dispatch` (sync) can
    /// spawn the async `publish` call.
    rt_handle: Option<tokio::runtime::Handle>,
}

impl Mqtt {
    #[must_use]
    pub fn new(id: String, config: MqttConfig, publisher: Arc<dyn MqttPublisher>) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::String(String::new())),
            config,
            publisher,
            rt_handle: tokio::runtime::Handle::try_current().ok(),
        }
    }

    /// Get the full config
    #[allow(dead_code)]
    #[must_use]
    pub fn config(&self) -> &MqttConfig {
        &self.config
    }

    /// Get the broker ID this component is configured for
    #[allow(dead_code)]
    #[must_use]
    pub fn broker_id(&self) -> &str {
        &self.config.broker_id
    }

    /// Get the topic this component subscribes to or publishes on
    #[allow(dead_code)]
    #[must_use]
    pub fn topic(&self) -> &str {
        &self.config.topic
    }

    /// Check if this is a subscribe node
    #[allow(dead_code)]
    #[must_use]
    pub fn is_subscribe(&self) -> bool {
        self.config.direction == "subscribe"
    }

    /// Check if this is a publish node
    #[must_use]
    pub fn is_publish(&self) -> bool {
        self.config.direction == "publish"
    }

    /// Get retain flag for publish
    #[allow(dead_code)]
    #[must_use]
    pub fn retain(&self) -> bool {
        self.config.retain
    }

    /// Called when a message is received from the broker (for subscribe nodes).
    /// Invoked by `executor::route_mqtt_message` once the broker delivers a
    /// payload on this component's subscribed topic.
    pub fn receive_message(&mut self, payload: &[u8]) {
        let value = String::from_utf8_lossy(payload).to_string();

        // Try to parse as number first, then bool, then keep as string
        let component_value = if let Ok(num) = value.parse::<f64>() {
            ComponentValue::Number(num)
        } else if value == "true" {
            ComponentValue::Bool(true)
        } else if value == "false" {
            ComponentValue::Bool(false)
        } else {
            ComponentValue::String(value)
        };

        self.base.value = component_value.clone();
        self.base
            .emit_with_value("message", std::borrow::Cow::Owned(component_value));
    }

    /// Render a [`ComponentValue`] into the byte payload an MQTT broker
    /// forwards. Centralised so `dispatch` is testable on its own.
    fn encode_payload(value: &ComponentValue) -> Vec<u8> {
        match value {
            ComponentValue::String(s) => s.clone().into_bytes(),
            ComponentValue::Number(n) => n.to_string().into_bytes(),
            ComponentValue::Bool(b) => b.to_string().into_bytes(),
            _ => Vec::new(),
        }
    }
}

impl Component for Mqtt {
    fn ports() -> &'static [&'static str] { &["trigger"] }

    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Mqtt" }

    fn subscriber_wiring(&self) -> Vec<SubscriberWiring> {
        if self.config.direction != "subscribe"
            || self.config.broker_id.is_empty()
            || self.config.topic.is_empty()
        {
            return Vec::new();
        }
        vec![SubscriberWiring::Plain {
            broker_id: self.config.broker_id.clone(),
            topic: self.config.topic.clone(),
        }]
    }

    fn dispatch(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "trigger" => {
                if !self.is_publish() {
                    return Err(crate::error::RuntimeError::ComponentError(
                        "This MQTT node is configured for subscribe, not publish".to_string(),
                    ));
                }

                self.base.value = args.clone();

                let payload = Self::encode_payload(&args);
                let publisher = Arc::clone(&self.publisher);
                let broker_id = self.config.broker_id.clone();
                let topic = self.config.topic.clone();
                let retain = self.config.retain;
                let component_id = Arc::clone(&self.base.id);

                let Some(handle) = &self.rt_handle else {
                    log::error!(
                        "[MQTT] {component_id} no Tokio runtime available, cannot spawn publish"
                    );
                    return Ok(());
                };

                handle.spawn(async move {
                    log::info!(
                        "[MQTT] {component_id} publish → broker={broker_id} topic={topic} retain={retain}"
                    );
                    if let Err(e) = publisher
                        .publish(&broker_id, &topic, &payload, retain)
                        .await
                    {
                        log::error!(
                            "[MQTT] {component_id} publish failed (broker={broker_id} topic={topic}): {e}"
                        );
                    }
                });

                Ok(())
            }
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) {
        log::info!("[MQTT] Component {} destroyed", self.base.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::services::RecordingMqttPublisher;
    use std::time::Duration;

    /// Spin until the recorder sees a publish call or the deadline passes.
    async fn wait_for_publishes(
        recorder: &RecordingMqttPublisher,
        min: usize,
        timeout: Duration,
    ) -> Vec<crate::runtime::services::RecordedPublish> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let snap = recorder.recorded();
            if snap.len() >= min {
                return snap;
            }
            if tokio::time::Instant::now() >= deadline {
                return snap;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn publish_node_dispatches_to_publisher() {
        let recorder = Arc::new(RecordingMqttPublisher::new());
        let config = MqttConfig {
            direction: "publish".into(),
            broker_id: "broker-1".into(),
            topic: "sensors/light".into(),
            retain: true,
            ..MqttConfig::default()
        };

        let mut node = Mqtt::new(
            "node-1".into(),
            config,
            recorder.clone() as Arc<dyn MqttPublisher>,
        );

        node.dispatch("trigger", ComponentValue::Number(42.0))
            .expect("dispatch ok");

        let recorded = wait_for_publishes(&recorder, 1, Duration::from_secs(1)).await;
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].broker_id, "broker-1");
        assert_eq!(recorded[0].topic, "sensors/light");
        assert_eq!(recorded[0].payload, b"42");
        assert!(recorded[0].retain);
    }

    #[tokio::test]
    async fn subscribe_node_rejects_trigger_without_publishing() {
        let recorder = Arc::new(RecordingMqttPublisher::new());
        let config = MqttConfig {
            direction: "subscribe".into(),
            broker_id: "broker-1".into(),
            topic: "sensors/light".into(),
            ..MqttConfig::default()
        };

        let mut node = Mqtt::new(
            "node-1".into(),
            config,
            recorder.clone() as Arc<dyn MqttPublisher>,
        );

        let err = node
            .dispatch("trigger", ComponentValue::Bool(true))
            .expect_err("subscribe should refuse trigger");
        assert!(err.to_string().contains("subscribe"));
        // Give a tick to make sure no rogue spawn snuck a publish through.
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(recorder.recorded().is_empty());
    }

    #[test]
    fn encode_payload_covers_known_value_kinds() {
        assert_eq!(Mqtt::encode_payload(&ComponentValue::Bool(true)), b"true");
        assert_eq!(Mqtt::encode_payload(&ComponentValue::Number(1.5)), b"1.5");
        assert_eq!(
            Mqtt::encode_payload(&ComponentValue::String("hi".into())),
            b"hi"
        );
        assert!(Mqtt::encode_payload(&ComponentValue::Array(vec![])).is_empty());
    }
}
