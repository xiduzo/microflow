//! MQTT Node config — shared by the live runtime and (future) codegen emitter.
//!
//! Pure data: the broker id + topic + direction + `QoS` the `Mqtt` node publishes
//! to or subscribes from. Credentials live on the host (desktop service registry
//! / browser store), never here — this struct is the sans-IO node's whole config.

use serde::{Deserialize, Serialize};

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
