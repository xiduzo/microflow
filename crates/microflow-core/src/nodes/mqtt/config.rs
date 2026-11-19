//! MQTT Node config — shared by the live runtime and the codegen emitter.
//!
//! Pure data: the broker id + topic + direction + `QoS` the `Mqtt` node publishes
//! to or subscribes from. Credentials live on the host (desktop service registry
//! / browser store), never here — this struct is the sans-IO node's whole config.

use serde::{Deserialize, Deserializer, Serialize};

/// Whether an Mqtt node publishes or subscribes.
///
/// The one rule both halves read: a node publishes when its stored
/// `direction` is exactly `"publish"`, and subscribes otherwise — a missing
/// direction, `"subscribe"`, or anything else (`"Subscribe"`, `""`, a number).
/// That is the rule the editor's Handle Rules draw the node by
/// (`data.direction === "publish"`), so what the Author sees, what runs live,
/// and what the sketch does agree. The editor only ever stores the two
/// lowercase words, and leaves the field out for a new node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MqttDirection {
    Publish,
    #[default]
    Subscribe,
}

impl<'de> Deserialize<'de> for MqttDirection {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let stored = serde_json::Value::deserialize(deserializer)?;
        Ok(if stored == "publish" { Self::Publish } else { Self::Subscribe })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MqttConfig {
    #[serde(default)]
    pub(crate) broker_id: String,
    #[serde(default)]
    pub(crate) direction: MqttDirection,
    #[serde(default)]
    pub(crate) topic: String,
    #[serde(default = "default_qos")]
    pub(crate) qos: String,
    #[serde(default)]
    pub(crate) retain: bool,
}

impl MqttConfig {
    /// Whether the node publishes (and takes `trigger`); otherwise it
    /// subscribes (and emits `value`).
    #[must_use]
    pub(crate) fn is_publish(&self) -> bool {
        self.direction == MqttDirection::Publish
    }
}

fn default_qos() -> String {
    "1".to_string()
}

impl Default for MqttConfig {
    fn default() -> Self {
        Self {
            broker_id: String::new(),
            direction: MqttDirection::default(),
            topic: String::new(),
            qos: default_qos(),
            retain: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::resolve;
    use serde_json::json;

    /// A node without a direction subscribes — in the live runtime and in the
    /// sketch, which both read the direction from here.
    #[test]
    fn a_node_without_a_direction_subscribes() {
        let config: MqttConfig = resolve(&json!({ "brokerId": "b", "topic": "t" })).unwrap();
        assert_eq!(config.direction, MqttDirection::Subscribe);
        assert_eq!(config.direction, MqttConfig::default().direction);
    }

    /// Only the exact word publishes, as the editor draws it; every other
    /// stored direction subscribes.
    #[test]
    fn only_the_exact_word_publishes() {
        let direction = |stored: serde_json::Value| {
            resolve::<MqttConfig>(&json!({ "direction": stored })).unwrap().direction
        };
        assert_eq!(direction(json!("publish")), MqttDirection::Publish);
        for stored in [json!("subscribe"), json!("Subscribe"), json!("Publish"), json!(""), json!(1), json!(null)] {
            assert_eq!(direction(stored.clone()), MqttDirection::Subscribe, "{stored}");
        }
    }
}
