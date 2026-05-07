//! Per-impl wiring spec returned from `Component::listener_wiring()`.
//!
//! Replaces the instance-name `match` block formerly in
//! `FlowRuntime::register_component_pin_listener`. See `CONTEXT.md` § Wiring.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListenerWiring {
    /// Digital pin reporting. Component receives `pin_change` calls on bool transitions.
    DigitalPin { pin: u8 },
    /// Analog pin reporting. Component receives `pin_change` calls when value drift >= threshold.
    AnalogPin { pin: u8, threshold: u16 },
    /// I2C device by 7-bit address. Component receives `i2c_reply` calls.
    I2cAddress { address: u8 },
    /// Keyboard hotkey. Stored lowercased to match dispatch lookup.
    HotKey { accelerator: String },
}

/// Async, broker-dependent subscription a component requests against an MQTT broker.
///
/// Returned from `Component::subscriber_wiring()`. Applied at flow-apply time by the
/// Tauri command layer; the trait method itself is sync (pure data return).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubscriberWiring {
    /// Subscribe to `topic`; broker payload routes back to the component via
    /// `FlowRuntime::route_mqtt_message` (payload only, topic discarded).
    Plain { broker_id: String, topic: String },
    /// Subscribe to `topic`; broker (topic, payload) routes back via
    /// `FlowRuntime::route_figma_message`, which calls `Component::receive_raw_message`.
    TopicAware { broker_id: String, topic: String },
    /// Subscribe to `topic`; payload is echoed to the frontend via the Tauri
    /// `mqtt-message` event only — no per-component routing. Multiple components
    /// may request the same `(broker_id, topic)`; the runtime dedupes before subscribing.
    DisplayEcho { broker_id: String, topic: String },
}

impl SubscriberWiring {
    #[must_use]
    pub fn broker_id(&self) -> &str {
        match self {
            SubscriberWiring::Plain { broker_id, .. }
            | SubscriberWiring::TopicAware { broker_id, .. }
            | SubscriberWiring::DisplayEcho { broker_id, .. } => broker_id,
        }
    }

    #[must_use]
    pub fn topic(&self) -> &str {
        match self {
            SubscriberWiring::Plain { topic, .. }
            | SubscriberWiring::TopicAware { topic, .. }
            | SubscriberWiring::DisplayEcho { topic, .. } => topic,
        }
    }
}
