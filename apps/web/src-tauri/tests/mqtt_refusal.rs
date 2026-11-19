//! A broker that speaks only MQTT 3.1.1, as the desktop host meets it: the pool
//! connects with MQTT 5 only, and such a broker refuses it in one of three
//! ways. The two that say why — a 3.1.1 CONNACK with return code 1, an MQTT 5
//! CONNACK with reason code 0x84 — leave the broker in `error` with
//! [`MQTT5_REQUIRED`], on the first connect and on a link the client repairs
//! by itself, and the status the webview is sent carries it. One that closes
//! the connection without a CONNACK is an error with nothing claimed about it.

use app_lib::mqtt::broker::{ConnectionStatus, ReconnectConfig, MQTT5_REQUIRED};
use app_lib::mqtt::commands::BrokerStatuses;
use app_lib::mqtt::MqttManager;
use std::time::Duration;

#[path = "support/fake_broker.rs"]
mod fake_broker;
use fake_broker::{FakeBroker, Refusal, PATIENCE};

/// A pool whose clients try to repair a dropped link every `delay`.
fn pool(delay: Duration) -> MqttManager {
    MqttManager::with_reconnect_config(ReconnectConfig {
        initial_delay: delay,
        max_delay: delay,
        multiplier: 1.0,
        connect_timeout: PATIENCE,
        ..ReconnectConfig::default()
    })
}

/// What the webview is sent about broker `b`: its status and its problem.
async fn shown(manager: &MqttManager) -> serde_json::Value {
    let statuses = serde_json::to_value(BrokerStatuses::from(&manager.status_snapshot().await)).expect("json");
    statuses["brokers"][0].clone()
}

#[tokio::test]
async fn a_broker_that_refuses_mqtt_5_with_a_connack_of_either_version_is_in_error_for_it() {
    for refusal in [Refusal::Connack311, Refusal::Connack5] {
        let broker = FakeBroker::start().await;
        broker.speak_only_3_1_1(refusal);
        let manager = pool(Duration::from_secs(3600));

        let connected = tokio::time::timeout(PATIENCE, manager.connect(broker.config())).await.expect("answered");

        assert_eq!(connected, Err(MQTT5_REQUIRED.to_string()), "{refusal:?}");
        assert_eq!(manager.status("b").await, ConnectionStatus::Error);
        assert_eq!(manager.status_snapshot().await.problems, [("b".to_string(), MQTT5_REQUIRED)], "{refusal:?}");
        assert_eq!(shown(&manager).await, serde_json::json!({ "id": "b", "status": "error", "problem": MQTT5_REQUIRED }));
    }
}

#[tokio::test]
async fn a_broker_that_closes_the_connection_without_a_connack_is_in_error_with_nothing_claimed() {
    let broker = FakeBroker::start().await;
    broker.speak_only_3_1_1(Refusal::Close);
    let manager = pool(Duration::from_secs(3600));

    let connected = tokio::time::timeout(PATIENCE, manager.connect(broker.config())).await.expect("answered");

    assert!(connected.is_err_and(|e| e != MQTT5_REQUIRED), "the close is no refusal of the protocol version");
    assert_eq!(manager.status("b").await, ConnectionStatus::Error);
    assert_eq!(manager.status_snapshot().await.problems, [] as [(String, &str); 0]);
    assert_eq!(shown(&manager).await, serde_json::json!({ "id": "b", "status": "error", "problem": null }));
}

#[tokio::test]
async fn a_link_repaired_against_a_broker_that_now_refuses_mqtt_5_is_in_error_for_it_until_it_connects() {
    let broker = FakeBroker::start().await;
    let manager = pool(Duration::from_millis(100));
    manager.connect(broker.config()).await.expect("connect");
    assert_eq!(manager.status_snapshot().await.problems, [] as [(String, &str); 0]);

    // The broker is replaced by one that speaks only MQTT 3.1.1: the link
    // drops, and the client repairs it by itself.
    broker.speak_only_3_1_1(Refusal::Connack311);
    broker.cut_links();
    let refused = tokio::time::timeout(PATIENCE, async {
        while manager.status_snapshot().await.problems.is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    assert!(refused.await.is_ok(), "the repair was never refused");
    assert_eq!(manager.status_snapshot().await.problems, [("b".to_string(), MQTT5_REQUIRED)]);

    // And one that speaks MQTT 5 again.
    broker.speak_mqtt_5();
    let repaired = tokio::time::timeout(PATIENCE, async {
        while manager.status("b").await != ConnectionStatus::Connected {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    assert!(repaired.await.is_ok(), "the link was never repaired");
    assert_eq!(manager.status_snapshot().await.problems, [] as [(String, &str); 0]);
}
