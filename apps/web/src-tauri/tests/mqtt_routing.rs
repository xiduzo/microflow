//! Which subscriptions a message the broker sends reaches, and what the client
//! never sends.
//!
//! - **Filters.** `MqttBroker::topic_matches` is held to the case table the
//!   browser host's `topicMatches` is held to
//!   (`packages/design-bridge/fixtures/topic-filter.json`).
//! - **One delivery per subscription and message.** Every filter is subscribed
//!   with a subscription identifier of its own, and a message reaches exactly
//!   the subscriptions whose identifiers it carries — whether the broker sends
//!   one copy of it for every matching filter or one for all, and however
//!   soon a publisher repeats a payload. A retained replay reaches only the
//!   subscription that asked for it.
//! - **No invalid PUBLISH.** A topic with a wildcard is never published: a
//!   broker closes the connection of a client that does, and every
//!   subscription on it with it.

use app_lib::mqtt::broker::{MessageCallback, MqttBroker, MqttMessage, ReconnectConfig, Subscriber};
use app_lib::mqtt::MqttManager;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "support/fake_broker.rs"]
mod fake_broker;
use fake_broker::{published, FakeBroker, PATIENCE};

/// How long a test waits for messages that should not come.
const QUIET: Duration = Duration::from_millis(150);

const TABLE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/design-bridge/fixtures/topic-filter.json"));

#[test]
fn filters_match_the_shared_case_table() {
    let table: Value = serde_json::from_str(TABLE).expect("the case table is JSON");
    let mut wrong = Vec::new();
    let mut cases = 0;
    for group in table["groups"].as_array().expect("groups") {
        for case in group["cases"].as_array().expect("cases") {
            let (filter, topic) = (case[0].as_str().expect("filter"), case[1].as_str().expect("topic"));
            let matches = case[2].as_bool().expect("matches");
            cases += 1;
            if MqttBroker::topic_matches(filter, topic) != matches {
                wrong.push(format!("{filter} ~ {topic} should be {matches} ({})", group["rule"]));
            }
        }
    }
    assert!(cases > 50, "the table has {cases} cases");
    assert!(wrong.is_empty(), "{} of {cases} cases are wrong:\n{}", wrong.len(), wrong.join("\n"));
}

#[test]
fn a_topic_name_holds_no_wildcard_and_is_not_empty() {
    let names = ["a", "a/b", "/", "$SYS/x", "a b", "", "a/+", "a/#", "+", "#", "a\0b"];
    let valid: Vec<&str> = names.into_iter().filter(|name| MqttBroker::is_topic_name(name)).collect();
    assert_eq!(valid, ["a", "a/b", "/", "$SYS/x", "a b"]);
}

/// What one subscription received, as `filter <- payload`.
#[derive(Clone, Default)]
struct Inbox(Arc<Mutex<Vec<String>>>);

impl Inbox {
    fn callback(&self, filter: &str) -> MessageCallback {
        let (inbox, filter) = (Arc::clone(&self.0), filter.to_string());
        Arc::new(move |message: MqttMessage| {
            inbox.lock().unwrap().push(format!("{filter} <- {}", String::from_utf8_lossy(&message.payload)));
        })
    }

    fn received(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }

    /// Poll until `count` messages arrived, then give more that should not
    /// come the time to come.
    async fn settle_at(&self, count: usize) {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while self.received().len() < count {
            assert!(tokio::time::Instant::now() < deadline, "received only {:?}", self.received());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(QUIET).await;
    }
}

/// A pool connected to `broker`, the flow subscribed to `filters` on it.
async fn subscribed(broker: &FakeBroker, filters: &[&str]) -> (MqttManager, Inbox) {
    subscribed_on(MqttManager::new(), broker, filters).await
}

/// `manager`, connected to `broker`, the flow subscribed to `filters` on it.
async fn subscribed_on(manager: MqttManager, broker: &FakeBroker, filters: &[&str]) -> (MqttManager, Inbox) {
    manager.connect(broker.config()).await.expect("connect");
    let inbox = Inbox::default();
    for filter in filters {
        manager.subscribe("b", filter, Subscriber::Flow, inbox.callback(filter)).await.expect("subscribe");
    }
    broker.wait_until_seen(1 + filters.len()).await;
    (manager, inbox)
}

fn sorted(mut deliveries: Vec<String>) -> Vec<String> {
    deliveries.sort();
    deliveries
}

/// What each filter received, in order.
fn by_filter(received: &[String]) -> BTreeMap<String, Vec<String>> {
    let mut filters: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for delivery in received {
        let (filter, payload) = delivery.split_once(" <- ").expect("filter <- payload");
        filters.entry(filter.to_string()).or_default().push(payload.to_string());
    }
    filters
}

/// Every one of `filters` received `payloads`, in that order.
fn each_received(filters: &[&str], payloads: &[&str]) -> BTreeMap<String, Vec<String>> {
    let payloads: Vec<String> = payloads.iter().map(|payload| (*payload).to_string()).collect();
    filters.iter().map(|filter| ((*filter).to_string(), payloads.clone())).collect()
}

/// Three overlapping filters; a value published twice in a row, at once, and
/// another after it: each filter gets each of the three, once.
async fn three_messages_reach_each_overlapping_filter_once(broker: &FakeBroker) {
    let filters = ["sensors/#", "sensors/+/temperature", "sensors/kitchen/temperature"];
    let (_manager, inbox) = subscribed(broker, &filters).await;

    broker.publish("sensors/kitchen/temperature", b"21");
    broker.publish("sensors/kitchen/temperature", b"21");
    broker.publish("sensors/kitchen/temperature", b"22");
    inbox.settle_at(9).await;

    assert_eq!(by_filter(&inbox.received()), each_received(&filters, &["21", "21", "22"]));
}

#[tokio::test]
async fn a_broker_that_sends_a_copy_per_subscription_reaches_each_subscription_once_per_message() {
    // mosquitto 2, EMQX: one copy for each matching subscription, each
    // carrying the identifier of its own.
    let broker = FakeBroker::start().await;
    broker.copy_per_subscription();
    three_messages_reach_each_overlapping_filter_once(&broker).await;
}

#[tokio::test]
async fn a_broker_that_sends_one_copy_for_all_subscriptions_reaches_each_subscription_once_per_message() {
    // HiveMQ: one copy, carrying the identifiers of every matching
    // subscription.
    let broker = FakeBroker::start().await;
    three_messages_reach_each_overlapping_filter_once(&broker).await;
}

#[tokio::test]
async fn a_message_that_carries_no_subscription_identifier_reaches_every_matching_filter_once() {
    // A broker that forgets the identifiers: the client falls back on the
    // topic.
    let broker = FakeBroker::start().await;
    broker.tag_nothing();
    let filters = ["sensors/#", "sensors/kitchen"];
    let (_manager, inbox) = subscribed(&broker, &filters).await;

    broker.publish("sensors/kitchen", b"21");
    broker.publish("sensors/kitchen", b"21");
    inbox.settle_at(4).await;

    assert_eq!(by_filter(&inbox.received()), each_received(&filters, &["21", "21"]));
}

#[tokio::test]
async fn every_filter_has_an_identifier_of_its_own_and_keeps_it_across_a_repaired_and_a_renewed_link() {
    let broker = FakeBroker::start().await;
    let reconnecting = ReconnectConfig { initial_delay: Duration::from_millis(20), ..ReconnectConfig::default() };
    let manager = MqttManager::with_reconnect_config(reconnecting);
    let (manager, inbox) = subscribed_on(manager, &broker, &["a/#", "a/b"]).await;
    // The console on a filter the flow holds: the same subscription.
    manager.subscribe("b", "a/b", Subscriber::Console, inbox.callback("console a/b")).await.expect("subscribe");
    broker.wait_until_seen(4).await;

    let ids_on = |connection: usize| -> BTreeMap<String, Option<u32>> {
        broker
            .subscription_ids()
            .into_iter()
            .filter(|(on, _, _)| *on == connection)
            .map(|(_, filter, id)| (filter, id))
            .collect()
    };
    let first = ids_on(1);
    assert_eq!(first.len(), 2, "{first:?}");
    assert!(first.values().all(Option::is_some), "every SUBSCRIBE carries an identifier: {first:?}");
    assert_ne!(first["a/#"], first["a/b"], "one per filter");

    // A repaired link.
    broker.cut_links();
    broker.wait_until_seen(4 + 1 + 2).await;
    assert_eq!(ids_on(2), first);

    // A link renewed for a will.
    let session = manager.session("b").await.expect("a session");
    let will = app_lib::mqtt::broker::LastWord { topic: "bye".into(), payload: b"bye".to_vec(), retain: true };
    manager.set_last_words("b", session.id, vec![will]).await;
    broker.wait_until_seen(4 + 3 + 3).await;
    assert_eq!(ids_on(3), first);

    // And delivery still goes by them.
    broker.publish("a/b", b"1");
    inbox.settle_at(3).await;
    assert_eq!(sorted(inbox.received()), sorted(vec!["a/# <- 1".into(), "a/b <- 1".into(), "console a/b <- 1".into()]));
}

#[tokio::test]
async fn a_retained_value_reaches_the_overlapping_filter_that_asked_for_it_and_no_other_again() {
    let broker = FakeBroker::start().await;
    broker.copy_per_subscription();
    broker.retain("sensors/kitchen", b"21");
    let (manager, inbox) = subscribed(&broker, &["sensors/kitchen"]).await;
    inbox.settle_at(1).await;

    manager.subscribe("b", "sensors/#", Subscriber::Flow, inbox.callback("sensors/#")).await.expect("subscribe");
    inbox.settle_at(2).await;
    assert_eq!(inbox.received(), ["sensors/kitchen <- 21", "sensors/# <- 21"]);
}

#[tokio::test]
async fn a_topic_with_a_wildcard_is_never_published_so_the_connection_stays() {
    let broker = FakeBroker::start().await;
    let (manager, inbox) = subscribed(&broker, &["a"]).await;

    for topic in ["microflow/+/app/status", "sensors/#", ""] {
        assert!(manager.publish("b", topic, b"connected", true).await.is_err(), "{topic:?} was published");
    }
    manager.publish("b", "marker", b"after", false).await.expect("publish");
    broker.wait_until_heard(1).await;
    assert_eq!(broker.heard(), [published(1, "marker", "after", false)]);

    broker.publish("a", b"still here");
    inbox.settle_at(1).await;
    broker.wait_until_open(1).await;
}
