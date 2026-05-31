//! Per-impl wiring spec returned from `Component::listener_wiring()` /
//! `Component::subscriber_wiring()`. These are pure data (no network deps), so
//! both kinds live here ungated; the cloud *nodes* that emit `SubscriberWiring`
//! are what the `cloud` feature gates, not the type.

/// Hardware listener a component registers once constructed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListenerWiring {
    /// Digital pin reporting. Component receives `on_pin_change` on bool transitions.
    DigitalPin { pin: u8 },
    /// Analog pin reporting. Component receives `on_pin_change` when value drift >= threshold.
    AnalogPin { pin: u8, threshold: u16 },
    /// I2C device by 7-bit address. Component receives `on_i2c_reply`.
    I2cAddress { address: u8 },
    /// Keyboard hotkey. Stored lowercased to match dispatch lookup.
    HotKey { accelerator: String },
}

/// Async, broker-dependent subscription a component requests against an MQTT
/// broker. Applied by the host's cloud layer; the trait method itself is sync.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubscriberWiring {
    /// Subscribe to `topic`; broker payload routes back to the component (payload only).
    Plain { broker_id: String, topic: String },
    /// Subscribe to `topic`; broker (topic, payload) routes back via `receive_raw_message`.
    TopicAware { broker_id: String, topic: String },
    /// Subscribe to `topic`; payload echoed to the frontend only — no per-component routing.
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
