//! Figma cloud node on core's [`Component`] trait — a design-tool bridge.
//!
//! Bridges a design-tool variable (a Figma variable or a Penpot token, per
//! `source`) into the flow via MQTT: subscribes to the plugin's value topics
//! (delivered back via [`receive_raw_message`](Component::receive_raw_message))
//! and, on `dispatch`, computes the new value, emits "value"/"change" downstream,
//! and records a [`CloudRequestKind::MqttPublish`] to the plugin for the host to
//! perform (sans-IO — the node never touches the broker, ADR-0009). Topics and
//! value coercion come from [`crate::design_bridge`], shared with the plugins.
//!
//! [`Component`]: crate::runtime::Component

use crate::runtime::{
    CloudRequestKind, Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext,
    RuntimeError, SubscriberWiring,
};
use std::borrow::Cow;

use super::config::FigmaConfig;
use crate::design_bridge::{self as protocol, BridgeValue, DESIGN_TOOLS, STUDIO};

pub(crate) struct Figma {
    base: ComponentBase,
    config: FigmaConfig,
}

impl Figma {
    const E_CHANGE: &'static str = "change";

    #[must_use]
    pub(crate) fn new(id: String, config: FigmaConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::String(String::new())),
            config,
        }
    }

    /// The design tool this node bridges to; unknown values fall back to Figma.
    fn tool(&self) -> &str {
        DESIGN_TOOLS
            .iter()
            .find(|tool| **tool == self.config.source)
            .unwrap_or(&DESIGN_TOOLS[0])
    }

    fn wire_id(&self) -> String {
        protocol::wire_id(&self.config.variable_id)
    }

    /// Coerce a value to this node's variable type. `None` when it does not fit.
    fn coerce(&self, value: &serde_json::Value) -> Option<BridgeValue> {
        protocol::coerce(&self.config.resolved_type, value)
    }

    /// Record a publish of `value` to the plugin over the configured broker
    /// (sans-IO — the host's `perform_cloud` performs it).
    fn publish(&self, value: &BridgeValue, ctx: &mut RuntimeContext) {
        ctx.request_cloud(CloudRequestKind::MqttPublish {
            broker_id: self.config.broker_id.clone(),
            topic: protocol::set_topic(&self.config.unique_id, &self.wire_id()),
            payload: protocol::encode(value).into_bytes(),
            retain: false,
        });
    }

    /// Emit a value on both "value" (node display) and "change" (downstream).
    fn emit_value(&mut self, value: ComponentValue) {
        self.base.value = value.clone();
        self.base.emit_with_value(ComponentBase::VALUE_HANDLE, Cow::Owned(value.clone()));
        self.base.emit_with_value(Self::E_CHANGE, Cow::Owned(value));
    }

    /// The current value as a wire color, or opaque black.
    fn current_color(&self) -> (f64, f64, f64, f64) {
        match self.base.value {
            ComponentValue::Rgba { r, g, b, a } => (
                f64::from(r) / 255.0,
                f64::from(g) / 255.0,
                f64::from(b) / 255.0,
                a,
            ),
            _ => (0.0, 0.0, 0.0, 1.0),
        }
    }
}

fn to_component_value(value: &BridgeValue) -> ComponentValue {
    // Channels are clamped to 0–1, so the u8 conversion cannot truncate.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let byte = |c: f64| (c * 255.0).round() as u8;
    match value {
        BridgeValue::Bool(b) => ComponentValue::Bool(*b),
        BridgeValue::Number(n) => ComponentValue::Number(*n),
        BridgeValue::Text(s) => ComponentValue::String(s.clone()),
        BridgeValue::Color { r, g, b, a } => ComponentValue::Rgba {
            r: byte(*r),
            g: byte(*g),
            b: byte(*b),
            a: *a,
        },
    }
}

fn to_json(value: &ComponentValue) -> serde_json::Value {
    match value {
        ComponentValue::Bool(b) => serde_json::Value::Bool(*b),
        ComponentValue::Number(n) => serde_json::json!(n),
        ComponentValue::String(s) => serde_json::Value::String(s.clone()),
        ComponentValue::Rgba { r, g, b, a } => serde_json::json!({
            "r": f64::from(*r) / 255.0,
            "g": f64::from(*g) / 255.0,
            "b": f64::from(*b) / 255.0,
            "a": a,
        }),
        ComponentValue::Array(_) => serde_json::Value::Null,
    }
}

impl ComponentBuilder for Figma {
    type Config = FigmaConfig;

    fn build(id: String, config: FigmaConfig) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl Component for Figma {
    fn ports() -> &'static [&'static str] {
        &[
            "true", "false", "toggle", "set", "increment", "decrement", "reset", "red", "green",
            "blue", "opacity",
        ]
    }

    fn emits() -> &'static [&'static str] {
        &[Self::E_CHANGE, ComponentBase::VALUE_HANDLE]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Figma"
    }

    fn subscriber_wiring(&self) -> Vec<SubscriberWiring> {
        let broker = &self.config.broker_id;
        let uid = &self.config.unique_id;
        if broker.is_empty() || uid.is_empty() {
            return Vec::new();
        }

        // Every tool's retained list and status, so the variable picker can
        // fill before a variable is chosen (runtime dedupes by broker + topic).
        let mut wiring: Vec<SubscriberWiring> = DESIGN_TOOLS
            .iter()
            .flat_map(|tool| {
                [
                    protocol::variables_topic(uid, tool),
                    protocol::status_topic(uid, tool),
                ]
            })
            .map(|topic| SubscriberWiring::DisplayEcho { broker_id: broker.clone(), topic })
            .collect();

        if !self.config.variable_id.is_empty() {
            let wire_id = self.wire_id();
            // The plugin's own value topic, and its reply to Studio's request.
            for client in [self.tool(), STUDIO] {
                wiring.push(SubscriberWiring::TopicAware {
                    broker_id: broker.clone(),
                    topic: protocol::value_topic(uid, client, &wire_id),
                });
            }
        }
        wiring
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        let value = match method {
            // ---- BOOLEAN ----
            "true" => BridgeValue::Bool(true),
            "false" => BridgeValue::Bool(false),
            "toggle" => BridgeValue::Bool(!matches!(self.base.value, ComponentValue::Bool(true))),

            // ---- any type ----
            "set" => {
                let Some(value) = self.coerce(&to_json(&args)) else {
                    log::warn!(
                        "[Figma] {}: {args:?} does not fit a {} variable",
                        self.base.id,
                        self.config.resolved_type
                    );
                    return Ok(());
                };
                value
            }

            // ---- FLOAT ----
            "increment" | "decrement" => {
                let current = self.base.value.as_number().unwrap_or(0.0);
                let delta = args.as_number().unwrap_or(1.0);
                BridgeValue::Number(if method == "increment" {
                    current + delta
                } else {
                    current - delta
                })
            }
            "reset" => BridgeValue::Number(0.0),

            // ---- COLOR channels (0–255, opacity 0–100) ----
            "red" | "green" | "blue" | "opacity" => {
                let channel_value = args.as_number().unwrap_or(0.0);
                let (mut r, mut g, mut b, mut a) = self.current_color();
                match method {
                    "red" => r = (channel_value / 255.0).clamp(0.0, 1.0),
                    "green" => g = (channel_value / 255.0).clamp(0.0, 1.0),
                    "blue" => b = (channel_value / 255.0).clamp(0.0, 1.0),
                    _ => a = (channel_value / 100.0).clamp(0.0, 1.0),
                }
                BridgeValue::Color { r, g, b, a }
            }

            _ => {
                return Err(RuntimeError::ComponentError(format!(
                    "Unknown method: {method}"
                )))
            }
        };

        // Update local state optimistically so subsequent calls (e.g. repeated
        // toggle) see the correct current value without waiting for the roundtrip.
        self.emit_value(to_component_value(&value));
        self.publish(&value, ctx);
        Ok(())
    }

    fn receive_raw_message(&mut self, _topic: &str, payload: &[u8]) {
        let decoded = protocol::decode_payload(&String::from_utf8_lossy(payload));
        match self.coerce(&decoded) {
            Some(value) => self.emit_value(to_component_value(&value)),
            None => log::warn!(
                "[Figma] {}: ignored a value that does not fit a {} variable",
                self.base.id,
                self.config.resolved_type
            ),
        }
    }

    fn destroy(&mut self) {
        log::info!("[Figma] Component {} destroyed", self.base.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::cloud::test_support::recorded_cloud_requests;

    fn config() -> FigmaConfig {
        FigmaConfig {
            broker_id: "broker-1".into(),
            unique_id: "uid-1".into(),
            variable_id: "VariableID:1:2".into(),
            resolved_type: "BOOLEAN".into(),
            ..FigmaConfig::default()
        }
    }

    /// Unwrap the single recorded request as an MQTT publish, or panic.
    fn publish_of(kind: CloudRequestKind) -> (String, String, Vec<u8>, bool) {
        match kind {
            CloudRequestKind::MqttPublish { broker_id, topic, payload, retain } => {
                (broker_id, topic, payload, retain)
            }
            other @ (CloudRequestKind::LlmGenerate { .. }
            | CloudRequestKind::MidiSend { .. }
            | CloudRequestKind::AudioPlay { .. }
            | CloudRequestKind::AudioStop) => {
                panic!("expected MqttPublish, got {other:?}")
            }
        }
    }

    #[test]
    fn dispatch_true_records_true_publish_to_set_topic() {
        let mut figma = Figma::new("node-1".into(), config());

        let mut reqs = recorded_cloud_requests("node-1", |ctx| {
            figma
                .dispatch("true", ComponentValue::Bool(true), ctx)
                .expect("dispatch ok");
        });

        assert_eq!(reqs.len(), 1);
        let (broker_id, topic, payload, retain) = publish_of(reqs.remove(0));
        assert_eq!(broker_id, "broker-1");
        assert_eq!(topic, "microflow/uid-1/app/variable/1-2/set");
        assert_eq!(payload, b"true");
        assert!(!retain);
    }

    #[test]
    fn dispatch_increment_records_summed_payload() {
        let mut c = config();
        c.resolved_type = "FLOAT".into();
        let mut figma = Figma::new("node-1".into(), c);

        let mut first = recorded_cloud_requests("node-1", |ctx| {
            figma
                .dispatch("set", ComponentValue::Number(5.0), ctx)
                .expect("set ok");
        });
        assert_eq!(first.len(), 1);
        let _ = publish_of(first.remove(0));

        let mut second = recorded_cloud_requests("node-1", |ctx| {
            figma
                .dispatch("increment", ComponentValue::Number(3.0), ctx)
                .expect("increment ok");
        });
        assert_eq!(second.len(), 1);
        let (_, _, payload, _) = publish_of(second.remove(0));
        assert_eq!(payload, b"8");
    }

    #[test]
    fn dispatch_unknown_method_records_no_request() {
        let mut figma = Figma::new("node-1".into(), config());

        let mut errored = false;
        let reqs = recorded_cloud_requests("node-1", |ctx| {
            errored = figma
                .dispatch("definitely-not-a-method", ComponentValue::Bool(true), ctx)
                .is_err();
        });

        assert!(errored, "unknown method should error");
        assert!(reqs.is_empty(), "a failed dispatch must record no cloud request");
    }

    fn topics_of(wiring: &[SubscriberWiring]) -> Vec<(&'static str, String)> {
        wiring
            .iter()
            .map(|w| match w {
                SubscriberWiring::TopicAware { topic, .. } => ("routed", topic.clone()),
                SubscriberWiring::DisplayEcho { topic, .. } => ("display", topic.clone()),
                SubscriberWiring::Plain { topic, .. } => ("plain", topic.clone()),
            })
            .collect()
    }

    #[test]
    fn lists_every_tool_before_a_variable_is_chosen() {
        let mut c = config();
        c.variable_id = String::new();
        let figma = Figma::new("node-1".into(), c);
        assert_eq!(
            topics_of(&figma.subscriber_wiring()),
            vec![
                ("display", "microflow/uid-1/figma/variables".to_string()),
                ("display", "microflow/uid-1/figma/status".to_string()),
                ("display", "microflow/uid-1/penpot/variables".to_string()),
                ("display", "microflow/uid-1/penpot/status".to_string()),
            ]
        );
    }

    #[test]
    fn routes_the_source_tool_value_topics() {
        let mut c = config();
        c.source = "penpot".into();
        c.variable_id = "3f9a2b1c-8d4e".into();
        let figma = Figma::new("node-1".into(), c);
        let routed: Vec<String> = topics_of(&figma.subscriber_wiring())
            .into_iter()
            .filter(|(kind, _)| *kind == "routed")
            .map(|(_, topic)| topic)
            .collect();
        assert_eq!(
            routed,
            vec![
                "microflow/uid-1/penpot/variable/3f9a2b1c-8d4e".to_string(),
                "microflow/uid-1/app/variable/3f9a2b1c-8d4e".to_string(),
            ]
        );
    }

    #[test]
    fn no_wiring_without_broker_or_uid() {
        let mut c = config();
        c.unique_id = String::new();
        assert!(Figma::new("node-1".into(), c).subscriber_wiring().is_empty());
    }

    #[test]
    fn set_coerces_to_the_variable_type() {
        let mut c = config();
        c.resolved_type = "FLOAT".into();
        let mut figma = Figma::new("node-1".into(), c);
        let mut reqs = recorded_cloud_requests("node-1", |ctx| {
            figma
                .dispatch("set", ComponentValue::String("5".into()), ctx)
                .expect("set ok");
        });
        let (_, _, payload, _) = publish_of(reqs.remove(0));
        assert_eq!(payload, b"5");
        assert_eq!(figma.base.value, ComponentValue::Number(5.0));
    }

    #[test]
    fn set_that_does_not_fit_publishes_nothing() {
        let mut c = config();
        c.resolved_type = "FLOAT".into();
        let mut figma = Figma::new("node-1".into(), c);
        let reqs = recorded_cloud_requests("node-1", |ctx| {
            figma
                .dispatch("set", ComponentValue::String("abc".into()), ctx)
                .expect("set ok");
        });
        assert!(reqs.is_empty());
    }

    #[test]
    fn color_channel_publishes_a_unit_range_color() {
        let mut c = config();
        c.resolved_type = "COLOR".into();
        let mut figma = Figma::new("node-1".into(), c);
        let mut reqs = recorded_cloud_requests("node-1", |ctx| {
            figma
                .dispatch("red", ComponentValue::Number(255.0), ctx)
                .expect("red ok");
        });
        let (_, _, payload, _) = publish_of(reqs.remove(0));
        let json: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(json["r"].as_f64(), Some(1.0));
        assert_eq!(json["a"].as_f64(), Some(1.0));
        assert_eq!(figma.base.value, ComponentValue::Rgba { r: 255, g: 0, b: 0, a: 1.0 });
    }

    #[test]
    fn receives_a_color_as_rgba() {
        let mut c = config();
        c.resolved_type = "COLOR".into();
        let mut figma = Figma::new("node-1".into(), c);
        figma.receive_raw_message("t", br#"{"r":1,"g":0.5,"b":0,"a":0.25}"#);
        assert_eq!(figma.base.value, ComponentValue::Rgba { r: 255, g: 128, b: 0, a: 0.25 });
    }

    #[test]
    fn ignores_a_received_value_that_does_not_fit() {
        let mut c = config();
        c.resolved_type = "FLOAT".into();
        let mut figma = Figma::new("node-1".into(), c);
        figma.receive_raw_message("t", b"7");
        figma.receive_raw_message("t", b"not a number");
        assert_eq!(figma.base.value, ComponentValue::Number(7.0));
    }
}
