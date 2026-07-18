//! Figma cloud node on core's [`Component`] trait.
//!
//! Bridges Figma design variables into the flow via MQTT: subscribes to the
//! plugin's variable topics (delivered back via
//! [`receive_raw_message`](Component::receive_raw_message)) and, on `dispatch`,
//! computes a payload, emits "value"/"change" downstream, and records a
//! [`CloudRequestKind::MqttPublish`] back to Figma for the host to perform
//! (sans-IO — the node never touches the broker, ADR-0009).
//!
//! [`Component`]: crate::runtime::Component

use crate::runtime::{
    CloudRequestKind, Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext,
    RuntimeError, SubscriberWiring,
};
use std::borrow::Cow;

pub use crate::config::figma::FigmaConfig;

pub struct Figma {
    base: ComponentBase,
    config: FigmaConfig,
}

impl Figma {
    const E_CHANGE: &'static str = "change";

    #[must_use]
    pub fn new(id: String, config: FigmaConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::String(String::new())),
            config,
        }
    }

    /// Convert `VariableID:123:456` → `123-456`.
    fn short_var_id(&self) -> String {
        self.config
            .variable_id
            .replace("VariableID:", "")
            .replace(':', "-")
    }

    /// Topic the Figma plugin publishes variable values to.
    fn plugin_variable_topic(&self) -> String {
        format!(
            "microflow/{}/figma/variable/{}",
            self.config.unique_id,
            self.short_var_id()
        )
    }

    /// Topic the plugin responds to after a variables/request.
    fn app_variable_topic(&self) -> String {
        format!(
            "microflow/{}/app/variable/{}",
            self.config.unique_id,
            self.short_var_id()
        )
    }

    /// Topic used to push a new value back into Figma.
    fn set_topic(&self) -> String {
        format!(
            "microflow/{}/app/variable/{}/set",
            self.config.unique_id,
            self.short_var_id()
        )
    }

    /// Parse a raw MQTT payload into a `ComponentValue` based on `resolved_type`.
    fn parse_payload(&self, payload: &[u8]) -> ComponentValue {
        let raw = String::from_utf8_lossy(payload).to_string();

        match self.config.resolved_type.as_str() {
            "BOOLEAN" => {
                if raw == "true" {
                    ComponentValue::Bool(true)
                } else if raw == "false" {
                    ComponentValue::Bool(false)
                } else if let Ok(v) = serde_json::from_str::<bool>(&raw) {
                    ComponentValue::Bool(v)
                } else {
                    ComponentValue::Bool(false)
                }
            }
            "FLOAT" => {
                if let Ok(n) = raw.parse::<f64>() {
                    ComponentValue::Number(n)
                } else if let Ok(serde_json::Value::Number(n)) =
                    serde_json::from_str::<serde_json::Value>(&raw)
                {
                    ComponentValue::Number(n.as_f64().unwrap_or(0.0))
                } else {
                    ComponentValue::Number(0.0)
                }
            }
            "COLOR" => {
                // Figma COLOR is {r, g, b, a} with r/g/b in 0-1 range.
                if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&raw) {
                    let r = obj.get("r").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
                    let g = obj.get("g").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
                    let b = obj.get("b").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
                    let a = obj.get("a").and_then(serde_json::Value::as_f64).unwrap_or(1.0);
                    ComponentValue::Rgba {
                        r: (r * 255.0).round() as u8,
                        g: (g * 255.0).round() as u8,
                        b: (b * 255.0).round() as u8,
                        a,
                    }
                } else {
                    ComponentValue::Rgba { r: 0, g: 0, b: 0, a: 1.0 }
                }
            }
            _ => {
                // STRING — strip surrounding quotes if the plugin JSON-encoded it.
                if let Ok(serde_json::Value::String(s)) =
                    serde_json::from_str::<serde_json::Value>(&raw)
                {
                    ComponentValue::String(s)
                } else {
                    ComponentValue::String(raw)
                }
            }
        }
    }

    /// Serialise a `ComponentValue` back to the JSON string the Figma plugin expects.
    fn serialize_value(value: &ComponentValue) -> String {
        match value {
            ComponentValue::Bool(b) => b.to_string(),
            ComponentValue::Number(n) => n.to_string(),
            ComponentValue::String(s) => {
                serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
            }
            ComponentValue::Rgba { r, g, b, a } => serde_json::json!({
                "r": f64::from(*r) / 255.0,
                "g": f64::from(*g) / 255.0,
                "b": f64::from(*b) / 255.0,
                "a": a,
            })
            .to_string(),
            ComponentValue::Array(_) => String::new(),
        }
    }

    /// Record a publish of `payload` back into Figma over the configured broker
    /// (sans-IO — the host's `perform_cloud` performs it).
    fn publish(&self, payload: String, ctx: &mut RuntimeContext) {
        ctx.request_cloud(CloudRequestKind::MqttPublish {
            broker_id: self.config.broker_id.clone(),
            topic: self.set_topic(),
            payload: payload.into_bytes(),
            retain: false,
        });
    }

    /// Emit a value on both "value" (node display) and "change" (downstream).
    fn emit_value(&mut self, value: ComponentValue) {
        self.base.value = value.clone();
        self.base.emit_with_value(ComponentBase::VALUE_HANDLE, Cow::Owned(value.clone()));
        self.base.emit_with_value(Self::E_CHANGE, Cow::Owned(value));
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
        if self.config.broker_id.is_empty()
            || self.config.unique_id.is_empty()
            || self.config.variable_id.is_empty()
        {
            return Vec::new();
        }
        let broker = self.config.broker_id.clone();
        let uid = &self.config.unique_id;
        vec![
            // Per-variable: route topic+payload back through receive_raw_message.
            SubscriberWiring::TopicAware {
                broker_id: broker.clone(),
                topic: self.plugin_variable_topic(),
            },
            SubscriberWiring::TopicAware {
                broker_id: broker.clone(),
                topic: self.app_variable_topic(),
            },
            // Display topics (echoed to frontend; runtime dedupes by (broker, topic)).
            SubscriberWiring::DisplayEcho {
                broker_id: broker.clone(),
                topic: format!("microflow/{uid}/figma/variables"),
            },
            SubscriberWiring::DisplayEcho {
                broker_id: broker.clone(),
                topic: format!("microflow/{uid}/figma/status"),
            },
            SubscriberWiring::DisplayEcho {
                broker_id: broker,
                topic: format!("microflow/{uid}/app/variables/response"),
            },
        ]
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        let payload = match method {
            // ---- BOOLEAN ----
            "true" => "true".to_string(),
            "false" => "false".to_string(),
            "toggle" => {
                let current = matches!(self.base.value, ComponentValue::Bool(true));
                (!current).to_string()
            }

            // ---- FLOAT ----
            "set" => Self::serialize_value(&args),
            "increment" => {
                let current = self.base.value.as_number().unwrap_or(0.0);
                let delta = args.as_number().unwrap_or(1.0);
                (current + delta).to_string()
            }
            "decrement" => {
                let current = self.base.value.as_number().unwrap_or(0.0);
                let delta = args.as_number().unwrap_or(1.0);
                (current - delta).to_string()
            }
            "reset" => "0".to_string(),

            // ---- COLOR channels ----
            "red" | "green" | "blue" | "opacity" => {
                let channel_value = args.as_number().unwrap_or(0.0);
                let (mut r, mut g, mut b, mut a) = match self.base.value {
                    ComponentValue::Rgba { r, g, b, a } => {
                        (f64::from(r) / 255.0, f64::from(g) / 255.0, f64::from(b) / 255.0, a)
                    }
                    _ => (0.0, 0.0, 0.0, 1.0),
                };
                match method {
                    "red" => r = (channel_value / 255.0).clamp(0.0, 1.0),
                    "green" => g = (channel_value / 255.0).clamp(0.0, 1.0),
                    "blue" => b = (channel_value / 255.0).clamp(0.0, 1.0),
                    "opacity" => a = (channel_value / 100.0).clamp(0.0, 1.0),
                    _ => {}
                }
                serde_json::json!({ "r": r, "g": g, "b": b, "a": a }).to_string()
            }

            _ => {
                return Err(RuntimeError::ComponentError(format!(
                    "Unknown method: {method}"
                )))
            }
        };

        // Update local state optimistically so subsequent calls (e.g. repeated
        // toggle) see the correct current value without waiting for the roundtrip.
        let new_value = self.parse_payload(payload.as_bytes());
        self.emit_value(new_value);

        self.publish(payload, ctx);
        Ok(())
    }

    fn receive_raw_message(&mut self, _topic: &str, payload: &[u8]) {
        let value = self.parse_payload(payload);
        self.emit_value(value);
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
            other @ (CloudRequestKind::LlmGenerate { .. } | CloudRequestKind::MidiSend { .. }) => {
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
}
