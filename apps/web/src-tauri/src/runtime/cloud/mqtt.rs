//! MQTT cloud node on core's [`Component`] trait.
//!
//! - **Publish** (`direction = "publish"`): `dispatch("trigger")` spawns the
//!   async [`MqttPublisher::publish`] onto the captured Tokio handle and returns
//!   immediately — the sans-IO turn never blocks on the broker.
//! - **Subscribe** (`direction = "subscribe"`): describes its interest via
//!   [`subscriber_wiring`](Component::subscriber_wiring); the host routes broker
//!   payloads back via [`receive_raw_message`](Component::receive_raw_message),
//!   which emits on "value" downstream (matching the node's source handle).
//!
//! [`Component`]: microflow_core::runtime::Component

use crate::runtime::services::MqttPublisher;
use microflow_core::runtime::{
    Component, ComponentBase, ComponentValue, RuntimeContext, RuntimeError, SubscriberWiring,
};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
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
    /// Shared MQTT publish handle. Used only by `direction = "publish"` nodes.
    publisher: Arc<dyn MqttPublisher>,
    /// Tokio handle injected by the host so `dispatch` (sync) can spawn the
    /// async `publish` call. `None` disables publishing (logged).
    rt_handle: Option<tokio::runtime::Handle>,
}

impl Mqtt {
    #[must_use]
    pub fn new(
        id: String,
        config: MqttConfig,
        publisher: Arc<dyn MqttPublisher>,
        rt_handle: Option<tokio::runtime::Handle>,
    ) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::String(String::new())),
            config,
            publisher,
            rt_handle,
        }
    }

    /// Check if this is a publish node.
    #[must_use]
    pub fn is_publish(&self) -> bool {
        self.config.direction == "publish"
    }

    /// Render a [`ComponentValue`] into the byte payload an MQTT broker forwards.
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
    fn ports() -> &'static [&'static str] {
        &["trigger"]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Mqtt"
    }

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

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "trigger" => {
                if !self.is_publish() {
                    return Err(RuntimeError::ComponentError(
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
                    if let Err(e) = publisher.publish(&broker_id, &topic, &payload, retain).await {
                        log::error!(
                            "[MQTT] {component_id} publish failed (broker={broker_id} topic={topic}): {e}"
                        );
                    }
                });

                Ok(())
            }
            _ => Err(RuntimeError::ComponentError(format!(
                "Unknown method: {method}"
            ))),
        }
    }

    /// Subscribe-node delivery: the broker payload arrives here (topic ignored
    /// for `Plain` wiring). Parse it to the narrowest [`ComponentValue`] and emit
    /// on "value" (the subscribe node's source handle in the editor).
    fn receive_raw_message(&mut self, _topic: &str, payload: &[u8]) {
        let value = String::from_utf8_lossy(payload).to_string();

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
            .emit_with_value("value", Cow::Owned(component_value));
    }

    fn destroy(&mut self) {
        log::info!("[MQTT] Component {} destroyed", self.base.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::cloud::test_support::with_test_ctx;
    use crate::runtime::services::{RecordedPublish, RecordingMqttPublisher};
    use microflow_core::runtime::{ComponentEvent, EventSink};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;
    use std::time::Duration;

    fn sink() -> EventSink {
        Rc::new(RefCell::new(VecDeque::new()))
    }

    fn drain(sink: &EventSink) -> Vec<ComponentEvent> {
        sink.borrow_mut().drain(..).collect()
    }

    async fn wait_for_publishes(
        recorder: &RecordingMqttPublisher,
        min: usize,
        timeout: Duration,
    ) -> Vec<RecordedPublish> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let snap = recorder.recorded();
            if snap.len() >= min || tokio::time::Instant::now() >= deadline {
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
            Some(tokio::runtime::Handle::current()),
        );

        with_test_ctx("node-1", |ctx| {
            node.dispatch("trigger", ComponentValue::Number(42.0), ctx)
                .expect("dispatch ok");
        });

        let published = wait_for_publishes(&recorder, 1, Duration::from_secs(1)).await;
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].broker_id, "broker-1");
        assert_eq!(published[0].topic, "sensors/light");
        assert_eq!(published[0].payload, b"42");
        assert!(published[0].retain);
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
            Some(tokio::runtime::Handle::current()),
        );

        let err = with_test_ctx("node-1", |ctx| {
            node.dispatch("trigger", ComponentValue::Bool(true), ctx)
                .expect_err("subscribe should refuse trigger")
        });
        assert!(err.to_string().contains("subscribe"));
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(recorder.recorded().is_empty());
    }

    #[test]
    fn receive_raw_message_emits_parsed_message() {
        let mut node = Mqtt::new(
            "node-1".into(),
            MqttConfig {
                direction: "subscribe".into(),
                ..MqttConfig::default()
            },
            Arc::new(RecordingMqttPublisher::new()) as Arc<dyn MqttPublisher>,
            None,
        );
        let s = sink();
        node.set_sink(s.clone());

        node.receive_raw_message("sensors/light", b"42");

        let events = drain(&s);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].source_handle.as_ref(), "value");
        assert_eq!(events[0].value, ComponentValue::Number(42.0));
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
