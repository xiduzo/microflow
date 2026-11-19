//! MQTT broker **Capability Trait** and adapters.
//!
//! [`MqttBrokers`] is everything the desktop **`CloudPerformer`**
//! ([`crate::runtime::cloud_performer`]) asks of the broker pool: publish a
//! message, subscribe and unsubscribe a topic for the flow, learn which
//! [`BrokerSession`] a broker is in, and hear when a session started, ended
//! or got its link back. The cloud nodes themselves are sans-IO
//! (ADR-0009) and never hold it; they record `CloudRequest`s and subscriber
//! wirings, and the performer turns those into calls on this trait.
//!
//! Two adapters make it a real seam:
//!
//! - [`crate::mqtt::manager::MqttManager`] is the production adapter; the
//!   trait impl in this file delegates to its inherent methods and translates
//!   their `String` errors into [`MqttError`] so callers can match on the
//!   failure kind.
//! - [`RecordingMqttBrokers`] is an in-memory broker pool for tests. It keeps
//!   what the real one keeps — one session per connected broker, one callback
//!   per topic, forgotten when the session ends — records every call in order,
//!   and can be scripted to fail a call or to deliver an inbound message.

use async_trait::async_trait;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use thiserror::Error;
use tokio::sync::watch;

use crate::mqtt::broker::{MessageCallback, MqttMessage, Subscriber};
use crate::mqtt::manager::MqttManager;
pub use crate::mqtt::broker::LastWord;
pub use crate::mqtt::manager::BrokerSession;

/// Failure modes of a call on [`MqttBrokers`].
#[derive(Error, Debug, Clone, PartialEq, Eq)]
pub enum MqttError {
    /// The pool holds no connection for this broker id. Distinguished from
    /// `Failed` so callers can prompt the user to (re)connect rather than
    /// surface a generic wire error.
    #[error("MQTT broker '{0}' not connected")]
    BrokerNotConnected(String),

    /// Wire-level failure (the link is down, the broker rejected the packet,
    /// the topic is invalid, …). Inner message is the upstream reason.
    #[error("MQTT request failed: {0}")]
    Failed(String),
}

/// Capability Trait for the MQTT broker pool: every broker the app is
/// connected to, addressed by broker id.
///
/// `Send + Sync` because `Arc<dyn MqttBrokers>` is shared across tokio tasks.
/// Async via `async-trait` for dyn-safety under Rust 2021.
#[async_trait]
pub trait MqttBrokers: Send + Sync {
    /// The session `broker_id` is in, or `None` when the pool holds no
    /// connection for it. A broker keeps its subscriptions for as long as its
    /// session lasts — across a dropped link, which it repairs by itself — and
    /// forgets them when the session ends.
    async fn session(&self, broker_id: &str) -> Option<BrokerSession>;

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
    ) -> Result<(), MqttError>;

    /// Subscribe the flow to `topic` on `broker_id`, routing every matching
    /// message to `on_message`. The flow has one callback per topic:
    /// subscribing a topic it already holds replaces the callback. Whoever else
    /// subscribes the same topic on the broker (the Connection Console) is
    /// unaffected, and does not affect the flow: the topic's retained messages
    /// come to `on_message` for this subscribe, and not again when somebody
    /// else subscribes it. On success, returns the id of the session that now
    /// holds the subscription; on failure the broker holds nothing new.
    ///
    /// Success means the request went out on the broker's link. A broker that
    /// then refuses it (its SUBACK) is not reported here.
    async fn subscribe(
        &self,
        broker_id: &str,
        topic: &str,
        on_message: MessageCallback,
    ) -> Result<u64, MqttError>;

    /// Drop the flow's subscription for `topic` on `broker_id`. On failure the
    /// broker still holds it.
    async fn unsubscribe(&self, broker_id: &str, topic: &str) -> Result<(), MqttError>;

    /// Leave `words` with `broker_id`'s session `session`: what the pool
    /// publishes on it just before it ends that session on purpose — the
    /// broker is disconnected, removed from the settings, or given other
    /// settings — if its link is up at that moment. The caller hears of a
    /// session's end only after it, when there is no link left to say anything
    /// on; what has to be said then is left here beforehand.
    ///
    /// The list replaces what was left before, and an empty one leaves
    /// nothing. It stays with the session across a dropped and repaired link,
    /// and goes with it. A session whose link is down when it ends says
    /// nothing. Ignored when `session` is not the broker's session any more.
    async fn set_last_words(&self, broker_id: &str, session: u64, words: Vec<LastWord>);

    /// Ticks whenever a broker session started, ended, or got its link back:
    /// the moments at which a call that could not succeed before can now, and
    /// at which a session id held from before may no longer be current. The
    /// value is a counter; only the tick matters.
    fn changes(&self) -> watch::Receiver<u64>;
}

// ---------------------------------------------------------------------------
// Production adapter: MqttManager
// ---------------------------------------------------------------------------

/// `MqttManager`'s inherent methods return `Result<_, String>` with
/// "Broker {id} not connected" as the only id-specific message. Translate that
/// into the typed variant; every other string is the upstream reason verbatim.
fn typed(broker_id: &str, message: String) -> MqttError {
    if message.contains("not connected") {
        MqttError::BrokerNotConnected(broker_id.to_string())
    } else {
        MqttError::Failed(message)
    }
}

#[async_trait]
impl MqttBrokers for MqttManager {
    async fn session(&self, broker_id: &str) -> Option<BrokerSession> {
        MqttManager::session(self, broker_id).await
    }

    async fn publish(
        &self,
        broker_id: &str,
        topic: &str,
        payload: &[u8],
        retain: bool,
    ) -> Result<(), MqttError> {
        MqttManager::publish(self, broker_id, topic, payload, retain)
            .await
            .map_err(|message| typed(broker_id, message))
    }

    async fn subscribe(
        &self,
        broker_id: &str,
        topic: &str,
        on_message: MessageCallback,
    ) -> Result<u64, MqttError> {
        MqttManager::subscribe(self, broker_id, topic, Subscriber::Flow, on_message)
            .await
            .map_err(|message| typed(broker_id, message))
    }

    async fn unsubscribe(&self, broker_id: &str, topic: &str) -> Result<(), MqttError> {
        MqttManager::unsubscribe(self, broker_id, topic, Subscriber::Flow)
            .await
            .map_err(|message| typed(broker_id, message))
    }

    async fn set_last_words(&self, broker_id: &str, session: u64, words: Vec<LastWord>) {
        MqttManager::set_last_words(self, broker_id, session, words).await;
    }

    fn changes(&self) -> watch::Receiver<u64> {
        MqttManager::changes(self)
    }
}

// ---------------------------------------------------------------------------
// Test adapter: RecordingMqttBrokers
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

/// One call [`RecordingMqttBrokers`] received.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerCall {
    Publish(RecordedPublish),
    Subscribe { broker_id: String, topic: String },
    Unsubscribe { broker_id: String, topic: String },
}

/// The calls [`RecordingMqttBrokers::script_err`] can fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BrokerOp {
    Publish,
    Subscribe,
    Unsubscribe,
}

/// One broker in the recording pool.
struct RecordedBroker {
    session: BrokerSession,
    /// What the broker holds: one callback per topic.
    subscriptions: HashMap<String, MessageCallback>,
    /// What was left with the session to say when it is ended on purpose.
    last_words: Vec<LastWord>,
}

#[derive(Default)]
struct Recorded {
    calls: Vec<BrokerCall>,
    brokers: HashMap<String, RecordedBroker>,
    sessions_started: u64,
    /// The [`BrokerSession::link`]s handed out so far.
    links: u64,
    /// Scripted failures per call kind. Each entry fails one call of that
    /// kind; with the queue empty the call takes its normal course.
    scripted_errors: HashMap<BrokerOp, VecDeque<MqttError>>,
    /// How many `subscribe` calls are waiting to be released.
    subscribes_held: usize,
}

/// Test [`MqttBrokers`]: an in-memory broker pool that behaves as the real one
/// does where a caller can tell — a broker must be [connected](Self::connect)
/// before it takes a call, holds one callback per topic, keeps its
/// subscriptions while its link is [down](Self::set_online) and forgets them
/// when its session [ends](Self::disconnect). Every call is recorded in
/// order, including the ones that fail, and [`MqttBrokers::changes`] ticks
/// when the real pool's does: a session starts, ends, or gets its link back.
///
/// It holds the flow's subscriptions only — the one subscriber this trait
/// speaks for. How subscribers share a topic is the real pool's own business,
/// tested against a socket in `tests/mqtt_pool.rs`.
pub struct RecordingMqttBrokers {
    recorded: Mutex<Recorded>,
    changes: watch::Sender<u64>,
    /// Whether `subscribe` calls are being held ([`Self::hold_subscribes`]).
    holding: watch::Sender<bool>,
}

impl Default for RecordingMqttBrokers {
    fn default() -> Self {
        Self { recorded: Mutex::default(), changes: watch::channel(0).0, holding: watch::channel(false).0 }
    }
}

impl RecordingMqttBrokers {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn recorded(&self) -> std::sync::MutexGuard<'_, Recorded> {
        self.recorded.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn changed(&self) {
        self.changes.send_modify(|count| *count += 1);
    }

    /// Connect `broker_id`: a new session, online, holding no subscriptions.
    /// A broker that was already connected starts over, as a reconnect with a
    /// changed config does.
    pub fn connect(&self, broker_id: &str) {
        {
            let mut recorded = self.recorded();
            recorded.sessions_started += 1;
            recorded.links += 1;
            let session = BrokerSession { id: recorded.sessions_started, online: true, link: recorded.links };
            let broker = RecordedBroker { session, subscriptions: HashMap::new(), last_words: Vec::new() };
            recorded.brokers.insert(broker_id.to_string(), broker);
        }
        self.changed();
    }

    /// What `broker_id`'s session was last left to say when it is ended on
    /// purpose; nothing for a broker the pool does not hold. (The recording
    /// pool keeps the words and says nothing: that the real one publishes them
    /// before it closes the link is tested against a socket, in
    /// `tests/mqtt_pool.rs`.)
    #[must_use]
    pub fn last_words(&self, broker_id: &str) -> Vec<LastWord> {
        self.recorded().brokers.get(broker_id).map(|broker| broker.last_words.clone()).unwrap_or_default()
    }

    /// End `broker_id`'s session: the pool no longer holds it.
    pub fn disconnect(&self, broker_id: &str) {
        self.recorded().brokers.remove(broker_id);
        self.changed();
    }

    /// Take `broker_id`'s link down or bring it back. The session, and the
    /// subscriptions it holds, survive; a link that comes back is a new
    /// [link](BrokerSession::link).
    pub fn set_online(&self, broker_id: &str, online: bool) {
        {
            let mut guard = self.recorded();
            let recorded = &mut *guard;
            if let Some(broker) = recorded.brokers.get_mut(broker_id) {
                if online && !broker.session.online {
                    recorded.links += 1;
                    broker.session.link = recorded.links;
                }
                broker.session.online = online;
            }
        }
        if online {
            self.changed();
        }
    }

    /// From here on, keep every `subscribe` call waiting — on the wire, not
    /// yet answered — until [`Self::release_subscribes`]. For a test of what
    /// must not happen before a subscribe is through.
    pub fn hold_subscribes(&self) {
        self.holding.send_replace(true);
    }

    /// Let the held `subscribe` calls through, and stop holding new ones.
    pub fn release_subscribes(&self) {
        self.holding.send_replace(false);
    }

    /// How many `subscribe` calls are being held right now.
    #[must_use]
    pub fn subscribes_held(&self) -> usize {
        self.recorded().subscribes_held
    }

    /// Fail the next call of kind `op` with `err` — a call that did not make
    /// it onto the wire, which is the failure the real pool reports. Queued: a
    /// second scripted error fails the call after that.
    pub fn script_err(&self, op: BrokerOp, err: MqttError) {
        self.recorded().scripted_errors.entry(op).or_default().push_back(err);
    }

    /// Every call received, in call order.
    #[must_use]
    pub fn calls(&self) -> Vec<BrokerCall> {
        self.recorded().calls.clone()
    }

    /// Every publish received, in call order.
    #[must_use]
    pub fn published(&self) -> Vec<RecordedPublish> {
        self.calls()
            .into_iter()
            .filter_map(|call| match call {
                BrokerCall::Publish(publish) => Some(publish),
                BrokerCall::Subscribe { .. } | BrokerCall::Unsubscribe { .. } => None,
            })
            .collect()
    }

    /// The topics `broker_id` holds a subscription for, sorted.
    #[must_use]
    pub fn subscriptions(&self, broker_id: &str) -> Vec<String> {
        let recorded = self.recorded();
        let mut topics: Vec<String> = recorded
            .brokers
            .get(broker_id)
            .map(|broker| broker.subscriptions.keys().cloned().collect())
            .unwrap_or_default();
        topics.sort();
        topics
    }

    /// An inbound message on `topic`: run the callback `broker_id` holds for
    /// it. Returns whether there was one.
    pub fn deliver(&self, broker_id: &str, topic: &str, payload: &[u8]) -> bool {
        // Cloned out so the callback runs without the recorder's lock.
        let callback = self
            .recorded()
            .brokers
            .get(broker_id)
            .and_then(|broker| broker.subscriptions.get(topic).cloned());
        let Some(callback) = callback else { return false };
        callback(MqttMessage { topic: topic.to_string(), payload: payload.to_vec(), retain: false });
        true
    }

    /// Record `call`, then decide its outcome: a scripted error, the errors a
    /// real pool answers for a broker it does not hold or whose link is down,
    /// or `apply` on the broker.
    fn take<T>(
        &self,
        op: BrokerOp,
        broker_id: &str,
        call: BrokerCall,
        apply: impl FnOnce(&mut RecordedBroker) -> T,
    ) -> Result<T, MqttError> {
        let mut recorded = self.recorded();
        recorded.calls.push(call);
        if let Some(err) = recorded.scripted_errors.get_mut(&op).and_then(VecDeque::pop_front) {
            return Err(err);
        }
        let broker = recorded
            .brokers
            .get_mut(broker_id)
            .ok_or_else(|| MqttError::BrokerNotConnected(broker_id.to_string()))?;
        if !broker.session.online {
            return Err(MqttError::Failed("Not connected".to_string()));
        }
        Ok(apply(broker))
    }
}

#[async_trait]
impl MqttBrokers for RecordingMqttBrokers {
    async fn session(&self, broker_id: &str) -> Option<BrokerSession> {
        self.recorded().brokers.get(broker_id).map(|broker| broker.session)
    }

    async fn publish(
        &self,
        broker_id: &str,
        topic: &str,
        payload: &[u8],
        retain: bool,
    ) -> Result<(), MqttError> {
        let call = BrokerCall::Publish(RecordedPublish {
            broker_id: broker_id.to_string(),
            topic: topic.to_string(),
            payload: payload.to_vec(),
            retain,
        });
        self.take(BrokerOp::Publish, broker_id, call, |_| ())
    }

    async fn subscribe(
        &self,
        broker_id: &str,
        topic: &str,
        on_message: MessageCallback,
    ) -> Result<u64, MqttError> {
        // A real subscribe is a network round trip: let other tasks run, so a
        // caller that is not safe to interleave shows it.
        tokio::task::yield_now().await;
        let mut holding = self.holding.subscribe();
        if *holding.borrow() {
            self.recorded().subscribes_held += 1;
            let _ = holding.wait_for(|holding| !*holding).await;
            self.recorded().subscribes_held -= 1;
        }
        let call = BrokerCall::Subscribe { broker_id: broker_id.to_string(), topic: topic.to_string() };
        self.take(BrokerOp::Subscribe, broker_id, call, |broker| {
            broker.subscriptions.insert(topic.to_string(), on_message);
            broker.session.id
        })
    }

    async fn unsubscribe(&self, broker_id: &str, topic: &str) -> Result<(), MqttError> {
        tokio::task::yield_now().await;
        let call = BrokerCall::Unsubscribe { broker_id: broker_id.to_string(), topic: topic.to_string() };
        self.take(BrokerOp::Unsubscribe, broker_id, call, |broker| {
            broker.subscriptions.remove(topic);
        })
    }

    async fn set_last_words(&self, broker_id: &str, session: u64, words: Vec<LastWord>) {
        if let Some(broker) = self.recorded().brokers.get_mut(broker_id).filter(|broker| broker.session.id == session) {
            broker.last_words = words;
        }
    }

    fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn ignore() -> MessageCallback {
        Arc::new(|_| {})
    }

    #[tokio::test]
    async fn the_recording_pool_captures_calls_in_order() {
        let brokers = RecordingMqttBrokers::new();
        brokers.connect("b1");
        brokers.publish("b1", "t/one", b"a", false).await.unwrap();
        brokers.subscribe("b1", "t/two", ignore()).await.unwrap();
        brokers.unsubscribe("b1", "t/two").await.unwrap();

        assert_eq!(
            brokers.calls(),
            vec![
                BrokerCall::Publish(RecordedPublish {
                    broker_id: "b1".into(),
                    topic: "t/one".into(),
                    payload: b"a".to_vec(),
                    retain: false,
                }),
                BrokerCall::Subscribe { broker_id: "b1".into(), topic: "t/two".into() },
                BrokerCall::Unsubscribe { broker_id: "b1".into(), topic: "t/two".into() },
            ]
        );
    }

    #[tokio::test]
    async fn a_scripted_error_fails_one_call_and_the_call_is_still_recorded() {
        let brokers = RecordingMqttBrokers::new();
        brokers.connect("b");
        brokers.script_err(BrokerOp::Subscribe, MqttError::Failed("first".into()));
        brokers.script_err(BrokerOp::Subscribe, MqttError::Failed("second".into()));

        let first = brokers.subscribe("b", "t", ignore()).await;
        let second = brokers.subscribe("b", "t", ignore()).await;
        let third = brokers.subscribe("b", "t", ignore()).await;

        assert_eq!(first, Err(MqttError::Failed("first".into())));
        assert_eq!(second, Err(MqttError::Failed("second".into())));
        assert!(third.is_ok(), "the queue is empty: {third:?}");
        assert_eq!(brokers.calls().len(), 3);
        // Only the publish queue is untouched by a subscribe script.
        assert!(brokers.publish("b", "t", b"x", false).await.is_ok());
    }

    #[tokio::test]
    async fn a_failed_subscribe_leaves_the_broker_holding_nothing() {
        let brokers = RecordingMqttBrokers::new();
        brokers.connect("b");
        brokers.script_err(BrokerOp::Subscribe, MqttError::Failed("connection reset".into()));
        assert!(brokers.subscribe("b", "t", ignore()).await.is_err());
        assert!(brokers.subscriptions("b").is_empty());
        assert!(!brokers.deliver("b", "t", b"x"));
    }

    #[tokio::test]
    async fn a_broker_the_pool_does_not_hold_answers_not_connected() {
        let brokers = RecordingMqttBrokers::new();
        assert_eq!(brokers.session("b").await, None);
        assert_eq!(
            brokers.publish("b", "t", b"x", false).await,
            Err(MqttError::BrokerNotConnected("b".into()))
        );
    }

    #[tokio::test]
    async fn a_dropped_link_keeps_the_session_and_its_subscriptions() {
        let brokers = RecordingMqttBrokers::new();
        brokers.connect("b");
        let session = brokers.subscribe("b", "t", ignore()).await.unwrap();

        brokers.set_online("b", false);
        assert_eq!(brokers.session("b").await.map(|s| (s.id, s.online)), Some((session, false)));
        assert_eq!(brokers.subscriptions("b"), vec!["t".to_string()]);
        assert!(matches!(brokers.unsubscribe("b", "t").await, Err(MqttError::Failed(_))));
        assert_eq!(brokers.subscriptions("b"), vec!["t".to_string()], "a failed unsubscribe is not applied");
    }

    #[tokio::test]
    async fn a_new_session_has_a_new_id_and_no_subscriptions() {
        let brokers = RecordingMqttBrokers::new();
        brokers.connect("b");
        let first = brokers.subscribe("b", "t", ignore()).await.unwrap();

        brokers.connect("b");
        let second = brokers.session("b").await.expect("connected");
        assert_ne!(second.id, first);
        assert!(brokers.subscriptions("b").is_empty());
    }

    #[tokio::test]
    async fn changes_tick_when_a_session_starts_ends_or_gets_its_link_back() {
        let brokers = RecordingMqttBrokers::new();
        let mut changes = brokers.changes();
        let mut ticked = move || {
            let ticked = changes.has_changed().expect("the pool is alive");
            changes.mark_unchanged();
            ticked
        };

        brokers.connect("b");
        assert!(ticked(), "a session started");
        brokers.set_online("b", false);
        assert!(!ticked(), "a link going down opens nothing up");
        brokers.set_online("b", true);
        assert!(ticked(), "the link came back");
        brokers.disconnect("b");
        assert!(ticked(), "the session ended");
    }

    #[tokio::test]
    async fn deliver_runs_the_callback_the_broker_holds_for_the_topic() {
        let brokers = RecordingMqttBrokers::new();
        brokers.connect("b");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let on_message: MessageCallback =
            Arc::new(move |message: MqttMessage| sink.lock().unwrap().push((message.topic, message.payload)));
        brokers.subscribe("b", "t", on_message).await.unwrap();

        assert!(brokers.deliver("b", "t", b"hi"));
        assert_eq!(*seen.lock().unwrap(), vec![("t".to_string(), b"hi".to_vec())]);
    }
}
