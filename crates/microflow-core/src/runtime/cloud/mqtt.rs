//! MQTT cloud node on core's [`Component`] trait.
//!
//! - **Publish** (`direction = "publish"`): `dispatch("trigger")` records a
//!   [`CloudRequestKind::MqttPublish`] for the host's `EffectsSink::perform_cloud`
//!   to perform — the sans-IO turn never touches the broker (ADR-0009).
//! - **Subscribe** (`direction = "subscribe"`): describes its interest via
//!   [`subscriber_wiring`](Component::subscriber_wiring); the host routes broker
//!   payloads back via [`receive_raw_message`](Component::receive_raw_message),
//!   which emits on "value" downstream (matching the node's source handle).
//!
//! [`Component`]: crate::runtime::Component

use crate::runtime::{
    CloudRequestKind, Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext,
    RuntimeError, SubscriberWiring,
};
use std::borrow::Cow;

pub use crate::config::mqtt::MqttConfig;

pub struct Mqtt {
    base: ComponentBase,
    config: MqttConfig,
}

impl Mqtt {
    #[must_use]
    pub fn new(id: String, config: MqttConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::String(String::new())),
            config,
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

impl ComponentBuilder for Mqtt {
    type Config = MqttConfig;

    fn build(id: String, config: MqttConfig) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl Component for Mqtt {
    fn ports() -> &'static [&'static str] {
        &["trigger"]
    }

    fn emits() -> &'static [&'static str] {
        // Subscribe-side delivery emits the parsed payload on "value".
        &[ComponentBase::VALUE_HANDLE]
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
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "trigger" => {
                if !self.is_publish() {
                    return Err(RuntimeError::ComponentError(
                        "This MQTT node is configured for subscribe, not publish".to_string(),
                    ));
                }

                self.base.value = args.clone();

                // Sans-IO: record the publish for the host to perform; the node
                // never spawns or touches the broker (ADR-0009).
                ctx.request_cloud(CloudRequestKind::MqttPublish {
                    broker_id: self.config.broker_id.clone(),
                    topic: self.config.topic.clone(),
                    payload: Self::encode_payload(&args),
                    retain: self.config.retain,
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
            .emit_with_value(ComponentBase::VALUE_HANDLE, Cow::Owned(component_value));
    }

    fn destroy(&mut self) {
        log::info!("[MQTT] Component {} destroyed", self.base.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::cloud::test_support::{recorded_cloud_requests, with_test_ctx};
    use crate::runtime::{ComponentEvent, EventSink};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;

    fn sink() -> EventSink {
        Rc::new(RefCell::new(VecDeque::new()))
    }

    fn drain(sink: &EventSink) -> Vec<ComponentEvent> {
        sink.borrow_mut().drain(..).collect()
    }

    #[test]
    fn publish_node_records_publish_request() {
        let config = MqttConfig {
            direction: "publish".into(),
            broker_id: "broker-1".into(),
            topic: "sensors/light".into(),
            retain: true,
            ..MqttConfig::default()
        };
        let mut node = Mqtt::new("node-1".into(), config);

        let mut reqs = recorded_cloud_requests("node-1", |ctx| {
            node.dispatch("trigger", ComponentValue::Number(42.0), ctx)
                .expect("dispatch ok");
        });

        assert_eq!(reqs.len(), 1);
        match reqs.remove(0) {
            CloudRequestKind::MqttPublish { broker_id, topic, payload, retain } => {
                assert_eq!(broker_id, "broker-1");
                assert_eq!(topic, "sensors/light");
                assert_eq!(payload, b"42");
                assert!(retain);
            }
            other @ CloudRequestKind::LlmGenerate { .. } => panic!("expected MqttPublish, got {other:?}"),
        }
    }

    #[test]
    fn subscribe_node_rejects_trigger() {
        let config = MqttConfig {
            direction: "subscribe".into(),
            broker_id: "broker-1".into(),
            topic: "sensors/light".into(),
            ..MqttConfig::default()
        };
        let mut node = Mqtt::new("node-1".into(), config);

        let err = with_test_ctx("node-1", |ctx| {
            node.dispatch("trigger", ComponentValue::Bool(true), ctx)
                .expect_err("subscribe should refuse trigger")
        });
        assert!(err.to_string().contains("subscribe"));
    }

    #[test]
    fn subscribe_node_records_no_request() {
        let config = MqttConfig {
            direction: "subscribe".into(),
            ..MqttConfig::default()
        };
        let mut node = Mqtt::new("node-1".into(), config);

        let reqs = recorded_cloud_requests("node-1", |ctx| {
            let _ = node.dispatch("trigger", ComponentValue::Bool(true), ctx);
        });
        assert!(reqs.is_empty(), "a rejected subscribe trigger must record no cloud request");
    }

    #[test]
    fn receive_raw_message_emits_parsed_message() {
        let mut node = Mqtt::new(
            "node-1".into(),
            MqttConfig {
                direction: "subscribe".into(),
                ..MqttConfig::default()
            },
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
