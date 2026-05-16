//! Figma Component - External
//!
//! Bridges Figma design variables into the flow via MQTT.
//!
//! # Architecture
//!
//! - Subscribes to `microflow/${uniqueId}/figma/variable/${shortVarId}` and
//!   `microflow/${uniqueId}/app/variable/${shortVarId}` for incoming values.
//! - Emits a "change" event downstream when a value arrives.
//! - Handles `dispatch` (set / toggle / true / false / increment / decrement /
//!   reset / red / green / blue / opacity) by computing a payload and calling
//!   the held `Arc<dyn MqttPublisher>` directly. Replaces the legacy
//!   `_mqtt_publish` event-out pattern (ADR-0002 Phase 3).

use crate::runtime::base::{Component, ComponentBase, ComponentValue};
use crate::runtime::services::MqttPublisher;
use crate::runtime::wiring::SubscriberWiring;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FigmaConfig {
    #[serde(default)]
    pub broker_id: String,
    #[serde(default)]
    pub unique_id: String,
    #[serde(default)]
    pub variable_id: String,
    #[serde(default = "default_resolved_type")]
    pub resolved_type: String,
    #[serde(default = "default_debounce_time")]
    pub debounce_time: u64,
}

fn default_resolved_type() -> String {
    "STRING".to_string()
}

fn default_debounce_time() -> u64 {
    100
}

impl Default for FigmaConfig {
    fn default() -> Self {
        Self {
            broker_id: String::new(),
            unique_id: String::new(),
            variable_id: String::new(),
            resolved_type: "STRING".to_string(),
            debounce_time: 100,
        }
    }
}

pub struct Figma {
    base: ComponentBase,
    config: FigmaConfig,
    /// Shared MQTT publish handle. Cloned into each spawned publish task.
    publisher: Arc<dyn MqttPublisher>,
    /// Tokio handle captured at construction so `dispatch` (sync) can spawn
    /// the async publish call.
    rt_handle: Option<tokio::runtime::Handle>,
}

impl Figma {
    #[must_use]
    pub fn new(id: String, config: FigmaConfig, publisher: Arc<dyn MqttPublisher>) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::String(String::new())),
            config,
            publisher,
            rt_handle: tokio::runtime::Handle::try_current().ok(),
        }
    }

    /// Convert `VariableID:123:456` → `123-456`
    fn short_var_id(&self) -> String {
        self.config
            .variable_id
            .replace("VariableID:", "")
            .replace(':', "-")
    }

    /// Topic the Figma plugin publishes variable values to
    #[must_use]
    pub fn plugin_variable_topic(&self) -> String {
        format!(
            "microflow/{}/figma/variable/{}",
            self.config.unique_id,
            self.short_var_id()
        )
    }

    /// Topic the plugin responds to after a variables/request
    #[must_use]
    pub fn app_variable_topic(&self) -> String {
        format!(
            "microflow/{}/app/variable/{}",
            self.config.unique_id,
            self.short_var_id()
        )
    }

    /// Topic used to push a new value back into Figma
    fn set_topic(&self) -> String {
        format!(
            "microflow/{}/app/variable/{}/set",
            self.config.unique_id,
            self.short_var_id()
        )
    }

    #[must_use]
    pub fn broker_id(&self) -> &str {
        &self.config.broker_id
    }

    #[must_use]
    pub fn unique_id(&self) -> &str {
        &self.config.unique_id
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
                // Figma COLOR is {r, g, b, a} with r/g/b in 0-1 range
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
                // STRING — strip surrounding quotes if the plugin JSON-encoded it
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
            ComponentValue::Rgba { r, g, b, a } => {
                // Figma expects r/g/b in 0-1
                serde_json::json!({
                    "r": f64::from(*r) / 255.0,
                    "g": f64::from(*g) / 255.0,
                    "b": f64::from(*b) / 255.0,
                    "a": a,
                })
                .to_string()
            }
            ComponentValue::Array(_) => String::new(),
        }
    }

    /// Push a JSON payload back into Figma over the configured broker.
    ///
    /// Spawns the async [`MqttPublisher::publish`] call onto the captured
    /// Tokio handle and logs any wire failure — the component's `dispatch`
    /// path stays synchronous and never blocks on the broker.
    fn publish(&self, payload: String) {
        let publisher = Arc::clone(&self.publisher);
        let broker_id = self.config.broker_id.clone();
        let topic = self.set_topic();
        let component_id = Arc::clone(&self.base.id);

        let Some(handle) = &self.rt_handle else {
            log::error!(
                "[Figma] {component_id} no Tokio runtime available, cannot spawn publish"
            );
            return;
        };

        handle.spawn(async move {
            log::debug!(
                "[Figma] {component_id} publish → broker={broker_id} topic={topic}"
            );
            if let Err(e) = publisher
                .publish(&broker_id, &topic, payload.as_bytes(), false)
                .await
            {
                log::error!(
                    "[Figma] {component_id} publish failed (broker={broker_id} topic={topic}): {e}"
                );
            }
        });
    }

    /// Called by commands.rs when a message arrives on any of this component's subscribed topics.
    pub fn receive_message(&mut self, _topic: &str, payload: &[u8]) {
        let value = self.parse_payload(payload);
        self.base.value = value.clone();
        // "value" updates the node display in the frontend (useNodeValue hook listens for this)
        self.base.emit_with_value("value", Cow::Owned(value.clone()));
        self.base.emit_with_value("change", Cow::Owned(value));
    }
}

impl Component for Figma {
    fn ports() -> &'static [&'static str] { &["true", "false", "toggle", "set", "increment", "decrement", "reset", "red", "green", "blue", "opacity"] }

    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Figma" }

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
            SubscriberWiring::TopicAware { broker_id: broker.clone(), topic: self.plugin_variable_topic() },
            SubscriberWiring::TopicAware { broker_id: broker.clone(), topic: self.app_variable_topic() },
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

    fn dispatch(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
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

            _ => return Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        };

        // Update local state optimistically so subsequent calls (e.g. repeated toggle)
        // see the correct current value without waiting for the MQTT roundtrip.
        let new_value = self.parse_payload(payload.as_bytes());
        self.base.value = new_value.clone();
        // "value" updates the node display in the frontend (useNodeValue hook listens for this)
        self.base.emit_with_value("value", Cow::Owned(new_value.clone()));
        self.base.emit_with_value("change", Cow::Owned(new_value));

        self.publish(payload);
        Ok(())
    }

    fn destroy(&mut self) {
        log::info!("[Figma] Component {} destroyed", self.base.id);
    }

    fn receive_raw_message(&mut self, topic: &str, payload: &[u8]) {
        self.receive_message(topic, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::services::RecordingMqttPublisher;
    use std::time::Duration;

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

    fn config() -> FigmaConfig {
        let mut c = FigmaConfig::default();
        c.broker_id = "broker-1".into();
        c.unique_id = "uid-1".into();
        c.variable_id = "VariableID:1:2".into();
        c.resolved_type = "BOOLEAN".into();
        c
    }

    #[tokio::test]
    async fn dispatch_true_publishes_true_payload_to_set_topic() {
        let recorder = Arc::new(RecordingMqttPublisher::new());
        let mut figma = Figma::new(
            "node-1".into(),
            config(),
            recorder.clone() as Arc<dyn MqttPublisher>,
        );

        figma
            .dispatch("true", ComponentValue::Bool(true))
            .expect("dispatch ok");

        let recorded = wait_for_publishes(&recorder, 1, Duration::from_secs(1)).await;
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].broker_id, "broker-1");
        assert_eq!(recorded[0].topic, "microflow/uid-1/app/variable/1-2/set");
        assert_eq!(recorded[0].payload, b"true");
        assert!(!recorded[0].retain);
    }

    #[tokio::test]
    async fn dispatch_increment_publishes_summed_payload() {
        let mut c = config();
        c.resolved_type = "FLOAT".into();
        let recorder = Arc::new(RecordingMqttPublisher::new());
        let mut figma = Figma::new(
            "node-1".into(),
            c,
            recorder.clone() as Arc<dyn MqttPublisher>,
        );
        // Seed current value to 5.
        figma
            .dispatch("set", ComponentValue::Number(5.0))
            .expect("set ok");
        // Drain the seed publish.
        wait_for_publishes(&recorder, 1, Duration::from_secs(1)).await;

        figma
            .dispatch("increment", ComponentValue::Number(3.0))
            .expect("increment ok");
        let recorded = wait_for_publishes(&recorder, 2, Duration::from_secs(1)).await;
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[1].payload, b"8");
    }

    #[tokio::test]
    async fn dispatch_unknown_method_does_not_publish() {
        let recorder = Arc::new(RecordingMqttPublisher::new());
        let mut figma = Figma::new(
            "node-1".into(),
            config(),
            recorder.clone() as Arc<dyn MqttPublisher>,
        );
        let err = figma
            .dispatch("definitely-not-a-method", ComponentValue::Bool(true))
            .expect_err("should fail");
        assert!(err.to_string().contains("Unknown method"));
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(recorder.recorded().is_empty());
    }
}
