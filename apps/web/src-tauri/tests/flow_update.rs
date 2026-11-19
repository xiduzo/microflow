//! A flow update and the brokers that are not there yet.
//!
//! `FlowUpdates::update` is what the `flow_update` command does. These tests
//! run it against everything below the command that is real — the
//! `CloudPerformer`, the broker pool, and brokers over TCP — with a stand-in
//! for the runtime actor's flow-update turn that applies the flow to a real
//! `FlowRuntime`.
//!
//! What they hold it to: a broker that answers is waited for, so the update
//! resolves with the flow's subscriptions in place; a broker that does not is
//! given a grace period — one, for all of them — and then the flow is applied
//! without it, and subscribed on it when it comes up, with no further update.
//! And the runtime ends up on the last flow it was sent, whatever the updates
//! before it were waiting for.
//!
//! No test measures how long something took to tell these apart. Where an
//! update must not wait, the thing it must not wait for is given an hour.

use app_lib::mqtt::broker::ReconnectConfig;
use app_lib::mqtt::MqttManager;
use app_lib::runtime::cloud_performer::CloudPerformer;
use app_lib::runtime::commands::{FlowUpdates, FrontendBrokerConfig};
use app_lib::runtime::host::{ActorMsg, HostEvents};
use app_lib::runtime::services::MqttBrokers;
use microflow_core::flow::{FlowNode, FlowUpdate, Position};
use microflow_core::runtime::FlowRuntime;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "support/fake_broker.rs"]
mod fake_broker;
use fake_broker::{subscribed, FakeBroker, Seen, PATIENCE};

/// Longer than any test lives: what is given this long is not waited for.
const AN_HOUR: Duration = Duration::from_secs(3600);

/// The id of a node that makes the stand-in runtime refuse its flow.
const REFUSED: &str = "refused";

/// The webview, for a performer nobody watches.
struct NoEvents;

impl HostEvents for NoEvents {
    fn emit<S: serde::Serialize + Clone>(&self, _event: &str, _payload: S) {}
}

/// What the stand-in runtime did.
#[derive(Default)]
struct Runtime {
    /// The flows applied, as the node ids of each.
    applied: Vec<Vec<String>>,
    /// The broker messages delivered to a node, as `(node id, topic)`.
    delivered: Vec<(String, String)>,
}

/// Everything below the command: a broker pool whose connection attempts are
/// given an hour, a `CloudPerformer` on it, and a stand-in for the runtime
/// actor.
struct Rig {
    pool: MqttManager,
    updates: FlowUpdates,
    runtime: Arc<Mutex<Runtime>>,
}

impl Rig {
    fn new() -> Self {
        // A link that dropped stays down until something connects the broker
        // again: no test races a client's own reconnect.
        let pool = MqttManager::with_reconnect_config(ReconnectConfig {
            initial_delay: AN_HOUR,
            max_delay: AN_HOUR,
            connect_timeout: AN_HOUR,
            ..ReconnectConfig::default()
        });
        let (actor, mut inbox) = tokio::sync::mpsc::unbounded_channel();
        let brokers: Arc<dyn MqttBrokers> = Arc::new(pool.clone());
        let cloud = CloudPerformer::new(brokers, actor.clone(), NoEvents, tokio::runtime::Handle::current());
        let runtime = Arc::new(Mutex::new(Runtime::default()));

        // The actor's flow-update turn, as `Actor::handle` has it: apply the
        // flow, hand the runtime's subscriber wirings to the performer, and
        // reply with that reconcile. On its own thread, as the `!Send` runtime
        // is in the app.
        let record = Arc::clone(&runtime);
        std::thread::spawn(move || {
            let mut flow_runtime = FlowRuntime::new();
            while let Some(message) = inbox.blocking_recv() {
                match message {
                    ActorMsg::FlowUpdate { flow, reply } => {
                        // A flow the runtime does not take, for the tests of
                        // what a failed update answers.
                        if flow.nodes.iter().any(|node| node.id == REFUSED) {
                            let _ = reply.send(Err("the runtime refused the flow".to_string()));
                            continue;
                        }
                        let nodes = flow.nodes.iter().map(|node| node.id.clone()).collect();
                        let _ = flow_runtime.update_flow(flow);
                        record.lock().unwrap().applied.push(nodes);
                        let _ = reply.send(Ok(cloud.reconcile(flow_runtime.collect_subscriber_wirings())));
                    }
                    ActorMsg::Deliver { id, topic, .. } => record.lock().unwrap().delivered.push((id, topic)),
                    _ => {}
                }
            }
        });

        let updates = FlowUpdates::new(actor, pool.clone());
        Self { pool, updates, runtime }
    }

    /// A flow update for `flow`, with `brokers` as the settings have them,
    /// giving the ones that are not connected `grace`. It has to resolve: an
    /// update that waits for something it was not to wait for fails the test.
    async fn update(&self, flow: FlowUpdate, brokers: &[FrontendBrokerConfig], grace: Duration) -> Result<(), String> {
        tokio::time::timeout(PATIENCE, self.updates.update(flow, brokers, grace))
            .await
            .expect("the flow update resolved")
    }

    fn applied(&self) -> Vec<Vec<String>> {
        self.runtime.lock().unwrap().applied.clone()
    }

    /// Poll until `count` broker messages were delivered to nodes.
    async fn wait_for_deliveries(&self, count: usize) -> Vec<(String, String)> {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        loop {
            let delivered = self.runtime.lock().unwrap().delivered.clone();
            if delivered.len() >= count {
                return delivered;
            }
            assert!(tokio::time::Instant::now() < deadline, "delivered only {delivered:?}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

/// `broker` as the settings hold it, under `id`.
fn settings(id: &str, broker: &FakeBroker) -> FrontendBrokerConfig {
    let config = broker.config();
    FrontendBrokerConfig { id: id.into(), name: id.into(), url: config.url, username: None, password: None }
}

/// A flow of Mqtt subscribe nodes: `(node id, broker id, topic)` each.
fn flow_subscribing(nodes: &[(&str, &str, &str)]) -> FlowUpdate {
    let nodes = nodes
        .iter()
        .map(|(id, broker_id, topic)| FlowNode {
            id: (*id).to_string(),
            node_type: Some("Mqtt".to_string()),
            data: serde_json::json!({ "direction": "subscribe", "brokerId": broker_id, "topic": topic }),
            position: Position { x: 0.0, y: 0.0 },
        })
        .collect();
    FlowUpdate { nodes, edges: vec![] }
}

/// Poll until `broker` has seen `event`.
async fn wait_until_saw(broker: &FakeBroker, event: &Seen) {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    while !broker.seen().contains(event) {
        assert!(tokio::time::Instant::now() < deadline, "the broker saw only {:?}", broker.seen());
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn a_broker_that_answers_is_waited_for_and_the_update_resolves_subscribed() {
    // The grace is an hour: the update resolving at all shows it does not wait
    // the grace out when every broker has answered.
    let broker = FakeBroker::start().await;
    let rig = Rig::new();
    let flow = flow_subscribing(&[("n1", "ok", "t")]);

    rig.update(flow, &[settings("ok", &broker)], AN_HOUR).await.expect("the flow applied");

    // In place now: a message published at this moment reaches the node. Had
    // the update resolved first and subscribed after, the client would have
    // no subscription to route it to.
    broker.publish("t", b"21");
    assert_eq!(rig.wait_for_deliveries(1).await, vec![("n1".to_string(), "t".to_string())]);
    assert_eq!(rig.applied(), vec![vec!["n1".to_string()]]);
}

#[tokio::test]
async fn a_broker_that_does_not_answer_gets_its_grace_and_then_the_flow_goes_ahead_without_it() {
    let (late, healthy) = (FakeBroker::start().await, FakeBroker::start().await);
    late.go_silent();
    let rig = Rig::new();
    let brokers = [settings("late", &late), settings("ok", &healthy)];
    let flow = flow_subscribing(&[("n1", "late", "t/late"), ("n2", "ok", "t/ok")]);
    let grace = Duration::from_millis(300);

    // The late broker's connect is given an hour: the update resolving shows
    // it waited for the grace, not for the connect.
    let started = tokio::time::Instant::now();
    rig.update(flow, &brokers, grace).await.expect("the flow applied: a late broker is not a failed update");
    assert!(started.elapsed() >= grace, "the late broker was given its grace");

    // The flow is applied, whole, and the healthy broker's subscription is in
    // place at this moment.
    assert_eq!(rig.applied(), vec![vec!["n1".to_string(), "n2".to_string()]]);
    healthy.publish("t/ok", b"21");
    assert_eq!(rig.wait_for_deliveries(1).await, vec![("n2".to_string(), "t/ok".to_string())]);
    assert!(late.seen().is_empty(), "the late broker has answered nothing yet");

    // Its connect carried on. When it answers, the flow's subscription is made
    // on it — and nobody sent the flow again.
    late.answer_again();
    wait_until_saw(&late, &subscribed(1, "t/late")).await;
    late.publish("t/late", b"22");
    assert_eq!(rig.wait_for_deliveries(2).await[1], ("n1".to_string(), "t/late".to_string()));
    assert_eq!(rig.applied().len(), 1, "one flow update");
}

#[tokio::test]
async fn brokers_that_do_not_answer_are_waited_for_together() {
    // Two silent brokers and a grace of an hour. Both are dialled while the
    // update waits: were they taken one after the other, each with a grace of
    // its own, the second would not be dialled for an hour.
    let (first, second) = (FakeBroker::start().await, FakeBroker::start().await);
    first.go_silent();
    second.go_silent();
    let rig = Arc::new(Rig::new());
    let brokers = [settings("first", &first), settings("second", &second)];
    let flow = flow_subscribing(&[("n1", "first", "t/1"), ("n2", "second", "t/2")]);

    let update = tokio::spawn({
        let rig = Arc::clone(&rig);
        async move { rig.update(flow, &brokers, AN_HOUR).await }
    });
    first.wait_until_waiting(1).await;
    second.wait_until_waiting(1).await;
    assert!(!update.is_finished(), "the one grace is still running");
    assert!(rig.applied().is_empty());

    // Both answer within the grace: the update resolves with both subscribed.
    first.answer_again();
    second.answer_again();
    tokio::time::timeout(PATIENCE, update).await.expect("resolved").expect("ran").expect("the flow applied");
    wait_until_saw(&first, &subscribed(1, "t/1")).await;
    wait_until_saw(&second, &subscribed(1, "t/2")).await;
}

#[tokio::test]
async fn a_second_update_while_a_broker_is_still_connecting_opens_no_second_link() {
    let late = FakeBroker::start().await;
    late.go_silent();
    let rig = Rig::new();
    let brokers = [settings("late", &late)];
    let grace = Duration::from_millis(100);

    rig.update(flow_subscribing(&[("n1", "late", "t/1")]), &brokers, grace).await.expect("applied");
    rig.update(flow_subscribing(&[("n1", "late", "t/1"), ("n2", "late", "t/2")]), &brokers, grace)
        .await
        .expect("applied");
    // The second update found the first one's attempt still running, and
    // joined it.
    late.wait_until_waiting(1).await;

    late.answer_again();
    wait_until_saw(&late, &subscribed(1, "t/2")).await;
    assert_eq!(
        late.seen(),
        vec![Seen::Connected(1), subscribed(1, "t/1"), subscribed(1, "t/2")],
        "one link, carrying the flow as the second update left it"
    );
}

// --- the order of flow updates ------------------------------------------------------------------
//
// The webview sends a flow when it changed, and never the same one twice. The
// runtime must therefore end up on the last flow it was sent, also when an
// earlier one is still waiting for a broker.

/// A flow update on its own task.
fn updating(
    rig: &Arc<Rig>,
    flow: FlowUpdate,
    brokers: &[FrontendBrokerConfig],
    grace: Duration,
) -> tokio::task::JoinHandle<Result<(), String>> {
    let (rig, brokers) = (Arc::clone(rig), brokers.to_vec());
    tokio::spawn(async move { rig.update(flow, &brokers, grace).await })
}

/// How a flow update on its own task ended. It has to end.
async fn answer(update: tokio::task::JoinHandle<Result<(), String>>) -> Result<(), String> {
    tokio::time::timeout(PATIENCE, update).await.expect("the update resolved").expect("the update ran")
}

#[tokio::test]
async fn an_update_that_is_waiting_for_a_broker_when_a_newer_one_arrives_is_never_applied() {
    // A node on a broker that does not answer; then the node is deleted.
    let late = FakeBroker::start().await;
    late.go_silent();
    let rig = Arc::new(Rig::new());
    let older = updating(&rig, flow_subscribing(&[("n1", "late", "t/1")]), &[settings("late", &late)], AN_HOUR);
    late.wait_until_waiting(1).await;

    rig.update(flow_subscribing(&[]), &[], AN_HOUR).await.expect("the newer flow applied");

    // The older update resolves, though its broker has an hour of grace left,
    // and is not an error: the webview retries the flow it has on an error.
    answer(older).await.expect("an update that was replaced is not a failed update");
    assert_eq!(rig.applied(), vec![Vec::<String>::new()], "the runtime is on the newer flow, and only ever was");
}

#[tokio::test]
async fn an_update_that_was_replaced_answers_as_the_one_that_replaced_it() {
    // What the webview learns from the answer is whether the runtime is on a
    // flow at least as new as the one it sent.
    let late = FakeBroker::start().await;
    late.go_silent();
    let rig = Arc::new(Rig::new());
    let brokers = [settings("late", &late)];
    let older = updating(&rig, flow_subscribing(&[("n1", "late", "t/1")]), &brokers, AN_HOUR);
    late.wait_until_waiting(1).await;

    // The newer one waits for the same broker: neither has resolved.
    let newer = updating(&rig, flow_subscribing(&[("n1", "late", "t/1"), (REFUSED, "late", "t/2")]), &brokers, AN_HOUR);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!older.is_finished(), "the older update does not answer before the one that replaced it");
    assert!(!newer.is_finished());

    late.answer_again();
    let refused = answer(newer).await.expect_err("the runtime refused the newer flow");
    assert_eq!(answer(older).await, Err(refused), "the older update failed as the newer one did");
    assert!(rig.applied().is_empty(), "neither flow is running");
}

#[tokio::test]
async fn updates_that_keep_arriving_share_the_grace_of_the_broker_they_wait_for() {
    // The first update gives the broker a short grace. The second arrives
    // within it and would give an hour: it waits out what is left of the
    // first one's, and no longer — a stream of edits does not keep the flow
    // from ever reaching the runtime.
    let late = FakeBroker::start().await;
    late.go_silent();
    let rig = Arc::new(Rig::new());
    let brokers = [settings("late", &late)];
    let first = updating(&rig, flow_subscribing(&[("n1", "late", "t/1")]), &brokers, Duration::from_millis(300));
    late.wait_until_waiting(1).await;

    rig.update(flow_subscribing(&[("n1", "late", "t/1"), ("n2", "late", "t/2")]), &brokers, AN_HOUR)
        .await
        .expect("the newer flow applied");

    answer(first).await.expect("replaced, not failed");
    assert_eq!(rig.applied(), vec![vec!["n1".to_string(), "n2".to_string()]]);
}

// --- the grace is spent once ------------------------------------------------------------------------

#[tokio::test]
async fn a_broker_that_missed_its_grace_is_not_waited_for_again_while_it_stays_down() {
    let late = FakeBroker::start().await;
    late.go_silent();
    let rig = Rig::new();
    let brokers = [settings("late", &late)];
    let flow = |nodes: &[(&str, &str, &str)]| flow_subscribing(nodes);

    // The first update waits the grace out.
    rig.update(flow(&[("n1", "late", "t/1")]), &brokers, Duration::from_millis(300)).await.expect("applied");

    // The ones after it would give the broker an hour, and resolve: the grace
    // is for a broker that is about to come up, and this one has shown it is
    // not.
    rig.update(flow(&[("n1", "late", "t/1"), ("n2", "late", "t/2")]), &brokers, AN_HOUR).await.expect("applied");
    rig.update(flow(&[("n2", "late", "t/2")]), &brokers, AN_HOUR).await.expect("applied");
    assert_eq!(rig.applied().len(), 3);
    late.wait_until_waiting(1).await;

    // It comes up after all, on the attempt that was running all along, and
    // gets the flow as the last update left it.
    late.answer_again();
    wait_until_saw(&late, &subscribed(1, "t/2")).await;
    assert_eq!(late.seen(), vec![Seen::Connected(1), subscribed(1, "t/2")]);
}

#[tokio::test]
async fn a_broker_that_came_up_and_went_down_again_gets_a_grace_again() {
    let late = FakeBroker::start().await;
    late.go_silent();
    let rig = Arc::new(Rig::new());
    let brokers = [settings("late", &late)];
    rig.update(flow_subscribing(&[("n1", "late", "t/1")]), &brokers, Duration::from_millis(300)).await.expect("applied");
    late.answer_again();
    wait_until_saw(&late, &subscribed(1, "t/1")).await;

    // Down again: a new outage, and a broker that may be about to come up.
    late.go_silent();
    late.cut_links();
    late.wait_until_open(0).await;
    let offline = tokio::time::timeout(PATIENCE, async {
        while rig.pool.is_connected("late").await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    offline.await.expect("the pool noticed");

    let update = updating(&rig, flow_subscribing(&[("n1", "late", "t/1"), ("n2", "late", "t/2")]), &brokers, AN_HOUR);
    late.wait_until_waiting(1).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!update.is_finished(), "the broker is waited for again");

    late.answer_again();
    answer(update).await.expect("applied");
    wait_until_saw(&late, &subscribed(2, "t/2")).await;
}

#[tokio::test]
async fn a_broker_that_missed_its_grace_gets_one_again_when_its_settings_change() {
    let (wrong, right) = (FakeBroker::start().await, FakeBroker::start().await);
    wrong.go_silent();
    right.go_silent();
    let rig = Arc::new(Rig::new());
    let flow = || flow_subscribing(&[("n1", "b", "t/1")]);
    rig.update(flow(), &[settings("b", &wrong)], Duration::from_millis(300)).await.expect("applied");

    // The user corrects the broker's address: other settings, another broker
    // that may be about to come up. (The flow is sent again because its
    // broker's settings are part of what the webview compares.)
    let update = updating(&rig, flow(), &[settings("b", &right)], AN_HOUR);
    right.wait_until_waiting(1).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!update.is_finished(), "the broker is waited for on its new settings");

    right.answer_again();
    answer(update).await.expect("applied");
    wait_until_saw(&right, &subscribed(1, "t/1")).await;
    assert_eq!(rig.applied().len(), 2);
}
