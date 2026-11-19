//! The MQTT broker pool, against a socket.
//!
//! `MqttManager` is the production adapter behind the `MqttBrokers` Capability
//! Trait, and the pool the Connection Console subscribes on. These tests hold
//! it to what its callers rely on, over TCP, with a broker that speaks just
//! enough MQTT 5 to be connected, subscribed to and published from:
//!
//! - **Sessions.** A broker's session keeps its id and its subscriptions while
//!   a dropped link is repaired — by the client itself, or sooner by a
//!   `connect` — and a client that was disconnected or replaced stays down.
//! - **Subscribers.** The flow and the console can hold the same topic filter;
//!   each gets its own deliveries, and one letting go does not affect the
//!   other.
//! - **Retained messages.** Whoever joins a filter gets its retained messages;
//!   whoever held it already does not get them again.
//! - **The console's subscriptions** stand for the broker id: every session
//!   that comes up for it carries them, until the console unsubscribes or the
//!   broker is removed.
//! - **Changes.** The pool ticks when a session starts, ends or gets its link
//!   back.
//! - **The last settings win.** What the pool was last told about a broker id
//!   — its settings, as one `connect` or as part of a `sync` list, or that it
//!   is disconnected or removed — is what it ends up with, whatever order the
//!   attempts started on the way finish in.
//! - **Status.** Every change of a broker's status is reported, once: a first
//!   dial is `connecting`, a failed one `error`.
//! - **Last words.** A session that is ended on purpose publishes what it was
//!   left to say before its link is closed.
//! - **A link that stalls** fails its write in time and is repaired like one
//!   that dropped.
//!
//! No test races the client's reconnect delay: a test that acts while a link
//! is down uses a pool that [never](NEVER) reconnects by itself, a test that
//! watches a client repair its link waits for the broker to see it.

use app_lib::mqtt::broker::{
    BrokerConfig, ConnectionStatus, MessageCallback, MqttMessage, ReconnectConfig, Subscriber,
};
use app_lib::mqtt::commands::report_broker_statuses;
use app_lib::mqtt::broker::LastWord;
use app_lib::mqtt::MqttManager;
use app_lib::runtime::cloud_performer::CloudPerformer;
use app_lib::runtime::host::HostEvents;
use app_lib::runtime::services::MqttBrokers;
use microflow_core::runtime::SubscriberWiring;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

#[path = "support/fake_broker.rs"]
mod fake_broker;
use fake_broker::{published, subscribed, unsubscribed, FakeBroker, Heard, Relay, Seen, PATIENCE, PUBLISH, SUBSCRIBE};

/// A reconnect delay no test lives to see: the link stays down until the test
/// connects it.
const NEVER: Duration = Duration::from_secs(3600);

/// A reconnect delay for tests that watch a client repair its own link.
const SOON: Duration = Duration::from_millis(100);

/// A pool whose clients try to repair a dropped link every `delay`.
fn pool_reconnecting(delay: Duration) -> MqttManager {
    pool(delay, PATIENCE)
}

/// A pool whose clients try to repair a dropped link every `delay`, and give
/// a connection attempt `connect_timeout` to get its answer.
fn pool(delay: Duration, connect_timeout: Duration) -> MqttManager {
    MqttManager::with_reconnect_config(ReconnectConfig {
        initial_delay: delay,
        max_delay: delay,
        multiplier: 1.0,
        max_attempts: None,
        connect_timeout,
        ..ReconnectConfig::default()
    })
}

/// What one subscriber received, as payload text.
#[derive(Clone, Default)]
struct Inbox(Arc<Mutex<Vec<String>>>);

impl Inbox {
    fn callback(&self) -> MessageCallback {
        let inbox = Arc::clone(&self.0);
        Arc::new(move |message: MqttMessage| {
            inbox.lock().unwrap().push(String::from_utf8_lossy(&message.payload).to_string());
        })
    }

    fn received(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }

    /// Poll until `count` messages arrived.
    async fn wait_for(&self, count: usize) {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while self.received().len() < count {
            assert!(tokio::time::Instant::now() < deadline, "received only {:?}", self.received());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

fn texts(payloads: &[&str]) -> Vec<String> {
    payloads.iter().map(ToString::to_string).collect()
}

fn ignore() -> MessageCallback {
    Arc::new(|_| {})
}

/// Poll until broker `b`'s link is (not) up.
async fn wait_until_online(manager: &MqttManager, online: bool) {
    // Bounded as a whole: a pool that does not answer must fail the test too.
    let reached = tokio::time::timeout(PATIENCE, async {
        while !manager.session("b").await.is_some_and(|session| session.online == online) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    assert!(reached.await.is_ok(), "broker b never became online={online}");
}

/// Cut the broker's links and wait until the pool has noticed. For a pool that
/// [never](NEVER) reconnects by itself: the link then stays down.
async fn take_the_link_down(broker: &FakeBroker, manager: &MqttManager) {
    broker.cut_links();
    wait_until_online(manager, false).await;
}

/// Whether the pool ticked since the last call.
fn ticked(changes: &mut watch::Receiver<u64>) -> bool {
    let ticked = changes.has_changed().expect("the pool is alive");
    changes.mark_unchanged();
    ticked
}

// --- sessions ------------------------------------------------------------------

#[tokio::test]
async fn a_dropped_link_keeps_the_session_and_ticks_nothing() {
    let broker = FakeBroker::start().await;
    let manager = pool_reconnecting(NEVER);
    let mut changes = manager.changes();
    manager.connect(broker.config()).await.expect("connect");
    assert!(ticked(&mut changes), "a session started");
    let session = manager.session("b").await.expect("a session");
    assert!(session.online);
    assert_eq!(
        manager.subscribe("b", "t", Subscriber::Flow, ignore()).await,
        Ok(session.id),
        "subscribe names its session"
    );

    take_the_link_down(&broker, &manager).await;

    assert_eq!(manager.session("b").await.map(|s| s.id), Some(session.id), "offline, the same session");
    assert!(!ticked(&mut changes), "a link going down opens nothing up");
}

#[tokio::test]
async fn a_client_repairs_its_link_and_subscribes_what_it_held_again() {
    let broker = FakeBroker::start().await;
    let manager = pool_reconnecting(SOON);
    let mut changes = manager.changes();
    manager.connect(broker.config()).await.expect("connect");
    let session = manager.session("b").await.expect("a session");
    manager.subscribe("b", "t", Subscriber::Flow, ignore()).await.expect("subscribe");
    broker.wait_until_seen(2).await;
    assert!(ticked(&mut changes), "a session started");

    broker.cut_links();
    broker.wait_until_seen(4).await;

    assert_eq!(
        broker.seen(),
        vec![Seen::Connected(1), subscribed(1, "t"), Seen::Connected(2), subscribed(2, "t")],
        "the client subscribed what it held again"
    );
    tokio::time::timeout(PATIENCE, changes.changed()).await.expect("a tick: the link came back").expect("alive");
    assert_eq!(
        manager.session("b").await.map(|s| (s.id, s.online)),
        Some((session.id, true)),
        "repaired, the same session"
    );
}

#[tokio::test]
async fn a_reconnected_broker_is_a_new_session() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    let mut changes = manager.changes();
    manager.connect(broker.config()).await.expect("connect");
    let first = manager.session("b").await.expect("a session");
    assert!(ticked(&mut changes));

    manager.disconnect("b").await.expect("disconnect");
    assert_eq!(manager.session("b").await, None, "the pool no longer holds it");
    assert!(ticked(&mut changes), "the session ended");

    manager.connect(broker.config()).await.expect("connect again");
    let second = manager.session("b").await.expect("a session");
    assert_ne!(second.id, first.id);
}

#[tokio::test]
async fn a_connect_while_the_link_is_down_repairs_the_session() {
    let broker = FakeBroker::start().await;
    let manager = pool_reconnecting(NEVER);
    manager.connect(broker.config()).await.expect("connect");
    let session = manager.session("b").await.expect("a session");
    let (flow, console) = (Inbox::default(), Inbox::default());
    manager.subscribe("b", "t", Subscriber::Flow, flow.callback()).await.expect("subscribe");
    manager.subscribe("b", "t", Subscriber::Console, console.callback()).await.expect("subscribe");
    broker.wait_until_seen(3).await;

    // The link is down, and something connects the broker again (a flow
    // update, the broker settings sync).
    take_the_link_down(&broker, &manager).await;
    manager.connect(broker.config()).await.expect("connect again");

    assert_eq!(manager.session("b").await.map(|s| s.id), Some(session.id), "the same session, repaired sooner");
    broker.wait_until_seen(5).await;
    assert_eq!(
        broker.seen()[3..],
        [Seen::Connected(2), subscribed(2, "t")],
        "the new client took over what the old one held: one SUBSCRIBE for both subscribers"
    );
    broker.publish("t", b"hello");
    flow.wait_for(1).await;
    console.wait_for(1).await;
    assert_eq!((flow.received(), console.received()), (texts(&["hello"]), texts(&["hello"])));
}

#[tokio::test]
async fn a_connect_with_a_new_config_starts_a_session_without_the_flows_subscriptions() {
    let broker = FakeBroker::start().await;
    let manager = pool_reconnecting(NEVER);
    manager.connect(broker.config()).await.expect("connect");
    let first = manager.session("b").await.expect("a session");
    manager.subscribe("b", "flow/t", Subscriber::Flow, ignore()).await.expect("subscribe");
    broker.wait_until_seen(2).await;

    take_the_link_down(&broker, &manager).await;
    let changed = BrokerConfig { username: Some("someone".into()), password: Some("else".into()), ..broker.config() };
    manager.connect(changed).await.expect("connect again");

    let second = manager.session("b").await.expect("a session");
    assert_ne!(second.id, first.id);
    // A subscribe on the new session, to have something to wait for: anything
    // carried over would have reached the broker before it.
    manager.subscribe("b", "after", Subscriber::Flow, ignore()).await.expect("subscribe");
    broker.wait_until_seen(4).await;
    assert_eq!(
        broker.seen()[2..],
        [Seen::Connected(2), subscribed(2, "after")],
        "the flow's subscription was not carried over: whoever tracks it makes it again"
    );
}

/// A client that was retired while its link was down had a reconnect pending.
/// These two wait out that reconnect's delay and count the connections the
/// broker then has open: a retired client that came back would be one more,
/// for good. Had the client been in the middle of its reconnect when it was
/// retired (a stall longer than the delay), that link is closed as soon as it
/// is up — so the count holds either way, once it has settled. (That case has
/// tests of its own, with the reconnect held at the broker: see "the last
/// settings a broker id was given win".)
const RETIRED_CLIENTS_DELAY: Duration = Duration::from_millis(300);

#[tokio::test]
async fn a_client_replaced_while_its_link_was_down_does_not_come_back() {
    let broker = FakeBroker::start().await;
    let manager = pool_reconnecting(RETIRED_CLIENTS_DELAY);
    manager.connect(broker.config()).await.expect("connect");
    manager.subscribe("b", "t", Subscriber::Flow, ignore()).await.expect("subscribe");
    broker.wait_until_seen(2).await;

    broker.cut_links();
    wait_until_online(&manager, false).await;
    manager.connect(broker.config()).await.expect("connect again");

    tokio::time::sleep(RETIRED_CLIENTS_DELAY * 3).await;
    broker.wait_until_open(1).await;
    let subscribes = broker.seen().iter().filter(|seen| matches!(seen, Seen::Subscribed { .. })).count();
    assert_eq!(subscribes, 2, "the topic was subscribed on the first link and on its one successor");
}

#[tokio::test]
async fn a_client_disconnected_while_its_link_was_down_does_not_come_back() {
    let broker = FakeBroker::start().await;
    let manager = pool_reconnecting(RETIRED_CLIENTS_DELAY);
    manager.connect(broker.config()).await.expect("connect");

    broker.cut_links();
    wait_until_online(&manager, false).await;
    manager.disconnect("b").await.expect("disconnect");

    tokio::time::sleep(RETIRED_CLIENTS_DELAY * 3).await;
    broker.wait_until_open(0).await;
}

// --- subscribers ------------------------------------------------------------------

/// A pool connected to `broker` with the flow and the console both subscribed
/// to `t`, and the broker having seen it.
async fn shared_topic(broker: &FakeBroker, manager: &MqttManager) -> (Inbox, Inbox) {
    manager.connect(broker.config()).await.expect("connect");
    let (flow, console) = (Inbox::default(), Inbox::default());
    manager.subscribe("b", "t", Subscriber::Flow, flow.callback()).await.expect("subscribe");
    manager.subscribe("b", "t", Subscriber::Console, console.callback()).await.expect("subscribe");
    broker.wait_until_seen(3).await;
    (flow, console)
}

#[tokio::test]
async fn the_flow_and_the_console_share_a_topic_and_each_gets_its_own_delivery() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    let (flow, console) = shared_topic(&broker, &manager).await;

    broker.publish("t", b"one");
    flow.wait_for(1).await;
    console.wait_for(1).await;

    assert_eq!((flow.received(), console.received()), (texts(&["one"]), texts(&["one"])));
    assert_eq!(
        broker.seen(),
        vec![Seen::Connected(1), subscribed(1, "t"), subscribed(1, "t")],
        "each joiner sends a SUBSCRIBE: that is what replays the retained messages for it"
    );
}

#[tokio::test]
async fn the_console_unsubscribing_leaves_the_flow_subscribed() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    let (flow, console) = shared_topic(&broker, &manager).await;

    manager.unsubscribe("b", "t", Subscriber::Console).await.expect("unsubscribe");
    broker.publish("t", b"after");
    flow.wait_for(1).await;

    assert_eq!(flow.received(), texts(&["after"]));
    assert!(console.received().is_empty(), "the console let go");
    assert_eq!(broker.seen().len(), 3, "no UNSUBSCRIBE: the flow holds the topic");

    // The flow lets go too: now the broker is told.
    manager.unsubscribe("b", "t", Subscriber::Flow).await.expect("unsubscribe");
    broker.wait_until_seen(4).await;
    assert_eq!(broker.seen().last(), Some(&unsubscribed(1, "t")));
}

#[tokio::test]
async fn the_flow_unsubscribing_leaves_the_console_subscribed() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    let (flow, console) = shared_topic(&broker, &manager).await;

    manager.unsubscribe("b", "t", Subscriber::Flow).await.expect("unsubscribe");
    broker.publish("t", b"after");
    console.wait_for(1).await;

    assert_eq!(console.received(), texts(&["after"]));
    assert!(flow.received().is_empty(), "the flow let go");
    assert_eq!(broker.seen().len(), 3, "no UNSUBSCRIBE: the console holds the topic");
}

#[tokio::test]
async fn a_subscriber_subscribing_again_replaces_only_its_own_callback() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    let (flow, console) = shared_topic(&broker, &manager).await;

    // The flow's topic changes owner: a second flow subscribe, a new callback.
    let new_owner = Inbox::default();
    manager.subscribe("b", "t", Subscriber::Flow, new_owner.callback()).await.expect("subscribe");
    broker.publish("t", b"one");
    new_owner.wait_for(1).await;
    console.wait_for(1).await;

    assert!(flow.received().is_empty(), "the flow's old callback is gone");
    assert_eq!((new_owner.received(), console.received()), (texts(&["one"]), texts(&["one"])));
}

#[tokio::test]
async fn a_repaired_link_restores_every_subscriber() {
    let broker = FakeBroker::start().await;
    let manager = pool_reconnecting(SOON);
    let (flow, console) = shared_topic(&broker, &manager).await;

    broker.cut_links();
    broker.wait_until_seen(5).await;
    broker.publish("t", b"back");
    flow.wait_for(1).await;
    console.wait_for(1).await;

    assert_eq!(
        broker.seen()[3..],
        [Seen::Connected(2), subscribed(2, "t")],
        "one SUBSCRIBE restores the filter for both"
    );
    assert_eq!((flow.received(), console.received()), (texts(&["back"]), texts(&["back"])));
}

// --- retained messages ---------------------------------------------------------------
//
// Each test ends with a live publish that every subscriber must receive. It
// travels the same connection as the replay before it, so once it has arrived,
// whatever the replay was going to deliver has been delivered.

#[tokio::test]
async fn a_console_joining_a_flows_topic_gets_the_retained_value_and_the_flow_does_not_get_it_again() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    broker.retain("home/temp", b"21");
    let (flow, console) = (Inbox::default(), Inbox::default());
    manager.subscribe("b", "home/temp", Subscriber::Flow, flow.callback()).await.expect("subscribe");
    flow.wait_for(1).await;

    manager.subscribe("b", "home/temp", Subscriber::Console, console.callback()).await.expect("subscribe");
    console.wait_for(1).await;
    broker.publish("home/temp", b"22");
    flow.wait_for(2).await;
    console.wait_for(2).await;

    assert_eq!(console.received(), texts(&["21", "22"]), "the joiner sees the retained value at once");
    assert_eq!(flow.received(), texts(&["21", "22"]), "the flow node got it once, when it subscribed");
}

#[tokio::test]
async fn a_flow_node_joining_a_console_topic_gets_the_retained_value_and_the_console_does_not_get_it_again() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    broker.retain("home/temp", b"21");
    let (flow, console) = (Inbox::default(), Inbox::default());
    manager.subscribe("b", "home/temp", Subscriber::Console, console.callback()).await.expect("subscribe");
    console.wait_for(1).await;

    manager.subscribe("b", "home/temp", Subscriber::Flow, flow.callback()).await.expect("subscribe");
    flow.wait_for(1).await;
    broker.publish("home/temp", b"22");
    flow.wait_for(2).await;
    console.wait_for(2).await;

    assert_eq!(flow.received(), texts(&["21", "22"]));
    assert_eq!(console.received(), texts(&["21", "22"]));
}

#[tokio::test]
async fn a_flow_topic_that_changes_owner_gives_the_new_owner_the_retained_value() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    broker.retain("home/temp", b"21");
    let (old_owner, new_owner, console) = (Inbox::default(), Inbox::default(), Inbox::default());
    manager.subscribe("b", "home/temp", Subscriber::Flow, old_owner.callback()).await.expect("subscribe");
    manager.subscribe("b", "home/temp", Subscriber::Console, console.callback()).await.expect("subscribe");
    old_owner.wait_for(1).await;
    console.wait_for(1).await;

    manager.subscribe("b", "home/temp", Subscriber::Flow, new_owner.callback()).await.expect("subscribe");
    new_owner.wait_for(1).await;
    broker.publish("home/temp", b"22");
    new_owner.wait_for(2).await;
    console.wait_for(2).await;

    assert_eq!(new_owner.received(), texts(&["21", "22"]));
    assert_eq!(console.received(), texts(&["21", "22"]), "the console did not get the replay again");
    assert_eq!(old_owner.received(), texts(&["21"]), "the old owner is out");
}

#[tokio::test]
async fn joining_a_topic_without_a_retained_message_replays_nothing() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    let (flow, console) = shared_topic(&broker, &manager).await;

    broker.publish("t", b"one");
    broker.publish("t", b"two");
    flow.wait_for(2).await;
    console.wait_for(2).await;

    assert_eq!((flow.received(), console.received()), (texts(&["one", "two"]), texts(&["one", "two"])));
}

#[tokio::test]
async fn joining_a_wildcard_replays_each_retained_topic_to_the_joiner_only() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    broker.retain("home/hum", b"40");
    broker.retain("home/temp", b"21");
    let (flow, console) = (Inbox::default(), Inbox::default());
    manager.subscribe("b", "home/#", Subscriber::Flow, flow.callback()).await.expect("subscribe");
    flow.wait_for(2).await;

    manager.subscribe("b", "home/#", Subscriber::Console, console.callback()).await.expect("subscribe");
    console.wait_for(2).await;
    broker.publish("home/temp", b"22");
    flow.wait_for(3).await;
    console.wait_for(3).await;

    assert_eq!(console.received(), texts(&["40", "21", "22"]));
    assert_eq!(flow.received(), texts(&["40", "21", "22"]), "neither retained topic came twice");
}

#[tokio::test]
async fn a_replay_for_one_filter_is_not_news_to_an_overlapping_one() {
    // The console subscribes a plain topic the flow already covers with a
    // wildcard. The replay the console asked for matches the flow's filter
    // too; the flow has had that topic.
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    broker.retain("home/temp", b"21");
    let (flow, console) = (Inbox::default(), Inbox::default());
    manager.subscribe("b", "home/#", Subscriber::Flow, flow.callback()).await.expect("subscribe");
    flow.wait_for(1).await;

    manager.subscribe("b", "home/temp", Subscriber::Console, console.callback()).await.expect("subscribe");
    console.wait_for(1).await;
    broker.publish("home/temp", b"22");
    flow.wait_for(2).await;
    console.wait_for(2).await;

    assert_eq!(console.received(), texts(&["21", "22"]));
    assert_eq!(flow.received(), texts(&["21", "22"]));
}

#[tokio::test]
async fn a_repaired_link_replays_the_retained_value_to_every_subscriber_once() {
    // As it always did: a new connection is a new subscription for everyone.
    let broker = FakeBroker::start().await;
    let manager = pool_reconnecting(SOON);
    broker.retain("t", b"21");
    let (flow, console) = shared_topic(&broker, &manager).await;
    flow.wait_for(1).await;
    console.wait_for(1).await;

    broker.cut_links();
    broker.wait_until_seen(5).await;
    flow.wait_for(2).await;
    console.wait_for(2).await;
    broker.publish("t", b"22");
    flow.wait_for(3).await;
    console.wait_for(3).await;

    assert_eq!(flow.received(), texts(&["21", "21", "22"]));
    assert_eq!(console.received(), texts(&["21", "21", "22"]));
}

// --- the console's subscriptions stand for the broker id ---------------------------------

/// Subscribe the flow to `barrier` and wait until the broker has seen `count`
/// events: everything the pool sent before it has then been seen too.
async fn settle(broker: &FakeBroker, manager: &MqttManager, count: usize) {
    manager.subscribe("b", "barrier", Subscriber::Flow, ignore()).await.expect("subscribe");
    broker.wait_until_seen(count).await;
}

#[tokio::test]
async fn a_console_subscription_is_made_on_the_session_a_config_change_starts() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    let console = Inbox::default();
    manager.subscribe("b", "flow/t", Subscriber::Flow, ignore()).await.expect("subscribe");
    manager.subscribe("b", "console/t", Subscriber::Console, console.callback()).await.expect("subscribe");
    broker.wait_until_seen(3).await;

    // What a config edit is: disconnect, connect with the new config.
    manager.disconnect("b").await.expect("disconnect");
    let changed = BrokerConfig { username: Some("someone".into()), password: Some("else".into()), ..broker.config() };
    manager.connect(changed).await.expect("connect again");
    settle(&broker, &manager, 6).await;

    assert_eq!(
        broker.seen()[3..],
        [Seen::Connected(2), subscribed(2, "console/t"), subscribed(2, "barrier")],
        "the console's subscription, and not the flow's"
    );
    broker.publish("console/t", b"hello");
    console.wait_for(1).await;
    assert_eq!(console.received(), texts(&["hello"]));
}

#[tokio::test]
async fn a_console_subscription_stands_through_repeated_disconnects_and_is_made_once_each_time() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    let console = Inbox::default();
    manager.subscribe("b", "t", Subscriber::Console, console.callback()).await.expect("subscribe");

    for connection in 1..=3 {
        // The broker reads each connection on its own task: let it finish
        // with this one before the next one starts.
        broker.wait_until_seen(connection * 2).await;
        manager.disconnect("b").await.expect("disconnect");
        manager.connect(broker.config()).await.expect("connect again");
    }
    broker.wait_until_seen(8).await;

    assert_eq!(
        broker.seen(),
        vec![
            Seen::Connected(1),
            subscribed(1, "t"),
            Seen::Connected(2),
            subscribed(2, "t"),
            Seen::Connected(3),
            subscribed(3, "t"),
            Seen::Connected(4),
            subscribed(4, "t"),
        ]
    );
    broker.publish("t", b"one");
    broker.publish("t", b"two");
    console.wait_for(2).await;
    assert_eq!(console.received(), texts(&["one", "two"]), "one delivery each: nothing piled up");
}

#[tokio::test]
async fn a_console_subscription_ends_when_the_console_unsubscribes() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    manager.subscribe("b", "connected", Subscriber::Console, ignore()).await.expect("subscribe");
    manager.subscribe("b", "disconnected", Subscriber::Console, ignore()).await.expect("subscribe");

    // One while the broker is connected, one while it is not.
    manager.unsubscribe("b", "connected", Subscriber::Console).await.expect("unsubscribe");
    broker.wait_until_seen(4).await;
    manager.disconnect("b").await.expect("disconnect");
    manager.unsubscribe("b", "disconnected", Subscriber::Console).await.expect("unsubscribe");
    assert!(
        manager.unsubscribe("b", "disconnected", Subscriber::Console).await.is_err(),
        "nothing stands for it any more, and the broker is not connected"
    );

    manager.connect(broker.config()).await.expect("connect again");
    settle(&broker, &manager, 6).await;
    assert_eq!(
        broker.seen()[3..],
        [unsubscribed(1, "connected"), Seen::Connected(2), subscribed(2, "barrier")],
        "neither topic came back"
    );
}

#[tokio::test]
async fn a_console_subscription_let_go_of_while_the_link_is_down_is_not_made_again() {
    // The console lets go of its topics when its page is left, whatever the
    // broker is doing, and does not look at the answer.
    let broker = FakeBroker::start().await;
    let manager = pool_reconnecting(NEVER);
    manager.connect(broker.config()).await.expect("connect");
    let (console, flow) = (Inbox::default(), Inbox::default());
    manager.subscribe("b", "console/t", Subscriber::Console, console.callback()).await.expect("subscribe");
    broker.wait_until_seen(2).await;

    take_the_link_down(&broker, &manager).await;
    manager.unsubscribe("b", "console/t", Subscriber::Console).await.expect("the console let go");

    // The link is repaired (a flow update, a settings sync).
    manager.connect(broker.config()).await.expect("connect again");
    manager.subscribe("b", "flow/t", Subscriber::Flow, flow.callback()).await.expect("subscribe");
    broker.wait_until_seen(4).await;
    assert_eq!(
        broker.seen()[2..],
        [Seen::Connected(2), subscribed(2, "flow/t")],
        "the topic the console let go of was not subscribed again"
    );
    broker.publish("console/t", b"not for the console");
    broker.publish("flow/t", b"for the flow");
    flow.wait_for(1).await;
    assert!(console.received().is_empty(), "and delivers nothing: {:?}", console.received());
}

#[tokio::test]
async fn a_console_subscription_let_go_of_while_the_link_is_down_is_not_restored_by_the_client_either() {
    // The same, with the client repairing its link by itself.
    let broker = FakeBroker::start().await;
    let manager = pool_reconnecting(SOON);
    manager.connect(broker.config()).await.expect("connect");
    manager.subscribe("b", "console/t", Subscriber::Console, ignore()).await.expect("subscribe");
    manager.subscribe("b", "flow/t", Subscriber::Flow, ignore()).await.expect("subscribe");
    broker.wait_until_seen(3).await;

    // Silent, so that the link stays down until the console has let go.
    broker.go_silent();
    broker.cut_links();
    wait_until_online(&manager, false).await;
    manager.unsubscribe("b", "console/t", Subscriber::Console).await.expect("the console let go");
    broker.answer_again();

    broker.wait_until_seen(5).await;
    wait_until_online(&manager, true).await;
    settle(&broker, &manager, 6).await;
    assert_eq!(
        broker.seen()[3..],
        [Seen::Connected(2), subscribed(2, "flow/t"), subscribed(2, "barrier")],
        "the client restored the flow's topic, and not the console's"
    );
}

#[tokio::test]
async fn a_page_that_is_gone_takes_every_console_subscription_with_it() {
    // A reload of the webview: nothing on the old page ran to unsubscribe,
    // and the new one knows nothing of what the old one subscribed.
    let (up, down) = (FakeBroker::start().await, FakeBroker::start().await);
    let manager = pool_reconnecting(NEVER);
    manager.connect(up.config()).await.expect("connect");
    manager.connect(under("down", &down)).await.expect("connect");
    let (console, flow) = (Inbox::default(), Inbox::default());
    manager.subscribe("b", "console/t", Subscriber::Console, console.callback()).await.expect("subscribe");
    manager.subscribe("b", "shared/t", Subscriber::Console, console.callback()).await.expect("subscribe");
    manager.subscribe("b", "shared/t", Subscriber::Flow, flow.callback()).await.expect("subscribe");
    manager.subscribe("down", "console/t", Subscriber::Console, console.callback()).await.expect("subscribe");
    up.wait_until_seen(4).await;
    down.wait_until_seen(2).await;
    down.cut_links();
    let offline = tokio::time::timeout(PATIENCE, async {
        while manager.session("down").await.is_some_and(|session| session.online) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    offline.await.expect("the link went down");

    manager.forget_console().await;

    // The broker that is up is told about the topic only the console held.
    up.wait_until_seen(5).await;
    assert_eq!(up.seen()[4], unsubscribed(1, "console/t"));
    up.publish("console/t", b"one");
    up.publish("shared/t", b"two");
    flow.wait_for(1).await;
    assert_eq!(flow.received(), texts(&["two"]), "the flow keeps the topic it shared with the console");
    assert!(console.received().is_empty(), "the console gets nothing any more: {:?}", console.received());

    // And no session that comes up makes any of it again.
    manager.connect(under("down", &down)).await.expect("connect again");
    manager.subscribe("down", "barrier", Subscriber::Flow, ignore()).await.expect("subscribe");
    down.wait_until_seen(4).await;
    assert_eq!(down.seen()[2..], [Seen::Connected(2), subscribed(2, "barrier")]);
    assert!(manager.unsubscribe("b", "gone", Subscriber::Console).await.is_ok(), "letting go of nothing is no error");
}

#[tokio::test]
async fn a_removed_broker_takes_its_console_subscriptions_with_it() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    manager.subscribe("b", "t", Subscriber::Console, ignore()).await.expect("subscribe");
    broker.wait_until_seen(2).await;

    // Disconnected, the pool still knows the broker by what stands for it …
    manager.disconnect("b").await.expect("disconnect");
    assert_eq!(manager.all_broker_ids().await, vec!["b".to_string()]);
    // … until the settings sync removes it.
    manager.remove("b").await.expect("remove");
    assert_eq!(manager.all_broker_ids().await, [] as [String; 0]);

    // A broker added again under the same id starts clean.
    manager.connect(broker.config()).await.expect("connect again");
    settle(&broker, &manager, 4).await;
    assert_eq!(broker.seen()[2..], [Seen::Connected(2), subscribed(2, "barrier")]);
}

// --- a broker that does not answer ---------------------------------------------------------

/// The bound these tests give a connection attempt.
const CONNECT_BOUND: Duration = Duration::from_millis(300);

/// Poll until broker `b`'s client is in `status`.
async fn wait_until_status(manager: &MqttManager, status: ConnectionStatus) {
    // Bounded as a whole: a pool that does not answer must fail the test too.
    let reached = tokio::time::timeout(PATIENCE, async {
        while manager.status("b").await != status {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    assert!(reached.await.is_ok(), "broker b never was {status:?}");
}

/// The webview, for a performer nobody watches.
struct NoEvents;

impl HostEvents for NoEvents {
    fn emit<S: serde::Serialize + Clone>(&self, _event: &str, _payload: S) {}
}

/// A `CloudPerformer` on `manager`, as the app builds it.
fn performer_on(manager: &MqttManager) -> CloudPerformer {
    let (actor, _inbound) = tokio::sync::mpsc::unbounded_channel();
    let brokers: Arc<dyn MqttBrokers> = Arc::new(manager.clone());
    CloudPerformer::new(brokers, actor, NoEvents, tokio::runtime::Handle::current())
}

fn flow_wiring(topic: &str) -> Vec<(String, SubscriberWiring)> {
    vec![("n1".to_string(), SubscriberWiring::Plain { broker_id: "b".into(), topic: topic.into() })]
}

#[tokio::test]
async fn a_connect_to_a_broker_that_does_not_answer_fails_in_time_and_a_later_one_succeeds() {
    let broker = FakeBroker::start().await;
    broker.go_silent();
    let manager = pool(NEVER, CONNECT_BOUND);

    let refused = tokio::time::timeout(PATIENCE, manager.connect(broker.config())).await.expect("the connect returned");

    let reason = refused.expect_err("nothing answered");
    assert!(reason.contains("did not answer within"), "{reason}");
    assert_eq!(manager.session("b").await, None, "nothing was connected");

    broker.answer_again();
    manager.connect(broker.config()).await.expect("connect");
    assert!(manager.session("b").await.is_some_and(|session| session.online));
}

#[tokio::test]
async fn a_connect_that_hangs_does_not_hold_up_the_pool() {
    // One broker never answers and is given an hour to. Everything else the
    // pool is asked meanwhile is answered: were the pool locked for the length
    // of the attempt, none of it would return.
    let (silent, healthy) = (FakeBroker::start().await, FakeBroker::start().await);
    silent.go_silent();
    let manager = pool(NEVER, NEVER);
    let hanging = tokio::spawn({
        let (manager, config) = (manager.clone(), silent.config());
        async move { manager.connect(config).await }
    });

    let other = BrokerConfig { id: "other".into(), ..healthy.config() };
    tokio::time::timeout(PATIENCE, async {
        assert_eq!(manager.session("b").await, None);
        manager.connect(other).await.expect("the other broker connects");
        manager.subscribe("other", "t", Subscriber::Flow, ignore()).await.expect("and takes a subscribe");
    })
    .await
    .expect("the pool answered while a connect was hanging");
    assert!(!hanging.is_finished(), "the attempt is still waiting for its answer");

    hanging.abort();
}

#[tokio::test]
async fn a_reconnect_that_hangs_holds_up_neither_the_pool_nor_the_performer() {
    // The broker goes silent and its link drops: the client's reconnect gets
    // no answer, and is given an hour to. The client's lock is not held across
    // that wait — seeing the client `Connecting` at all is what shows it, and
    // a reconcile, which asks for the broker's session, goes through.
    let broker = FakeBroker::start().await;
    let manager = pool(SOON, NEVER);
    manager.connect(broker.config()).await.expect("connect");
    let session = manager.session("b").await.expect("a session");
    let performer = performer_on(&manager);

    broker.go_silent();
    broker.cut_links();

    tokio::time::timeout(PATIENCE, async {
        wait_until_status(&manager, ConnectionStatus::Connecting).await;
        assert_eq!(manager.session("b").await.map(|s| (s.id, s.online)), Some((session.id, false)));
        performer.reconcile(flow_wiring("t")).applied().await;
    })
    .await
    .expect("the pool and the performer answered while a reconnect was hanging");
    assert_eq!(broker.seen(), vec![Seen::Connected(1)], "offline: the performer left the broker alone");
}

#[tokio::test]
async fn a_reconnect_a_broker_does_not_answer_fails_in_time_and_a_later_one_recovers() {
    let broker = FakeBroker::start().await;
    let manager = pool(SOON, CONNECT_BOUND);
    manager.connect(broker.config()).await.expect("connect");
    let session = manager.session("b").await.expect("a session");
    let performer = performer_on(&manager);

    // Silent, and the link drops: every reconnect attempt runs into the bound.
    broker.go_silent();
    broker.cut_links();
    wait_until_status(&manager, ConnectionStatus::Error).await;
    assert_eq!(manager.session("b").await.map(|s| (s.id, s.online)), Some((session.id, false)));
    // The flow wants a topic meanwhile; the performer can only note it.
    performer.reconcile(flow_wiring("t")).applied().await;

    // The broker answers again: the reconnect cadence carried on, the next
    // attempt gets through, and the performer catches up on the pool's tick.
    broker.answer_again();
    wait_until_online(&manager, true).await;
    assert_eq!(manager.session("b").await.map(|s| s.id), Some(session.id), "the same session");
    let deadline = tokio::time::Instant::now() + PATIENCE;
    while !broker.seen().iter().any(|seen| matches!(seen, Seen::Subscribed { topic, .. } if topic == "t")) {
        assert!(tokio::time::Instant::now() < deadline, "the flow's topic was never subscribed: {:?}", broker.seen());
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// --- a link that stalls -------------------------------------------------------------------------------
//
// A link can stop taking what is written to it without dropping: the other
// side no longer reads, and TCP gives up only after minutes.

/// A pool whose writes are given 300 ms, and whose clients repair a link
/// [soon](SOON).
fn pool_with_a_short_write_bound() -> MqttManager {
    MqttManager::with_reconnect_config(ReconnectConfig {
        initial_delay: SOON,
        max_delay: SOON,
        multiplier: 1.0,
        connect_timeout: CONNECT_BOUND,
        write_timeout: Duration::from_millis(300),
        ..ReconnectConfig::default()
    })
}

/// The broker stops reading, and the pool publishes to it until a write
/// stalls. Returns why that write failed.
async fn stall_the_link(broker: &FakeBroker, manager: &MqttManager) -> String {
    // Publishes pile up in the socket until it takes no more; the one that
    // does not fit must not wait for ever.
    broker.go_deaf();
    let chunk = vec![0_u8; 256 * 1024];
    for _ in 0..400 {
        let written = tokio::time::timeout(PATIENCE, manager.publish("b", "t", &chunk, false));
        if let Err(reason) = written.await.expect("a write that stalls returns") {
            return reason;
        }
    }
    panic!("the socket took a hundred megabytes without stalling");
}

#[tokio::test]
async fn a_write_that_stalls_fails_in_time_and_its_link_is_treated_as_dropped() {
    let broker = FakeBroker::start().await;
    let manager = pool_with_a_short_write_bound();
    manager.connect(broker.config()).await.expect("connect");
    let session = manager.session("b").await.expect("a session");
    manager.subscribe("b", "t", Subscriber::Flow, ignore()).await.expect("subscribe");
    broker.wait_until_seen(2).await;

    let reason = stall_the_link(&broker, &manager).await;
    assert!(reason.contains("stalled"), "{reason}");

    // Whoever asks about the broker is answered, and told its link is down;
    // a write on it is refused at once instead of stalling in turn.
    tokio::time::timeout(PATIENCE, async {
        assert_eq!(manager.session("b").await.map(|s| (s.id, s.online)), Some((session.id, false)));
        assert!(manager.publish("b", "t", b"x", false).await.is_err());
    })
    .await
    .expect("the pool answered");

    // The client repairs the link as it does one that dropped: the stalled
    // connection goes, the broker reads again, and the session is back with
    // what it held.
    broker.cut_links();
    broker.listen_again();
    wait_until_online(&manager, true).await;
    assert_eq!(manager.session("b").await.map(|s| s.id), Some(session.id), "the same session");
    let deadline = tokio::time::Instant::now() + PATIENCE;
    while !broker.seen().iter().any(|seen| matches!(seen, Seen::Subscribed { connection, .. } if *connection > 1)) {
        assert!(tokio::time::Instant::now() < deadline, "the topic was not subscribed again: {:?}", broker.seen());
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn a_link_that_stalled_is_repaired_by_the_client_although_nothing_dropped_it() {
    // The broker reads again, and nothing closes the stalled connection: the
    // client gave it up when the write stalled, and opens another by itself.
    let broker = FakeBroker::start().await;
    let manager = pool_with_a_short_write_bound();
    manager.connect(broker.config()).await.expect("connect");
    let session = manager.session("b").await.expect("a session");
    stall_the_link(&broker, &manager).await;

    broker.listen_again();

    wait_until_online(&manager, true).await;
    assert_eq!(manager.session("b").await.map(|s| s.id), Some(session.id), "the same session");
    assert!(broker.seen().contains(&Seen::Connected(2)), "on a link of its own: {:?}", broker.seen());
}

/// How many flow topics [`a_link_that_stalls_while_its_subscriptions_are_made_again_is_repaired_too`]
/// holds, each [`LONG_TOPIC`] bytes long: more than a socket takes, sent again
/// after a reconnect.
const LONG_TOPICS: usize = 400;
const LONG_TOPIC: usize = 60_000;

#[tokio::test]
async fn a_link_that_stalls_while_its_subscriptions_are_made_again_is_repaired_too() {
    // The link drops and the client repairs it. On the new link the broker
    // stops reading in the middle of the SUBSCRIBEs that make the client's
    // topics again: that link stalls too, and is repaired in turn.
    let broker = FakeBroker::start().await;
    let relay = Relay::start(&broker).await;
    let manager = pool_with_a_short_write_bound();
    manager.connect(relay.config()).await.expect("connect");
    for n in 0..LONG_TOPICS {
        let topic = format!("{n:05}/{}", "t".repeat(LONG_TOPIC));
        manager.subscribe("b", &topic, Subscriber::Flow, ignore()).await.expect("subscribe");
    }
    broker.wait_until_seen(1 + LONG_TOPICS).await;

    relay.hold_at(SUBSCRIBE);
    broker.cut_links();
    relay.wait_until_holding(1).await;
    // Answered once the client has let go of making them again: the write
    // that did not fit stalled.
    wait_until_status(&manager, ConnectionStatus::Disconnected).await;
    relay.go_on();

    relay.wait_until_connected(3).await;
    wait_until_online(&manager, true).await;
}

#[tokio::test]
async fn a_client_stops_repairing_its_link_after_the_attempts_it_is_allowed() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::with_reconnect_config(ReconnectConfig {
        initial_delay: SOON,
        max_delay: SOON,
        multiplier: 1.0,
        max_attempts: Some(3),
        connect_timeout: CONNECT_BOUND,
        ..ReconnectConfig::default()
    });
    manager.connect(broker.config()).await.expect("connect");

    // Silent, and the link drops: every attempt runs into the bound.
    broker.go_silent();
    broker.cut_links();
    broker.wait_until_taken(4).await;
    broker.wait_until_waiting(0).await;

    // Several more rounds of delay and bound pass, and no fourth attempt.
    tokio::time::sleep((SOON + CONNECT_BOUND) * 3).await;
    assert_eq!(broker.taken(), 4, "the first connection, and three attempts to repair it");
    assert_eq!(manager.status("b").await, ConnectionStatus::Error);

    // A `connect` still brings it back, in the session it had.
    let session = manager.session("b").await.expect("the session stands");
    broker.answer_again();
    manager.connect(broker.config()).await.expect("connect");
    assert_eq!(manager.session("b").await.map(|s| (s.id, s.online)), Some((session.id, true)));
}

// --- the last settings a broker id was given win ----------------------------------------------
//
// An attempt can take as long as the connect timeout, and the settings of its
// broker can be replaced or withdrawn meanwhile. These tests give an attempt an
// hour, and hold it at a broker that says nothing until the test lets it.

/// `manager.connect(config)`, on its own task.
fn connecting(manager: &MqttManager, config: BrokerConfig) -> tokio::task::JoinHandle<Result<(), String>> {
    let manager = manager.clone();
    tokio::spawn(async move { manager.connect(config).await })
}

/// How a `connect` on its own task ended. It has to end.
async fn outcome(attempt: tokio::task::JoinHandle<Result<(), String>>) -> Result<(), String> {
    tokio::time::timeout(PATIENCE, attempt).await.expect("the connect returned").expect("the connect ran")
}

#[tokio::test]
async fn settings_given_while_an_older_attempt_is_dialling_win_and_the_older_attempt_is_given_up() {
    let (old, new) = (FakeBroker::start().await, FakeBroker::start().await);
    old.go_silent();
    let manager = pool(NEVER, NEVER);
    let stale = connecting(&manager, old.config());
    old.wait_until_waiting(1).await;

    // The settings of broker `b` now name the other host.
    manager.connect(new.config()).await.expect("the newer settings connect");
    let session = manager.session("b").await.expect("a session");

    // The older attempt is given up at once — its host has still said nothing —
    // and its caller is not told that the broker is connected as it asked.
    old.wait_until_waiting(0).await;
    assert!(outcome(stale).await.is_err(), "a connect for settings that were replaced did not succeed");

    // The old host answering now changes nothing: nobody is listening.
    old.answer_again();
    settle(&new, &manager, 2).await;
    assert_eq!(manager.session("b").await, Some(session), "the session on the newer settings stands");
    assert!(!manager.config_changed("b", &new.config()).await, "the pool is on the newer settings");
    assert!(old.seen().is_empty(), "the old host never had a connection: {:?}", old.seen());
}

#[tokio::test]
async fn of_settings_given_one_after_another_the_last_is_connected_and_no_other_link_is_left() {
    // A password being typed: every keystroke is a new config for the same
    // broker id, on a host that takes a while to answer.
    let broker = FakeBroker::start().await;
    broker.go_silent();
    let manager = pool(NEVER, NEVER);
    let mut changes = manager.changes();
    let typed: Vec<BrokerConfig> = (1..=8)
        .map(|length| BrokerConfig { username: Some("u".into()), password: Some("p".repeat(length)), ..broker.config() })
        .collect();

    let mut attempts = Vec::new();
    for (index, config) in typed.iter().enumerate() {
        attempts.push(connecting(&manager, config.clone()));
        // Each attempt gets as far as waiting for its answer before the next
        // keystroke.
        broker.wait_until_held(index + 1).await;
    }
    broker.wait_until_waiting(1).await;

    broker.answer_again();
    let mut outcomes = Vec::new();
    for attempt in attempts {
        outcomes.push(outcome(attempt).await.is_ok());
    }
    assert_eq!(outcomes, [false, false, false, false, false, false, false, true], "only the last one connected");
    broker.wait_until_open(1).await;
    assert_eq!(broker.seen(), vec![Seen::Connected(8)], "the one link the broker answered is the last one");
    assert!(!manager.config_changed("b", &typed[7]).await, "the pool is on the last settings");
    assert!(ticked(&mut changes), "a session started");
    assert_eq!(*changes.borrow(), 1, "one session started, and nothing else happened");
}

#[tokio::test]
async fn a_broker_removed_while_it_is_dialling_stays_out_of_the_pool() {
    let broker = FakeBroker::start().await;
    broker.go_silent();
    let manager = pool(NEVER, NEVER);
    let attempt = connecting(&manager, broker.config());
    broker.wait_until_waiting(1).await;
    assert_eq!(
        manager.all_broker_ids().await,
        vec!["b".to_string()],
        "a broker that is only dialling is one the pool knows"
    );

    // The broker is deleted from the settings.
    manager.remove("b").await.expect("remove");

    broker.wait_until_waiting(0).await;
    assert!(outcome(attempt).await.is_err(), "the attempt was given up");
    broker.answer_again();
    assert_eq!(manager.session("b").await, None, "a removed broker is not in the pool");
    assert_eq!(manager.all_broker_ids().await, [] as [String; 0]);
    assert!(broker.seen().is_empty(), "and never had a connection: {:?}", broker.seen());
}

#[tokio::test]
async fn a_broker_disconnected_while_it_is_dialling_stays_disconnected() {
    let broker = FakeBroker::start().await;
    broker.go_silent();
    let manager = pool(NEVER, NEVER);
    let attempt = connecting(&manager, broker.config());
    broker.wait_until_waiting(1).await;

    manager.disconnect("b").await.expect("disconnect");

    broker.wait_until_waiting(0).await;
    assert!(outcome(attempt).await.is_err(), "the attempt was given up");
    broker.answer_again();
    assert_eq!(manager.session("b").await, None, "a disconnected broker is not connected");

    // It can be connected again as any other.
    manager.connect(broker.config()).await.expect("connect");
    assert!(manager.session("b").await.is_some_and(|session| session.online));
    broker.wait_until_open(1).await;
}

#[tokio::test]
async fn changed_settings_end_the_session_on_the_old_ones_before_the_new_host_has_answered() {
    // The broker is not left running on settings the user no longer sees while
    // the new ones are tried — however long that takes, and however it ends.
    let (first, second) = (FakeBroker::start().await, FakeBroker::start().await);
    let manager = pool(NEVER, NEVER);
    manager.connect(first.config()).await.expect("connect");
    let before = manager.session("b").await.expect("a session");
    manager.subscribe("b", "flow/t", Subscriber::Flow, ignore()).await.expect("subscribe");
    first.wait_until_seen(2).await;

    second.go_silent();
    let changed = connecting(&manager, second.config());
    second.wait_until_waiting(1).await;
    first.wait_until_open(0).await;
    assert_eq!(manager.session("b").await, None, "the session on the old settings ended");

    second.answer_again();
    outcome(changed).await.expect("the new settings connect");
    let after = manager.session("b").await.expect("a session");
    assert_ne!(after.id, before.id, "a new session");
    settle(&second, &manager, 2).await;
    assert_eq!(
        second.seen(),
        vec![Seen::Connected(1), subscribed(1, "barrier")],
        "holding none of the flow's subscriptions of the old one"
    );
}

#[tokio::test]
async fn a_client_disconnected_in_the_middle_of_its_reconnect_closes_the_link_it_was_opening() {
    // The broker goes silent and the link drops: the client's own reconnect is
    // waiting for its answer when the broker is disconnected.
    let broker = FakeBroker::start().await;
    let manager = pool(SOON, NEVER);
    manager.connect(broker.config()).await.expect("connect");
    broker.go_silent();
    broker.cut_links();
    broker.wait_until_waiting(1).await;

    manager.disconnect("b").await.expect("disconnect");

    // The answer comes after all. The link it completes belongs to nobody.
    broker.answer_again();
    broker.wait_until_seen(2).await;
    broker.wait_until_open(0).await;
    assert_eq!(manager.session("b").await, None);
}

#[tokio::test]
async fn a_client_replaced_in_the_middle_of_its_reconnect_closes_the_link_it_was_opening() {
    let broker = FakeBroker::start().await;
    let manager = pool(SOON, NEVER);
    manager.connect(broker.config()).await.expect("connect");
    broker.go_silent();
    broker.cut_links();
    broker.wait_until_waiting(1).await;

    // New settings for the broker: the old client is retired while its
    // reconnect waits, and a new one dials beside it.
    let changed = BrokerConfig { username: Some("someone".into()), password: Some("else".into()), ..broker.config() };
    let replacing = connecting(&manager, changed);
    broker.wait_until_waiting(2).await;

    broker.answer_again();
    outcome(replacing).await.expect("the new settings connect");
    broker.wait_until_seen(3).await;
    broker.wait_until_open(1).await;
    assert!(manager.session("b").await.is_some_and(|session| session.online));
}

/// More than a socket takes: a write this large holds its writer until the
/// other side reads.
const LARGER_THAN_A_SOCKET: usize = 32 * 1024 * 1024;

/// Lock the pool for reading, until `relay.go_on()`: a publish to broker `x`
/// — reached through `relay` — too large for the socket, which the relay
/// stops reading at its first bytes. A publish holds the pool for the length
/// of its write.
async fn lock_the_pool(manager: &MqttManager, relay: &Relay) -> tokio::task::JoinHandle<Result<(), String>> {
    manager.connect(BrokerConfig { id: "x".into(), ..relay.config() }).await.expect("connect");
    relay.hold_at(PUBLISH);
    let writing = tokio::spawn({
        let manager = manager.clone();
        async move { manager.publish("x", "large", &vec![0_u8; LARGER_THAN_A_SOCKET], false).await }
    });
    relay.wait_until_holding(1).await;
    writing
}

#[tokio::test]
async fn an_attempt_whose_settings_are_withdrawn_while_it_waits_for_the_pool_is_given_up() {
    // The broker answers, and the attempt that opened the link waits for the
    // pool to take it in. The broker is disconnected meanwhile.
    let (other, broker) = (FakeBroker::start().await, FakeBroker::start().await);
    let relay = Relay::start(&other).await;
    let manager = pool(NEVER, NEVER);
    broker.go_silent();
    let attempt = connecting(&manager, broker.config());
    broker.wait_until_waiting(1).await;
    let writing = lock_the_pool(&manager, &relay).await;

    let mut statuses = manager.status_changes();
    statuses.borrow_and_update();
    broker.answer_again();
    // The client took the link: the attempt is waiting for the pool now.
    statuses.changed().await.expect("the pool is alive");
    let (left, ()) = tokio::join!(manager.disconnect("b"), async { relay.go_on() });
    left.expect("disconnect");

    assert!(outcome(attempt).await.is_err(), "the broker was disconnected before it was connected as asked");
    writing.await.expect("the publish ran").expect("the publish went through");
    assert_eq!(manager.session("b").await, None, "a disconnected broker is not in the pool");
    broker.wait_until_open(0).await;
}

#[tokio::test]
async fn a_connect_made_while_a_disconnect_waits_for_the_pool_keeps_the_session() {
    // A disconnect, and then — before the disconnect has the pool — a connect
    // with the settings the broker is on: the connect came last.
    let (other, broker) = (FakeBroker::start().await, FakeBroker::start().await);
    let relay = Relay::start(&other).await;
    let manager = pool(NEVER, NEVER);
    manager.connect(broker.config()).await.expect("connect");
    let session = manager.session("b").await.expect("a session");
    let writing = lock_the_pool(&manager, &relay).await;

    let (left, back, ()) = tokio::join!(
        manager.disconnect("b"),
        async { manager.connect(broker.config()).await },
        async { relay.go_on() },
    );
    left.expect("disconnect");
    back.expect("the broker is connected as the last call asked");

    writing.await.expect("the publish ran").expect("the publish went through");
    assert_eq!(manager.session("b").await, Some(session), "the session stands");
    assert_eq!(manager.status("b").await, ConnectionStatus::Connected);
    settle(&broker, &manager, 2).await;
    assert_eq!(broker.seen(), vec![Seen::Connected(1), subscribed(1, "barrier")], "on its one link");
    assert!(broker.heard().is_empty(), "and nothing said goodbye on it: {:?}", broker.heard());
}

#[tokio::test]
async fn settings_typed_and_deleted_again_leave_the_session_on_them_alone() {
    // A character typed into the settings and deleted again: the broker is
    // on A, is given B, then A again. The attempts for both run after both
    // calls were made, in either order.
    for newest_first in [false, true] {
        let (a, b) = (FakeBroker::start().await, FakeBroker::start().await);
        let manager = pool(NEVER, NEVER);
        manager.connect(a.config()).await.expect("connect");
        let session = manager.session("b").await.expect("a session");

        let typed = manager.connect(b.config());
        let deleted = manager.connect(a.config());
        let (typed, deleted) = if newest_first {
            let deleted = deleted.await;
            (typed.await, deleted)
        } else {
            let typed = typed.await;
            (typed, deleted.await)
        };

        assert!(typed.is_err(), "settings that were replaced did not connect");
        deleted.expect("the broker is on the settings it was given last");
        assert_eq!(manager.session("b").await, Some(session), "the session on A stands (newest first: {newest_first})");
        assert_eq!(b.taken(), 0, "B was never dialled");
        settle(&a, &manager, 2).await;
        assert!(a.heard().is_empty(), "nothing said goodbye on A: {:?}", a.heard());
    }
}

// --- a session that is ended on purpose says its last words -------------------------------------
//
// The `CloudPerformer` announces Studio to the design-tool plugins of a Bridge
// ID with a retained `connected`. When the broker is then removed, or given
// other settings, or the app quits, the retained status must not stay behind
// for a Studio that is gone: the performer leaves the `disconnected` with the
// pool, and the pool publishes it before it closes the link. Should the link
// end without a goodbye, the broker publishes it: the first of the words is
// the link's will, and the pool renews a link that is up to carry it.

/// The retained status topic of Bridge ID `uid_1`, and the topic Studio asks for
/// its variables on.
const BRIDGE_STATUS: &str = "microflow/uid_1/app/status";
const BRIDGE_REQUEST: &str = "microflow/uid_1/app/variables/request";

/// A design node's wiring for Bridge ID `uid_1` on broker `b`.
fn bridge_wiring() -> Vec<(String, SubscriberWiring)> {
    let topic = "microflow/uid_1/figma/variable/1-2".to_string();
    vec![("fig".to_string(), SubscriberWiring::TopicAware { broker_id: "b".into(), topic })]
}

/// What a broker hears on `connection` when Studio is announced for `uid_1`.
fn announced_on(connection: usize) -> Vec<Heard> {
    vec![published(connection, BRIDGE_STATUS, "connected", true), published(connection, BRIDGE_REQUEST, "", false)]
}

/// The `disconnected` of `uid_1`, heard on `connection`.
fn goodbye_on(connection: usize) -> Heard {
    published(connection, BRIDGE_STATUS, "disconnected", true)
}

/// Announce Studio for `uid_1` on broker `b`, connected on its first link, and
/// wait until the pool has renewed the link to carry the goodbye as its will:
/// the old link said DISCONNECT, and the broker heard
/// `[announced_on(1), Disconnected(1)]`. Studio is announced on link 2.
async fn announce(broker: &FakeBroker, manager: &MqttManager) -> CloudPerformer {
    let performer = performer_on(manager);
    // The goodbye is left with the pool before Studio is announced, and the
    // link that is to carry it is opened then. Its CONNECT is held until the
    // announcement is out, which therefore goes out on link 1 — not on
    // whichever link is up at the moment it is written.
    broker.go_silent();
    performer.reconcile(bridge_wiring()).applied().await;
    broker.answer_again();
    broker.wait_until_heard(3).await;
    assert_eq!(broker.heard(), [announced_on(1), vec![Heard::Disconnected(1)]].concat());
    performer
}

#[tokio::test]
async fn a_link_on_which_studio_is_announced_carries_its_goodbye_as_its_will() {
    let broker = FakeBroker::start().await;
    let relay = Relay::start(&broker).await;
    let manager = MqttManager::new();
    manager.connect(relay.config()).await.expect("connect");
    let session = manager.session("b").await.expect("a session");
    broker.retain("t", b"21");
    let console = Inbox::default();
    manager.subscribe("b", "t", Subscriber::Console, console.callback()).await.expect("subscribe");
    console.wait_for(1).await;

    let performer = announce(&broker, &manager).await;

    let will = Some((BRIDGE_STATUS.to_string(), "disconnected".to_string(), true));
    assert_eq!(relay.wills(), [(1, None), (2, will)].into_iter().collect(), "a new link, with the will");
    broker.wait_until_open(1).await;
    // The session carried on without noticing: the same one, up throughout,
    // holding what it held — and the retained value its new link replayed
    // was not news to the subscriber that had it.
    assert_eq!(manager.session("b").await.map(|s| (s.id, s.online)), Some((session.id, true)));
    broker.publish("t", b"22");
    console.wait_for(2).await;
    assert_eq!(console.received(), texts(&["21", "22"]));

    // Studio leaves the broker: its link no longer carries the goodbye.
    performer.reconcile(Vec::new()).applied().await;
    relay.wait_until_connected(3).await;
    assert_eq!(relay.wills().get(&3), Some(&None));
    broker.wait_until_heard(5).await;
    assert_eq!(broker.heard()[3..], [goodbye_on(2), Heard::Disconnected(2)]);
}

#[tokio::test]
async fn a_renewed_link_lets_go_of_the_old_one_only_once_the_broker_took_its_subscriptions() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    let console = Inbox::default();
    manager.subscribe("b", "t", Subscriber::Console, console.callback()).await.expect("subscribe");
    // As `announce`: the new link's CONNECT is held until Studio is announced
    // on the old one, which has subscribed the design node's topic by then.
    let performer = performer_on(&manager);
    broker.go_silent();
    performer.reconcile(bridge_wiring()).applied().await;
    broker.wait_until_seen(3).await;
    // From here on the broker is under load: a subscription comes to be well
    // after its SUBSCRIBE was written. Only the new link subscribes.
    broker.answer_subscribes_after(Duration::from_millis(300));
    broker.answer_again();
    broker.wait_until_heard(3).await;
    assert_eq!(broker.heard(), [announced_on(1), vec![Heard::Disconnected(1)]].concat());

    // The old link is gone, so the new one holds `t` at the broker: a message
    // published now reaches the console.
    broker.wait_until_open(1).await;
    broker.publish("t", b"22");
    console.wait_for(1).await;
    assert_eq!(console.received(), texts(&["22"]));
}

#[tokio::test]
async fn a_removed_broker_is_told_that_studio_left_before_its_link_is_closed() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    let _performer = announce(&broker, &manager).await;

    manager.remove("b").await.expect("remove");

    broker.wait_until_heard(5).await;
    assert_eq!(broker.heard()[3..], [goodbye_on(2), Heard::Disconnected(2)], "`disconnected` when the link closes");
}

#[tokio::test]
async fn a_disconnected_broker_is_told_that_studio_left_too() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    let _performer = announce(&broker, &manager).await;

    manager.disconnect("b").await.expect("disconnect");

    broker.wait_until_heard(5).await;
    assert_eq!(broker.heard()[3..], [goodbye_on(2), Heard::Disconnected(2)]);
}

#[tokio::test]
async fn a_broker_given_other_settings_is_told_that_studio_left_on_the_old_ones_and_arrived_on_the_new() {
    let (old, new) = (FakeBroker::start().await, FakeBroker::start().await);
    let manager = MqttManager::new();
    manager.connect(old.config()).await.expect("connect");
    let _performer = announce(&old, &manager).await;

    manager.connect(new.config()).await.expect("the new settings connect");

    old.wait_until_heard(5).await;
    assert_eq!(old.heard()[3..], [goodbye_on(2), Heard::Disconnected(2)]);
    // The new session starts as any other: the performer hears of it from the
    // pool, subscribes, and announces Studio — and its link is renewed to
    // carry the will.
    new.wait_until_heard(3).await;
    assert_eq!(new.heard(), [announced_on(1), vec![Heard::Disconnected(1)]].concat());
}

#[tokio::test]
async fn a_repaired_link_is_told_again_that_studio_is_there() {
    // A broker that restarted has forgotten a retained status it did not
    // persist, and what the plugins sent while the link was down never
    // reached Studio.
    let broker = FakeBroker::start().await;
    let manager = pool_reconnecting(SOON);
    manager.connect(broker.config()).await.expect("connect");
    let _performer = announce(&broker, &manager).await;

    broker.cut_links();

    broker.wait_until_heard(5).await;
    assert_eq!(broker.heard()[3..], announced_on(3), "on the link that replaced link 2");
}

#[tokio::test]
async fn closing_every_broker_tells_each_that_studio_left() {
    // What quitting the app does, within a bound of its own.
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    let _performer = announce(&broker, &manager).await;

    manager.disconnect_all().await.expect("closed");

    broker.wait_until_heard(5).await;
    assert_eq!(broker.heard()[3..], [goodbye_on(2), Heard::Disconnected(2)]);
}

#[tokio::test]
async fn closing_every_broker_closes_them_all_at_once() {
    // One link that takes long to say its goodbye holds up none of the
    // others: the bound on quitting is one goodbye's, not the sum of them.
    let (first, second) = (FakeBroker::start().await, FakeBroker::start().await);
    let (first_relay, second_relay) = (Relay::start(&first).await, Relay::start(&second).await);
    let manager = pool(NEVER, NEVER);
    for (id, relay) in [("b", &first_relay), ("c", &second_relay)] {
        manager.connect(BrokerConfig { id: id.into(), ..relay.config() }).await.expect("connect");
        let session = manager.session(id).await.expect("a session");
        // Too large to be a will: the link is not renewed for it.
        let goodbye = LastWord { topic: "bye".into(), payload: vec![0; LARGER_THAN_A_SOCKET], retain: false };
        manager.set_last_words(id, session.id, vec![goodbye]).await;
        relay.hold_at(PUBLISH);
    }

    let closing = tokio::spawn({
        let manager = manager.clone();
        async move { manager.disconnect_all().await }
    });
    tokio::time::timeout(Duration::from_secs(1), async {
        first_relay.wait_until_holding(1).await;
        second_relay.wait_until_holding(1).await;
    })
    .await
    .expect("both links were saying goodbye at once");

    first_relay.go_on();
    second_relay.go_on();
    tokio::time::timeout(PATIENCE, closing).await.expect("closed").expect("ran").expect("closed");
    first.wait_until_open(0).await;
    second.wait_until_open(0).await;
}

#[tokio::test]
async fn a_broker_whose_link_is_down_when_it_is_removed_is_told_nothing() {
    let broker = FakeBroker::start().await;
    let manager = pool_reconnecting(NEVER);
    manager.connect(broker.config()).await.expect("connect");
    let _performer = announce(&broker, &manager).await;
    take_the_link_down(&broker, &manager).await;

    tokio::time::timeout(PATIENCE, manager.remove("b")).await.expect("removed without waiting for the link").expect("remove");

    assert_eq!(manager.session("b").await, None);
    assert_eq!(broker.heard().len(), 3, "there was no link to say anything on: {:?}", broker.heard());
    assert_eq!(broker.taken(), 2, "and none was opened to say it");
}

#[tokio::test]
async fn a_broker_studio_was_never_announced_on_is_closed_without_a_word() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    let performer = performer_on(&manager);
    performer.reconcile(flow_wiring("t")).applied().await;
    broker.wait_until_seen(2).await;

    manager.remove("b").await.expect("remove");

    broker.wait_until_heard(1).await;
    assert_eq!(broker.heard(), vec![Heard::Disconnected(1)]);
    assert_eq!(broker.taken(), 1, "its link was never renewed: it has no will to carry");
}

#[tokio::test]
async fn a_bridge_id_that_left_the_flow_is_not_said_to_have_left_again_when_its_broker_is_removed() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    let performer = announce(&broker, &manager).await;
    // The design node is deleted: the performer says so itself, and the link
    // is renewed to carry no will.
    performer.reconcile(Vec::new()).applied().await;
    broker.wait_until_heard(5).await;

    manager.remove("b").await.expect("remove");

    broker.wait_until_heard(6).await;
    assert_eq!(broker.heard()[3..], [goodbye_on(2), Heard::Disconnected(2), Heard::Disconnected(3)], "one `disconnected`");
}

// --- status ------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_broker_being_dialled_for_the_first_time_is_connecting_and_one_whose_dial_failed_is_in_error() {
    let broker = FakeBroker::start().await;
    broker.go_silent();
    let manager = pool(NEVER, CONNECT_BOUND);
    let attempt = connecting(&manager, broker.config());
    broker.wait_until_waiting(1).await;

    assert_eq!(manager.status("b").await, ConnectionStatus::Connecting);
    assert_eq!(manager.all_statuses().await, vec![("b".to_string(), ConnectionStatus::Connecting)]);

    assert!(outcome(attempt).await.is_err(), "nothing answered");
    assert_eq!(manager.status("b").await, ConnectionStatus::Error);
    assert_eq!(manager.all_statuses().await, vec![("b".to_string(), ConnectionStatus::Error)]);

    manager.disconnect("b").await.expect("disconnect");
    assert_eq!(manager.status("b").await, ConnectionStatus::Disconnected);
    assert!(manager.all_statuses().await.is_empty(), "a broker without settings has no status to show");
}

/// The webview events emitted, as JSON.
#[derive(Clone, Default)]
struct RecordedEvents(Arc<Mutex<Vec<(String, serde_json::Value)>>>);

impl HostEvents for RecordedEvents {
    fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) {
        self.0.lock().unwrap().push((event.to_string(), serde_json::to_value(payload).unwrap()));
    }
}

impl RecordedEvents {
    fn emitted(&self) -> Vec<(String, serde_json::Value)> {
        self.0.lock().unwrap().clone()
    }

    /// Poll until `count` events were emitted, and return the last of them.
    async fn wait_for(&self, count: usize) -> (String, serde_json::Value) {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while self.emitted().len() < count {
            assert!(tokio::time::Instant::now() < deadline, "emitted only {:?}", self.emitted());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.emitted()[count - 1].clone()
    }
}

/// An `mqtt-broker-status` event, without its number: the event's name, and
/// the brokers it lists.
fn brokers_in((name, snapshot): (String, serde_json::Value)) -> (String, serde_json::Value) {
    (name, snapshot["brokers"].clone())
}

/// The number of an `mqtt-broker-status` event.
fn seq_of((_, snapshot): &(String, serde_json::Value)) -> u64 {
    snapshot["seq"].as_u64().expect("a numbered snapshot")
}

/// The brokers of an `mqtt-broker-status` event, with broker `b` in `status`
/// and no problem — or with no broker at all.
fn status_event(status: Option<&str>) -> (String, serde_json::Value) {
    let brokers: Vec<serde_json::Value> = status
        .iter()
        .map(|status| serde_json::json!({ "id": "b", "status": status, "problem": null }))
        .collect();
    ("mqtt-broker-status".to_string(), serde_json::Value::Array(brokers))
}

#[tokio::test]
async fn the_status_event_follows_a_broker_through_every_change_and_says_nothing_twice() {
    // Every state is held until the event for it was seen: the broker says
    // nothing until the test lets it, and a dropped link stays down.
    let broker = FakeBroker::start().await;
    broker.go_silent();
    let manager = pool(NEVER, CONNECT_BOUND);
    let events = RecordedEvents::default();
    tokio::spawn(report_broker_statuses(manager.clone(), events.clone()));
    // The reporter reports from its first look on: let it have it.
    tokio::task::yield_now().await;

    // A first dial, which nothing answers …
    let attempt = connecting(&manager, broker.config());
    assert_eq!(brokers_in(events.wait_for(1).await), status_event(Some("connecting")));
    // … and which fails when its time is up.
    assert!(outcome(attempt).await.is_err());
    assert_eq!(brokers_in(events.wait_for(2).await), status_event(Some("error")));

    // The next one gets its answer.
    let attempt = connecting(&manager, broker.config());
    assert_eq!(brokers_in(events.wait_for(3).await), status_event(Some("connecting")));
    broker.answer_again();
    outcome(attempt).await.expect("connect");
    assert_eq!(brokers_in(events.wait_for(4).await), status_event(Some("connected")));

    // The link drops, and the settings sync — the same list as before —
    // repairs it.
    broker.go_silent();
    broker.cut_links();
    assert_eq!(brokers_in(events.wait_for(5).await), status_event(Some("disconnected")));
    manager.sync(vec![broker.config()]).await;
    assert_eq!(brokers_in(events.wait_for(6).await), status_event(Some("connecting")));
    broker.answer_again();
    assert_eq!(brokers_in(events.wait_for(7).await), status_event(Some("connected")));

    // The same list once more changes nothing, and says nothing. Then the
    // broker is deleted.
    manager.sync(vec![broker.config()]).await;
    settle(&broker, &manager, 3).await;
    manager.sync(vec![]).await;
    assert_eq!(brokers_in(events.wait_for(8).await), status_event(None));
    assert_eq!(events.emitted().len(), 8, "one event per change: {:?}", events.emitted());
}

#[tokio::test]
async fn the_answer_to_a_sync_and_the_status_event_are_numbered_in_the_order_they_were_taken() {
    // The settings page gets every broker's status two ways: as the answer
    // to the sync, and on the status event — in either order. A fast broker
    // is connected before the answer that says it is connecting arrives.
    let broker = FakeBroker::start().await;
    broker.go_silent();
    let manager = pool(NEVER, CONNECT_BOUND);
    let events = RecordedEvents::default();
    tokio::spawn(report_broker_statuses(manager.clone(), events.clone()));
    tokio::task::yield_now().await;

    manager.sync(vec![broker.config()]).await;
    let answer = manager.status_snapshot().await;
    assert_eq!(answer.statuses, vec![("b".to_string(), ConnectionStatus::Connecting)]);
    let connecting = events.wait_for(1).await;
    assert_eq!(seq_of(&connecting), answer.seq, "the same state, the same number");

    broker.answer_again();
    let connected = events.wait_for(2).await;
    assert_eq!(brokers_in(connected.clone()), status_event(Some("connected")));
    assert!(seq_of(&connected) > answer.seq, "the event that came later is the newer: an answer arriving after it is not");

    // An answer taken after the event shows what it shows, under its number.
    let later = manager.status_snapshot().await;
    assert_eq!((later.seq, later.statuses), (seq_of(&connected), vec![("b".to_string(), ConnectionStatus::Connected)]));
}

// --- the broker settings as one list -------------------------------------------------------------
//
// `sync` is what the `mqtt_sync_brokers` command does: the web app calls it
// with every broker's settings, on every keystroke of an edit, without waiting
// for the call before.

/// `broker`'s config, under broker id `id`.
fn under(id: &str, broker: &FakeBroker) -> BrokerConfig {
    BrokerConfig { id: id.into(), ..broker.config() }
}

#[tokio::test]
async fn a_list_connects_its_brokers_at_once_and_removes_the_ones_it_leaves_out() {
    let (hole, healthy, deleted) = (FakeBroker::start().await, FakeBroker::start().await, FakeBroker::start().await);
    hole.go_silent();
    let manager = pool(NEVER, NEVER);
    manager.connect(under("deleted", &deleted)).await.expect("connect");
    manager.subscribe("deleted", "t", Subscriber::Console, ignore()).await.expect("subscribe");

    // The broker that does not answer comes first in the list, and is given an
    // hour: neither the call nor the broker after it waits for it.
    tokio::time::timeout(PATIENCE, manager.sync(vec![under("hole", &hole), under("ok", &healthy)]))
        .await
        .expect("the list was taken without waiting for a broker");
    healthy.wait_until_open(1).await;
    hole.wait_until_waiting(1).await;
    deleted.wait_until_open(0).await;
    assert_eq!(manager.all_broker_ids().await, vec!["hole".to_string(), "ok".to_string()]);
    assert_eq!(manager.session("deleted").await, None);
}

#[tokio::test]
async fn a_newer_list_wins_over_one_whose_brokers_are_still_dialling() {
    // Broker `b` is on a host that does not answer, and so is another broker.
    // The user fixes `b` while both are being dialled.
    let (hole, old, new) = (FakeBroker::start().await, FakeBroker::start().await, FakeBroker::start().await);
    hole.go_silent();
    old.go_silent();
    let manager = pool(NEVER, NEVER);
    manager.sync(vec![under("hole", &hole), under("b", &old)]).await;
    hole.wait_until_waiting(1).await;
    old.wait_until_waiting(1).await;

    manager.sync(vec![under("hole", &hole), under("b", &new)]).await;
    new.wait_until_open(1).await;
    old.wait_until_waiting(0).await;

    // Whatever answers from here on, `b` stays as the last list has it, and
    // the other broker is still on the one attempt it started with.
    old.answer_again();
    hole.answer_again();
    hole.wait_until_open(1).await;
    settle(&new, &manager, 2).await;
    assert!(!manager.config_changed("b", &new.config()).await, "the pool is on the fixed settings");
    assert!(old.seen().is_empty(), "the old host never had a connection: {:?}", old.seen());
    assert_eq!(hole.taken(), 1, "the broker both lists agree on was dialled once");
}

#[tokio::test]
async fn of_lists_given_before_the_first_is_applied_only_the_last_is_applied() {
    // Three calls made in order, each before the one before it has run. They
    // are run in the opposite order, as overlapping calls may be.
    let (first, second, third) = (FakeBroker::start().await, FakeBroker::start().await, FakeBroker::start().await);
    let manager = pool(NEVER, NEVER);
    let one = manager.sync(vec![under("b", &first)]);
    let two = manager.sync(vec![under("b", &second), under("other", &second)]);
    let three = manager.sync(vec![under("b", &third)]);

    three.await;
    two.await;
    one.await;

    third.wait_until_open(1).await;
    settle(&third, &manager, 2).await;
    assert_eq!(manager.all_broker_ids().await, vec!["b".to_string()]);
    assert!(!manager.config_changed("b", &third.config()).await, "the pool is on the last list");
    assert_eq!((first.taken(), second.taken()), (0, 0), "no host of an older list was dialled");
}

/// Leave broker `b`'s session a goodbye larger than the socket, and have
/// `relay` hold it at its first bytes: the session takes until `relay.go_on()`
/// to be closed.
async fn a_long_goodbye(manager: &MqttManager, relay: &Relay) {
    let session = manager.session("b").await.expect("a session");
    let goodbye = LastWord { topic: "bye".into(), payload: vec![0; LARGER_THAN_A_SOCKET], retain: false };
    manager.set_last_words("b", session.id, vec![goodbye]).await;
    relay.hold_at(PUBLISH);
}

#[tokio::test]
async fn a_list_is_applied_without_waiting_for_a_removed_broker_to_say_goodbye() {
    let (slow, other) = (FakeBroker::start().await, FakeBroker::start().await);
    let relay = Relay::start(&slow).await;
    let manager = pool(NEVER, NEVER);
    manager.sync(vec![relay.config()]).await;
    wait_until_online(&manager, true).await;
    a_long_goodbye(&manager, &relay).await;

    // Taken out of the settings: its link says goodbye, and the lists after
    // that one do not wait for it.
    tokio::time::timeout(Duration::from_millis(500), manager.sync(vec![])).await.expect("the list was applied at once");
    relay.wait_until_holding(1).await;
    tokio::time::timeout(Duration::from_millis(500), manager.sync(vec![under("other", &other)]))
        .await
        .expect("the next list too");
    other.wait_until_open(1).await;

    // Added again, the broker is dialled once the old link has said its
    // goodbye: never beside it, where the goodbye could land after what the
    // new session announces.
    manager.sync(vec![under("other", &other), relay.config()]).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(relay.wills().len(), 1, "not dialled while the old link says goodbye");
    relay.go_on();
    wait_until_online(&manager, true).await;
    slow.wait_until_heard(2).await;
    assert_eq!(slow.heard()[1], Heard::Disconnected(1), "the goodbye, then the DISCONNECT");
    assert_eq!(slow.seen().last(), Some(&Seen::Connected(2)));
}

/// A reconnect delay long enough for a test to act in, while the client still
/// reconnects by itself within the test's patience.
const A_WHILE: Duration = Duration::from_secs(1);

#[tokio::test]
async fn a_link_opened_for_a_broker_that_repaired_itself_meanwhile_is_closed() {
    // The link is down. A `connect` dials, and so — a while later — does the
    // client itself; the client's own link is answered first.
    let broker = FakeBroker::start().await;
    let manager = pool(A_WHILE, NEVER);
    manager.connect(broker.config()).await.expect("connect");
    let session = manager.session("b").await.expect("a session");
    manager.subscribe("b", "t", Subscriber::Flow, ignore()).await.expect("subscribe");
    broker.wait_until_seen(2).await;

    broker.go_silent();
    take_the_link_down(&broker, &manager).await;
    let repairing = connecting(&manager, broker.config());
    // Connection 2 is the `connect`'s, connection 3 the client's own.
    broker.wait_until_waiting(2).await;
    broker.answer(3);
    wait_until_online(&manager, true).await;

    // Now the `connect`'s link is answered too: one connection per broker.
    broker.answer_again();
    outcome(repairing).await.expect("the broker is connected");
    broker.wait_until_open(1).await;
    assert_eq!(manager.session("b").await.map(|s| (s.id, s.online)), Some((session.id, true)), "the same session");
    assert_eq!(
        broker.seen()[2..],
        [Seen::Connected(3), subscribed(3, "t"), Seen::Connected(2)],
        "the link that was not needed carried nothing"
    );
}
