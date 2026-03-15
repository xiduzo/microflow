//! MQTT Component - External
//!
//! Publishes and subscribes to MQTT topics for `IoT` connectivity.
//! 
//! # Architecture
//! 
//! The MQTT component works with the `MqttManager` through events:
//! - Subscribe nodes: `MqttManager` routes incoming messages to the component via `receive_message`
//! - Publish nodes: Component emits values that get published via `MqttManager`
//!
//! The wiring happens in lib.rs where flow events are processed.

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::sync::Arc;
use tokio::sync::mpsc;

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
}

impl Mqtt {
    #[must_use] 
    pub fn new(id: String, config: MqttConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::String(String::new())),
            config,
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

    /// Called when a message is received from the broker (for subscribe nodes)
    /// This is called by the `MqttManager` integration in lib.rs
    #[allow(dead_code)]
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
        self.base.emit_with_value("message", Cow::Owned(component_value));
    }
}

impl Component for Mqtt {
    fn id(&self) -> &str {
        &self.base.id
    }

    fn value(&self) -> ComponentValue {
        self.base.value.clone()
    }

    fn set_value(&mut self, value: ComponentValue) {
        self.base.value = value;
    }

    fn component_type(&self) -> &'static str {
        "Mqtt"
    }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), String> {
        log::info!(
            "[MQTT] Component {} initialized: broker={}, direction={}, topic={}",
            self.base.id,
            self.config.broker_id,
            self.config.direction,
            self.config.topic
        );
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "trigger" => {
                if !self.is_publish() {
                    return Err("This MQTT node is configured for subscribe, not publish".to_string());
                }

                // Store the value and emit it - the lib.rs event handler will publish it
                self.base.value = args.clone();
                
                // Emit a special event that lib.rs will intercept to publish
                // Include the broker_id, topic, and retain in the event value as JSON
                let payload = match &args {
                    ComponentValue::String(s) => s.clone(),
                    ComponentValue::Number(n) => n.to_string(),
                    ComponentValue::Bool(b) => b.to_string(),
                    _ => String::new(),
                };
                
                // Create a structured value with all the info needed for publishing
                let publish_info = serde_json::json!({
                    "brokerId": self.config.broker_id,
                    "topic": self.config.topic,
                    "payload": payload,
                    "retain": self.config.retain,
                });
                
                self.base.emit_with_value("_mqtt_publish", Cow::Owned(ComponentValue::String(publish_info.to_string())));
                Ok(())
            }
            _ => Err(format!("Unknown method: {method}")),
        }
    }

    fn destroy(&mut self) {
        log::info!("[MQTT] Component {} destroyed", self.base.id);
    }

    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> {
        self.base.event_sender.clone()
    }

    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) {
        self.base.event_sender = Some(sender);
    }

    fn requires_hardware(&self) -> bool {
        false
    }
}
