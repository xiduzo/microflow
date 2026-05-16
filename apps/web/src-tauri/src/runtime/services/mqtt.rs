//! MQTT publish **Capability Trait** and adapters.
//!
//! Components that publish to an MQTT broker (`Mqtt`, `Figma`) hold an
//! `Arc<dyn MqttPublisher>` and call `publish(...)` directly, replacing the
//! historic `_mqtt_publish` event-emission pattern that hopped through
//! `lib.rs`'s event-forwarding thread and a dedicated publish-handler
//! thread (see ADR-0002 § D3).
//!
//! Inbound subscription routing — collecting [`super::super::wiring::SubscriberWiring`]
//! and applying it to the manager — stays where it lives now. This trait
//! covers only the outbound publish path.
//!
//! Two adapters ship with this module:
//!
//! - [`crate::mqtt::manager::MqttManager`] is the production adapter; the
//!   trait impl in this file delegates to its existing
//!   `publish(broker_id, topic, payload, retain)` async method and
//!   translates the legacy `String` error into [`MqttPublishError`] so
//!   callers can match on the failure kind.
//! - [`RecordingMqttPublisher`] records every inbound publish call and
//!   either returns `Ok(())` or pops a scripted error from a FIFO queue.
//!   Mirrors the `RecordingLlmProvider` pattern — the second adapter is
//!   what makes [`MqttPublisher`] a real seam.

use async_trait::async_trait;
use std::sync::Mutex;
use thiserror::Error;

use crate::mqtt::manager::MqttManager;

/// Failure modes a `MqttPublisher::publish` can surface.
#[derive(Error, Debug)]
pub enum MqttPublishError {
    /// The broker id is not in the manager's connected set. Distinguished
    /// from `PublishFailed` so callers can prompt the user to (re)connect
    /// rather than surface a generic wire error.
    #[error("MQTT broker '{0}' not connected")]
    BrokerNotConnected(String),

    /// Wire-level failure (broker rejected the publish, connection
    /// dropped mid-flight, payload too large, …). Inner message is the
    /// upstream reason.
    #[error("MQTT publish failed: {0}")]
    PublishFailed(String),
}

/// Capability Trait for any backend that can publish a single MQTT message.
///
/// `Send + Sync` because `Arc<dyn MqttPublisher>` is shared across tokio
/// tasks. Async via `async-trait` for dyn-safety under Rust 2021.
#[async_trait]
pub trait MqttPublisher: Send + Sync {
    /// Publish one message to `topic` on the broker identified by
    /// `broker_id`. `payload` is the raw bytes the broker forwards;
    /// callers serialise their own value first. `retain` matches MQTT's
    /// retain flag — the broker stores the last retained payload per
    /// topic and replays it to new subscribers.
    async fn publish(
        &self,
        broker_id: &str,
        topic: &str,
        payload: &[u8],
        retain: bool,
    ) -> Result<(), MqttPublishError>;
}

// ---------------------------------------------------------------------------
// Production adapter: MqttManager
// ---------------------------------------------------------------------------

#[async_trait]
impl MqttPublisher for MqttManager {
    async fn publish(
        &self,
        broker_id: &str,
        topic: &str,
        payload: &[u8],
        retain: bool,
    ) -> Result<(), MqttPublishError> {
        // The existing `MqttManager::publish` returns `Result<(), String>`
        // with "Broker {id} not connected" as the only id-specific message
        // it produces. Translate that into the typed variant; route every
        // other string into `PublishFailed` so callers can still log /
        // surface the upstream reason verbatim.
        match MqttManager::publish(self, broker_id, topic, payload, retain).await {
            Ok(()) => Ok(()),
            Err(msg) if msg.contains("not connected") => {
                Err(MqttPublishError::BrokerNotConnected(broker_id.to_string()))
            }
            Err(msg) => Err(MqttPublishError::PublishFailed(msg)),
        }
    }
}

// ---------------------------------------------------------------------------
// Test adapter: RecordingMqttPublisher
// ---------------------------------------------------------------------------

/// One captured publish call. The trait passes `&[u8]` for the payload but
/// the recorder snapshots it as an owned `Vec<u8>` so tests can inspect
/// later without lifetime constraints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedPublish {
    pub broker_id: String,
    pub topic: String,
    pub payload: Vec<u8>,
    pub retain: bool,
}

/// Test [`MqttPublisher`] that records every publish call and either
/// returns `Ok(())` or pops a scripted error from a FIFO queue.
///
/// Mirrors [`super::llm::RecordingLlmProvider`]: tests assert what was
/// sent (broker_id / topic / payload / retain) and drive components
/// through both success and failure paths without standing up a broker.
pub struct RecordingMqttPublisher {
    recorded: Mutex<Vec<RecordedPublish>>,
    /// Scripted failures. Each entry pops one publish; when the queue is
    /// empty, calls succeed (the default for tests that don't care about
    /// failure paths). Use [`script_err`](Self::script_err) to inject a
    /// specific failure.
    scripted_errors: Mutex<std::collections::VecDeque<MqttPublishError>>,
}

impl RecordingMqttPublisher {
    #[must_use]
    pub fn new() -> Self {
        Self {
            recorded: Mutex::new(Vec::new()),
            scripted_errors: Mutex::new(std::collections::VecDeque::new()),
        }
    }

    /// Push one scripted error onto the back of the failure queue. The
    /// next publish call consumes it and returns the error; the call is
    /// still recorded.
    pub fn script_err(&self, err: MqttPublishError) {
        self.scripted_errors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push_back(err);
    }

    /// Snapshot of every call received, in call order.
    #[must_use]
    pub fn recorded(&self) -> Vec<RecordedPublish> {
        self.recorded
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

impl Default for RecordingMqttPublisher {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MqttPublisher for RecordingMqttPublisher {
    async fn publish(
        &self,
        broker_id: &str,
        topic: &str,
        payload: &[u8],
        retain: bool,
    ) -> Result<(), MqttPublishError> {
        self.recorded
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(RecordedPublish {
                broker_id: broker_id.to_string(),
                topic: topic.to_string(),
                payload: payload.to_vec(),
                retain,
            });

        if let Some(err) = self
            .scripted_errors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pop_front()
        {
            Err(err)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn recording_publisher_captures_calls_in_order() {
        let pub_ = RecordingMqttPublisher::new();
        pub_.publish("b1", "t/one", b"a", false).await.unwrap();
        pub_.publish("b2", "t/two", b"bcd", true).await.unwrap();

        let recorded = pub_.recorded();
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[0].broker_id, "b1");
        assert_eq!(recorded[0].topic, "t/one");
        assert_eq!(recorded[0].payload, b"a");
        assert!(!recorded[0].retain);
        assert_eq!(recorded[1].broker_id, "b2");
        assert_eq!(recorded[1].topic, "t/two");
        assert_eq!(recorded[1].payload, b"bcd");
        assert!(recorded[1].retain);
    }

    #[tokio::test]
    async fn recording_publisher_records_even_when_scripted_to_fail() {
        let pub_ = RecordingMqttPublisher::new();
        pub_.script_err(MqttPublishError::BrokerNotConnected("b1".into()));
        let err = pub_
            .publish("b1", "t", b"x", false)
            .await
            .expect_err("scripted err");
        assert!(matches!(err, MqttPublishError::BrokerNotConnected(id) if id == "b1"));
        // Call still recorded.
        assert_eq!(pub_.recorded().len(), 1);
    }

    #[tokio::test]
    async fn recording_publisher_errors_drain_fifo() {
        let pub_ = RecordingMqttPublisher::new();
        pub_.script_err(MqttPublishError::PublishFailed("first".into()));
        pub_.script_err(MqttPublishError::PublishFailed("second".into()));

        let a = pub_.publish("b", "t", b"x", false).await.unwrap_err();
        let b = pub_.publish("b", "t", b"x", false).await.unwrap_err();
        let c = pub_.publish("b", "t", b"x", false).await; // queue empty → Ok

        assert!(matches!(a, MqttPublishError::PublishFailed(msg) if msg == "first"));
        assert!(matches!(b, MqttPublishError::PublishFailed(msg) if msg == "second"));
        assert!(c.is_ok());
    }
}
