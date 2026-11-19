//! Every goodbye a broker session is left is a will the broker holds.
//!
//! MQTT gives a link one will. The session's main link carries the first of
//! its last words; each further one gets an idle *will link* of its own, so
//! that should the app end without a goodbye the broker says every one of
//! them. These tests hold the pool to that over TCP, against a broker that
//! keeps each connection's will and publishes it when the connection ends
//! without a DISCONNECT:
//!
//! - **N goodbyes, N wills**, none of them the broker's status.
//! - **A goodbye no longer left** is said by its will link, which then says
//!   DISCONNECT; one that changes gets a new will link first; one that moves
//!   to the main link leaves its will link once the main link carries it.
//! - **A session ended on purpose** says every goodbye — each will link its
//!   own — and every link says DISCONNECT.
//! - **A crash** leaves every will with the broker.
//! - **A will link that cannot be opened** is tried again, out of sight.

use app_lib::mqtt::broker::{ConnectionStatus, LastWord, ReconnectConfig};
use app_lib::mqtt::MqttManager;
use app_lib::runtime::cloud_performer::CloudPerformer;
use app_lib::runtime::host::HostEvents;
use app_lib::runtime::services::MqttBrokers;
use microflow_core::runtime::SubscriberWiring;
use std::sync::Arc;
use std::time::Duration;

#[path = "support/fake_broker.rs"]
mod fake_broker;
use fake_broker::{published, FakeBroker, Heard, Will, PATIENCE};

/// Nothing heard.
const NOTHING: [Heard; 0] = [];

/// No will published.
const NO_WILLS: [(usize, Will); 0] = [];

/// The retained status topic of Bridge ID `uid`.
fn status_topic(uid: &str) -> String {
    format!("microflow/{uid}/app/status")
}

/// The `disconnected` of each of `uids`, as the performer leaves them.
fn goodbyes(uids: &[&str]) -> Vec<LastWord> {
    uids.iter().map(|uid| LastWord { topic: status_topic(uid), payload: b"disconnected".to_vec(), retain: true }).collect()
}

/// The `disconnected` of each of `uids`, as a will the broker holds.
fn wills(uids: &[&str]) -> Vec<Will> {
    uids.iter().map(|uid| (status_topic(uid), "disconnected".to_string(), true)).collect()
}

/// What the broker heard on `connection`, in order.
fn heard_on(broker: &FakeBroker, connection: usize) -> Vec<Heard> {
    broker
        .heard()
        .into_iter()
        .filter(|heard| match heard {
            Heard::Published { connection: on, .. } | Heard::Disconnected(on) => *on == connection,
        })
        .collect()
}

/// The `disconnected` of `uid` heard on `connection`, then its DISCONNECT.
fn goodbye_then_disconnect(connection: usize, uid: &str) -> Vec<Heard> {
    vec![published(connection, &status_topic(uid), "disconnected", true), Heard::Disconnected(connection)]
}

/// The connection that holds `uid`'s will.
fn holder_of(broker: &FakeBroker, uid: &str) -> usize {
    let will = &wills(&[uid])[0];
    let held = broker.wills_held();
    *held.iter().find(|(_, held)| *held == will).unwrap_or_else(|| panic!("nobody holds {uid}'s will: {held:?}")).0
}

/// Poll until the broker heard `count` things on `connection`.
async fn wait_until_heard_on(broker: &FakeBroker, connection: usize, count: usize) {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    while heard_on(broker, connection).len() < count {
        assert!(tokio::time::Instant::now() < deadline, "heard only {:?} on {connection}", heard_on(broker, connection));
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// A pool whose links are tried again every `delay`, an attempt given
/// `connect_timeout`.
fn pool(delay: Duration, connect_timeout: Duration) -> MqttManager {
    MqttManager::with_reconnect_config(ReconnectConfig {
        initial_delay: delay,
        max_delay: delay,
        multiplier: 1.0,
        connect_timeout,
        ..ReconnectConfig::default()
    })
}

/// A pool connected to `broker` and left the goodbyes of `uids`, once the
/// broker holds every one of them as a will.
async fn left_with(broker: &FakeBroker, uids: &[&str]) -> MqttManager {
    let manager = MqttManager::new();
    leave(broker, &manager, uids).await;
    manager
}

async fn leave(broker: &FakeBroker, manager: &MqttManager, uids: &[&str]) {
    manager.connect(broker.config()).await.expect("connect");
    let session = manager.session("b").await.expect("a session");
    manager.set_last_words("b", session.id, goodbyes(uids)).await;
    broker.wait_until_wills_held(&wills(uids)).await;
    // And the main link's renewal is through — the link it replaced is gone
    // — and each will link is up as the pool sees it.
    broker.wait_until_open(uids.len()).await;
    let deadline = tokio::time::Instant::now() + PATIENCE;
    while manager.will_links_up("b").await < uids.len() - 1 {
        assert!(tokio::time::Instant::now() < deadline, "the will links never came up");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn every_goodbye_left_with_a_session_is_a_will_the_broker_holds() {
    let broker = FakeBroker::start().await;
    let manager = left_with(&broker, &["uid_1", "uid_2", "uid_3"]).await;

    // The main link, renewed to carry the first, and a will link for each of
    // the two others.
    broker.wait_until_open(3).await;
    let main = holder_of(&broker, "uid_1");
    assert_eq!(broker.subscription_ids().iter().filter(|(on, _, _)| *on != main).count(), 0, "a will link subscribes nothing");
    assert_eq!(broker.heard(), [Heard::Disconnected(1)], "nothing is published on a will link; link 1 was renewed");
    assert_eq!(manager.all_statuses().await, [("b".to_string(), ConnectionStatus::Connected)], "one broker, one status");
}

#[tokio::test]
async fn a_goodbye_no_longer_left_is_said_by_its_will_link_before_it_says_disconnect() {
    let broker = FakeBroker::start().await;
    let manager = left_with(&broker, &["uid_1", "uid_2", "uid_3"]).await;
    let (main, second) = (holder_of(&broker, "uid_1"), holder_of(&broker, "uid_2"));
    let session = manager.session("b").await.expect("a session");

    manager.set_last_words("b", session.id, goodbyes(&["uid_1", "uid_3"])).await;

    broker.wait_until_wills_held(&wills(&["uid_1", "uid_3"])).await;
    wait_until_heard_on(&broker, second, 2).await;
    assert_eq!(heard_on(&broker, second), goodbye_then_disconnect(second, "uid_2"));
    assert_eq!(heard_on(&broker, main), NOTHING, "the main link is left alone");
    assert_eq!(broker.wills_said(), NO_WILLS, "no will was published");
}

#[tokio::test]
async fn a_goodbye_that_moves_to_the_main_link_leaves_its_will_link_once_the_main_link_carries_it() {
    let broker = FakeBroker::start().await;
    let manager = left_with(&broker, &["uid_1", "uid_2", "uid_3"]).await;
    let (main, second) = (holder_of(&broker, "uid_1"), holder_of(&broker, "uid_2"));
    let session = manager.session("b").await.expect("a session");

    // `uid_1` leaves (the performer says its goodbye itself): `uid_2`'s is now
    // the first, and the main link is renewed to carry it. The new main link
    // is held at its CONNECT for now.
    broker.go_silent();
    manager.set_last_words("b", session.id, goodbyes(&["uid_2", "uid_3"])).await;
    broker.wait_until_waiting(1).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(heard_on(&broker, second), NOTHING, "uid_2's will link waits for the main link to carry its will");

    broker.answer_again();
    broker.wait_until_wills_held(&wills(&["uid_2", "uid_3"])).await;
    wait_until_heard_on(&broker, main, 1).await;
    wait_until_heard_on(&broker, second, 1).await;
    assert_eq!(heard_on(&broker, second), [Heard::Disconnected(second)], "not said: uid_2 is still there");
    assert_eq!(heard_on(&broker, main), [Heard::Disconnected(main)], "the old main link, renewed");
    assert_eq!(broker.wills_said(), NO_WILLS);
}

#[tokio::test]
async fn a_goodbye_that_changes_gets_a_new_will_link_before_the_old_one_says_disconnect() {
    let broker = FakeBroker::start().await;
    let manager = left_with(&broker, &["uid_1", "uid_2"]).await;
    let second = holder_of(&broker, "uid_2");
    let session = manager.session("b").await.expect("a session");
    let mut changed = goodbyes(&["uid_1", "uid_2"]);
    changed[1].payload = b"gone".to_vec();

    broker.go_silent();
    manager.set_last_words("b", session.id, changed).await;
    broker.wait_until_waiting(1).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(heard_on(&broker, second), NOTHING, "the old will stays until the new one is held");
    assert_eq!(broker.wills_held().get(&second), Some(&wills(&["uid_2"])[0]));

    broker.answer_again();
    let new = (status_topic("uid_2"), "gone".to_string(), true);
    broker.wait_until_wills_held(&[wills(&["uid_1"])[0].clone(), new]).await;
    wait_until_heard_on(&broker, second, 1).await;
    assert_eq!(heard_on(&broker, second), [Heard::Disconnected(second)], "an old goodbye is not said");
    assert_eq!(broker.wills_said(), NO_WILLS);
}

/// End the session on purpose, through `end`: every goodbye is said once, each
/// will link's on its own connection right before its DISCONNECT, the main
/// link's own before its DISCONNECT, and the broker publishes no will.
async fn every_goodbye_is_said_and_every_link_says_disconnect(end: impl AsyncFnOnce(&MqttManager)) {
    let broker = FakeBroker::start().await;
    let uids = ["uid_1", "uid_2", "uid_3"];
    let manager = left_with(&broker, &uids).await;
    let holders: Vec<usize> = uids.iter().map(|uid| holder_of(&broker, uid)).collect();

    end(&manager).await;

    broker.wait_until_open(0).await;
    for (uid, holder) in uids.iter().zip(&holders) {
        assert_eq!(heard_on(&broker, *holder), goodbye_then_disconnect(*holder, uid), "on {uid}'s link");
    }
    assert_eq!(broker.wills_said(), NO_WILLS, "every will was dropped");
}

#[tokio::test]
async fn a_removed_broker_has_every_goodbye_said_and_every_link_disconnected() {
    every_goodbye_is_said_and_every_link_says_disconnect(async |manager: &MqttManager| {
        manager.remove("b").await.expect("remove");
    })
    .await;
}

#[tokio::test]
async fn quitting_has_every_goodbye_said_and_every_link_disconnected() {
    every_goodbye_is_said_and_every_link_says_disconnect(async |manager: &MqttManager| {
        manager.disconnect_all().await.expect("closed");
    })
    .await;
}

#[test]
fn a_crash_leaves_every_will_with_the_broker() {
    // The broker runs on a runtime of its own; the app's runtime is dropped
    // as a process that dies is: every link ends without a word.
    let broker_runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("a runtime");
    let broker = broker_runtime.block_on(FakeBroker::start());
    let app = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("a runtime");
    let uids = ["uid_1", "uid_2", "uid_3"];
    let manager = app.block_on(left_with(&broker, &uids));

    drop(app);

    broker_runtime.block_on(async {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while broker.wills_said().len() < uids.len() {
            assert!(tokio::time::Instant::now() < deadline, "the broker said only {:?}", broker.wills_said());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    let mut said: Vec<Will> = broker.wills_said().into_iter().map(|(_, will)| will).collect();
    said.sort();
    assert_eq!(said, wills(&uids));
    assert_eq!(broker.heard(), [Heard::Disconnected(1)], "no goodbye, no DISCONNECT but the renewal's");
    drop(manager);
}

#[tokio::test]
async fn a_will_link_that_cannot_be_opened_is_tried_again_and_is_not_the_brokers_status() {
    let broker = FakeBroker::start().await;
    let manager = pool(Duration::from_millis(50), Duration::from_millis(200));
    leave(&broker, &manager, &["uid_1"]).await;
    let session = manager.session("b").await.expect("a session");

    broker.go_silent();
    manager.set_last_words("b", session.id, goodbyes(&["uid_1", "uid_2"])).await;
    // Kept waiting, given up on, and tried again.
    broker.wait_until_held(2).await;
    assert_eq!(manager.status("b").await, ConnectionStatus::Connected);
    assert_eq!(manager.all_statuses().await, [("b".to_string(), ConnectionStatus::Connected)]);

    broker.answer_again();
    broker.wait_until_wills_held(&wills(&["uid_1", "uid_2"])).await;
    assert_eq!(manager.status("b").await, ConnectionStatus::Connected);
}

// --- through the performer ---------------------------------------------------------

/// The webview, for a performer nobody watches.
struct NoEvents;

impl HostEvents for NoEvents {
    fn emit<S: serde::Serialize + Clone>(&self, _event: &str, _payload: S) {}
}

/// A design node's wiring for Bridge ID `uid` on broker `b`.
fn bridge(uid: &str) -> (String, SubscriberWiring) {
    let topic = format!("microflow/{uid}/figma/variable/1-2");
    (format!("fig-{uid}"), SubscriberWiring::TopicAware { broker_id: "b".into(), topic })
}

#[tokio::test]
async fn every_bridge_id_announced_on_a_broker_has_its_goodbye_held_as_a_will() {
    let broker = FakeBroker::start().await;
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    let (actor, _inbound) = tokio::sync::mpsc::unbounded_channel();
    let brokers: Arc<dyn MqttBrokers> = Arc::new(manager.clone());
    let performer = CloudPerformer::new(brokers, actor, NoEvents, tokio::runtime::Handle::current());

    performer.reconcile(vec![bridge("uid_1"), bridge("uid_2"), bridge("uid_3")]).applied().await;
    broker.wait_until_wills_held(&wills(&["uid_1", "uid_2", "uid_3"])).await;

    // One Bridge ID is deleted: Studio says it left, and its will goes.
    let second = holder_of(&broker, "uid_2");
    performer.reconcile(vec![bridge("uid_1"), bridge("uid_3")]).applied().await;
    broker.wait_until_wills_held(&wills(&["uid_1", "uid_3"])).await;
    wait_until_heard_on(&broker, second, 2).await;
    assert_eq!(heard_on(&broker, second), goodbye_then_disconnect(second, "uid_2"));
}
