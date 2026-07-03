//! Monitor emitter — the on-device counterpart of `runtime/output/monitor.rs`.
//!
//! The live Monitor component is a display-only sink: it receives values on its
//! `value` port and stores them for visualisation in the host frontend. There is
//! no hardware interaction. On a networked target (ESP32) there is no host to
//! store into, so the standalone analogue is to **send each received value over
//! the same network transport the Mqtt Node uses** (`WiFi` + `PubSubClient`) on a
//! deterministic monitor topic, so a host can still visualise the device's
//! values. This mirrors the live "receive a value → surface it" semantics,
//! redirected onto the network since no host event loop is present.
//!
//! The transport bring-up and `WiFi` credential reuse are shared via
//! [`crate::codegen::cloud::transport`] / [`crate::codegen::credentials`].
//!
//! ## Config (`node.data`)
//!
//! Read leniently, accepting both the live runtime shape and the generation
//! request shape:
//! - `broker` / `brokerId` — broker host.
//! - `port` — broker TCP port (default `1883`).
//! - `uniqueId` — the microflow instance id used to build the topic.
//! - `wifiSsid`, `brokerUsername`, `brokerPassword` — credentials. When
//!   `wifiSsid`/`broker` are absent the Sketch emits a clearly-marked credential
//!   placeholder and a `#warning` rather than silently failing to connect.
//!
//! Topic: `microflow/<uniqueId>/monitor/<token>` — Node-scoped so multiple
//! Monitor Nodes publish to distinct topics.
//!
//! Like every emitter this is a pure function of the [`FlowNode`]: identical
//! input yields byte-identical output (determinism invariant).

use crate::codegen::cloud::transport::{cpp_string, Transport, DEFAULT_PORT};
use crate::codegen::emit::{str_or_default, u16_or_default, NodeEmission, NodeToken};
use crate::codegen::wire::{extra_sources_note, NodeInputs};
use crate::flow::FlowNode;

/// A single config value read from `data`, first non-empty key winning.
fn first_non_empty(node: &FlowNode, keys: &[&str], default: &str) -> String {
    for key in keys {
        let value = str_or_default(node, key, "");
        if !value.is_empty() {
            return value;
        }
    }
    default.to_string()
}

/// Emit C++ for a Monitor Cloud Node on a networked target.
///
/// The first source wired into the `value` port is the displayed value; each
/// time it changes the Sketch publishes it on the monitor topic. An unwired
/// Monitor has nothing to display, so it only maintains its connection.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let sources = inputs.on("value");
    let driver = sources.first().map(|s| s.value.as_string());
    let token = node.id_token();
    let prefix = format!("monitor_{token}");

    let broker = first_non_empty(node, &["broker", "brokerId"], "");
    let port = u16_or_default(node, "port", DEFAULT_PORT);
    let unique_id = first_non_empty(node, &["uniqueId"], "");
    let wifi_ssid = first_non_empty(node, &["wifiSsid"], "");
    let broker_user = first_non_empty(node, &["brokerUsername"], "");
    let broker_pass = first_non_empty(node, &["brokerPassword"], "");

    let topic = format!("microflow/{unique_id}/monitor/{token}");
    let credentials_missing = wifi_ssid.is_empty() || broker.is_empty();

    let topic_var = format!("{prefix}_topic");
    let last_var = driver.as_ref().map(|_| format!("{prefix}_last_published"));

    // Monitor is publish-only — it never subscribes.
    let transport = Transport {
        prefix: &prefix,
        broker: &broker,
        port,
        broker_user: &broker_user,
        broker_pass: &broker_pass,
        subscriptions: &[],
        on_message: None,
        kind: "Monitor",
        credentials_missing,
    };

    let mut extra_decls = vec![format!("const char* {topic_var} = {};", cpp_string(&topic))];
    if let Some(note) = extra_sources_note("value", sources) {
        extra_decls.push(note);
    }
    if let Some(last) = &last_var {
        extra_decls.push(format!("String {last};"));
    }

    // loop() tail: publish each received value on change (mirrors the live sink
    // surfacing the latest value; de-dupe on change since there is no host loop).
    let mut loop_tail = Vec::new();
    if let (Some(expr), Some(last)) = (&driver, &last_var) {
        let mqtt_client = transport.mqtt_client();
        loop_tail.push(format!("if ({mqtt_client}.connected()) {{"));
        loop_tail.push(format!("  String {prefix}_next = {expr};"));
        loop_tail.push(format!("  if ({prefix}_next != {last}) {{"));
        loop_tail.push(format!("    {mqtt_client}.publish({topic_var}, {prefix}_next.c_str());"));
        loop_tail.push(format!("    {last} = {prefix}_next;"));
        loop_tail.push("  }".to_string());
        loop_tail.push("}".to_string());
    } else {
        loop_tail.push(format!(
            "// Monitor Node {token} has no wired input — nothing to display/publish"
        ));
    }

    transport.emission(extra_decls, loop_tail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn monitor(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Monitor".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn joined(lines: &[String]) -> String {
        lines.join("\n")
    }

    /// A single numeric source wired into the `value` port.
    fn value_input(expr: &str) -> NodeInputs {
        use crate::codegen::wire::{CppExpr, SourceExpr};
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::level(CppExpr::number(expr)));
        inputs
    }

    /// Scenario: Monitor Node emits working code on a `WiFi`-capable target —
    /// pulls in the `WiFi` + MQTT client libraries (the network transport).
    #[test]
    fn monitor_pulls_in_wifi_and_mqtt_client_libraries() {
        let e = emit(&monitor("mon-1", json!({ "broker": "b", "uniqueId": "u", "wifiSsid": "net" })), &value_input("v"));
        assert!(e.includes.iter().any(|i| i.contains("WiFi.h")), "missing WiFi include");
        assert!(e.includes.iter().any(|i| i.contains("PubSubClient.h")), "missing MQTT client include");
    }

    /// Scenario: connects on boot and drives the Monitor over the network
    /// transport (publishes received values on its monitor topic).
    #[test]
    fn connects_and_publishes_received_values_over_transport() {
        let e = emit(
            &monitor("mon-1", json!({ "broker": "broker.example.com", "uniqueId": "abc", "wifiSsid": "net" })),
            &value_input("sensor_s_1_value"),
        );
        let decls = joined(&e.declarations);
        let setup = joined(&e.setup);
        let body = joined(&e.loop_body);
        assert!(setup.contains("ensure_connected()"), "connects on boot");
        assert!(decls.contains("setServer(monitor_mon_1_broker"), "points at the broker");
        assert!(decls.contains("microflow/abc/monitor/mon_1"), "monitor topic is node-scoped");
        assert!(body.contains("publish(monitor_mon_1_topic"), "publishes on its topic");
        assert!(body.contains("sensor_s_1_value"), "publishes the received value");
    }

    /// Scenario: the loop maintains the connection (reconnect on drop).
    #[test]
    fn loop_maintains_connection_and_pumps_client() {
        let e = emit(&monitor("mon-1", json!({ "broker": "b", "uniqueId": "u", "wifiSsid": "net" })), &value_input("v"));
        let body = joined(&e.loop_body);
        assert!(body.contains("ensure_connected()"), "reconnects in loop");
        assert!(body.contains("monitor_mon_1_client.loop()"), "pumps the MQTT client");
    }

    /// An unwired Monitor still connects but has nothing to publish.
    #[test]
    fn unwired_monitor_has_nothing_to_publish() {
        let e = emit(&monitor("mon-1", json!({ "broker": "b", "uniqueId": "u", "wifiSsid": "net" })), &NodeInputs::default());
        let body = joined(&e.loop_body);
        assert!(body.contains("nothing to display"), "no publish without a wired input");
        assert!(!body.contains("publish(monitor_mon_1_topic"), "does not publish when unwired");
    }

    /// Scenario: Missing credentials produce a safe placeholder + a warning.
    #[test]
    fn missing_credentials_produce_safe_placeholder_and_warning() {
        let e = emit(&monitor("mon-1", json!({ "uniqueId": "u" })), &value_input("v"));
        let decls = joined(&e.declarations);
        assert!(decls.contains("REPLACE_ME"), "emits a credential placeholder");
        assert!(decls.contains("#warning"), "warns the Author at compile time");
        assert!(joined(&e.setup).contains("ensure_connected()"), "still attempts to connect");
    }

    /// Determinism: identical Node yields byte-identical emission.
    #[test]
    fn emits_deterministically() {
        let n = monitor("mon-1", json!({ "broker": "b", "uniqueId": "u", "wifiSsid": "net" }));
        assert_eq!(emit(&n, &value_input("v")), emit(&n, &value_input("v")));
    }
}
