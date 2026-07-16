//! Per-impl wiring spec returned from `Component::listener_wiring()` /
//! `Component::board_wiring()` / `Component::subscriber_wiring()`. These are pure
//! data (no network deps), so all kinds live here ungated; the cloud *nodes* that
//! emit `SubscriberWiring` are what the `cloud` feature gates, not the type.
//!
//! Three kinds, one discipline — a component *describes* what it needs as a value;
//! the runtime *acts* (CONTEXT.md § Wiring):
//! - [`ListenerWiring`] — sync in-process listeners (pin / I2C address / hotkey).
//! - [`BoardWiring`] — board-wide reconcile votes (sampling interval, I2C
//!   read-delay, one continuous read). Gathered and reconciled centrally by
//!   `FlowRuntime::update_flow` via [`crate::runtime::reconcile`].
//! - [`SubscriberWiring`] — async broker subscriptions.

/// Hardware listener a component registers once constructed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListenerWiring {
    /// Digital pin reporting. Component receives `on_pin_change` on bool transitions.
    DigitalPin { pin: u8 },
    /// Analog pin reporting. Component receives `on_pin_change` when value drift >= threshold.
    AnalogPin { pin: u8, threshold: u16 },
    /// I2C device by 7-bit address + the register it streams. Component receives
    /// `on_i2c_reply` for replies whose register matches, so two nodes on one
    /// address reading different registers (e.g. an MPU6050 accel 0x3B + gyro
    /// 0x43) each get only their own bytes instead of both.
    I2cAddress { address: u8, register: u8 },
    /// Keyboard hotkey. Stored lowercased to match dispatch lookup.
    HotKey { accelerator: String },
}

/// A single I2C continuous-read the board should stream: `(address, register,
/// length)`. A hardware component that streams over I2C reports one via
/// [`BoardWiring::i2c_continuous_read`]; the runtime arms them all centrally in
/// `update_flow` (stop-all-then-start-all, see [`crate::runtime::reconcile`])
/// rather than per-node, because `StandardFirmata`'s `I2C_STOP_READING` clears the
/// lone remaining query regardless of address — so a per-node stop+start would
/// drop a sibling device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct I2cContinuousRead {
    pub address: u8,
    pub register: u8,
    pub length: u8,
}

/// Board-wide reconcile votes a component contributes. Every field targets a
/// **single global Firmata setting** (or the shared continuous-read set), so the
/// runtime cannot apply them per-node — it gathers one `BoardWiring` per component
/// and reconciles them together ([`crate::runtime::reconcile::plan_board`]):
/// - `sampling_interval_ms` / `i2c_read_delay_us` → reconciled to the **MAX** vote
///   (the slowest sensor sets the shared pace / the longest conversion sets the
///   shared read-delay), so a faster node can't out-run another's conversion time.
/// - `i2c_continuous_read` → added to the desired continuous-read set the runtime
///   arms centrally.
///
/// Default is "no preference on anything" — the vote a non-streaming component
/// casts (which is most of them).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BoardWiring {
    /// Desired board sampling interval (ms) if this component streams at a rate.
    pub sampling_interval_ms: Option<u32>,
    /// Desired I2C read-delay (µs) — the gap the board waits between writing a
    /// device's register and reading it back (no-hold SHT2x/HTU21 need it).
    pub i2c_read_delay_us: Option<u32>,
    /// The I2C continuous read this component streams, if any.
    pub i2c_continuous_read: Option<I2cContinuousRead>,
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
