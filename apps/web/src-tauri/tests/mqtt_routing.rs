//! Which subscriptions a message the broker sends reaches, and what the client
//! never sends.
//!
//! - **Filters.** `MqttBroker::topic_matches` is held to the case table the
//!   browser host's `topicMatches` is held to
//!   (`src/cloud/fixtures/topic-filter.json`).
//! - **One delivery per message.** A message reaches each subscription whose
//!   filter matches its topic once, whether the broker sends one copy of it
//!   for every matching filter or one for all; a retained replay reaches only
//!   the subscription that asked for it.
//! - **No invalid PUBLISH.** A topic with a wildcard is never published: a
//!   broker closes the connection of a client that does, and every
//!   subscription on it with it.

use app_lib::mqtt::broker::{MessageCallback, MqttBroker, MqttMessage, Subscriber, COPY_WINDOW};
use app_lib::mqtt::MqttManager;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "support/fake_broker.rs"]
mod fake_broker;
use fake_broker::{published, FakeBroker, PATIENCE};

const TABLE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/cloud/fixtures/topic-filter.json"));

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
        tokio::time::sleep(COPY_WINDOW * 3).await;
    }
}

/// A pool connected to `broker`, the flow subscribed to `filters` on it.
async fn subscribed(broker: &FakeBroker, filters: &[&str]) -> (MqttManager, Inbox) {
    let manager = MqttManager::new();
    manager.connect(broker.config()).await.expect("connect");
    let inbox = Inbox::default();
    for filter in filters {
        manager.subscribe("b", filter, Subscriber::Flow, inbox.callback(filter)).await.expect("subscribe");
    }
    broker.wait_until_seen(1 + filters.len()).await;
    (manager, inbox)
}

fn each_once(filters: &[&str], payload: &str) -> Vec<String> {
    let mut deliveries: Vec<String> = filters.iter().map(|filter| format!("{filter} <- {payload}")).collect();
    deliveries.sort();
    deliveries
}

fn sorted(mut deliveries: Vec<String>) -> Vec<String> {
    deliveries.sort();
    deliveries
}

#[tokio::test]
async fn a_broker_that_sends_a_copy_per_matching_filter_reaches_each_filter_once_per_message() {
    let broker = FakeBroker::start().await;
    broker.copy_per_subscription();
    let filters = ["sensors/#", "sensors/+/temperature", "sensors/kitchen/temperature"];
    let (_manager, inbox) = subscribed(&broker, &filters).await;

    broker.publish("sensors/kitchen/temperature", b"21");
    inbox.settle_at(3).await;
    assert_eq!(sorted(inbox.received()), each_once(&filters, "21"));

    // The same value, published again after the copies of the first, is news.
    broker.publish("sensors/kitchen/temperature", b"21");
    inbox.settle_at(6).await;
    assert_eq!(sorted(inbox.received()[3..].to_vec()), each_once(&filters, "21"));
}

#[tokio::test]
async fn a_broker_that_sends_one_copy_for_all_filters_reaches_each_filter_once_per_message() {
    let broker = FakeBroker::start().await;
    let filters = ["sensors/#", "sensors/kitchen"];
    let (_manager, inbox) = subscribed(&broker, &filters).await;

    broker.publish("sensors/kitchen", b"21");
    inbox.settle_at(2).await;
    broker.publish("sensors/kitchen", b"21");
    inbox.settle_at(4).await;
    broker.publish("sensors/kitchen", b"22");
    inbox.settle_at(6).await;

    let received = inbox.received();
    assert_eq!(sorted(received[..2].to_vec()), each_once(&filters, "21"));
    assert_eq!(sorted(received[2..4].to_vec()), each_once(&filters, "21"));
    assert_eq!(sorted(received[4..].to_vec()), each_once(&filters, "22"));
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
