//! Figma emitter — the on-device counterpart of `runtime/external/figma.rs`.
//!
//! The live Figma component bridges Figma design variables into the Flow **over
//! MQTT**: it subscribes to the plugin/app variable topics for inbound values
//! (surfacing the latest as its value) and, when driven, publishes the new value
//! back to Figma on a `.../set` topic. On a networked target (ESP32) there is no
//! host, so the generated Sketch does this itself using the **same network
//! transport the Mqtt Node uses** (`WiFi` + `PubSubClient`), reusing the shared
//! [`crate::codegen::cloud::transport`] bring-up and the shared `WiFi`
//! credentials preamble. This mirrors the live semantics so standalone behaviour
//! matches live mode.
//!
//! ## Config (`node.data`)
//!
//! Read leniently, accepting both the live runtime shape and the generation
//! request shape:
//! - `broker` / `brokerId` — broker host.
//! - `port` — broker TCP port (default `1883`).
//! - `uniqueId` — the microflow instance id used to build the topics.
//! - `variableId` — the Figma `VariableID:123:456`, normalised to `123-456`.
//! - `wifiSsid`, `brokerUsername`, `brokerPassword` — credentials. When
//!   `wifiSsid`/`broker` are absent the Sketch emits a clearly-marked credential
//!   placeholder and a `#warning` rather than silently failing to connect.
//!
//! Topics mirror the live component exactly:
//! - inbound: `microflow/<uniqueId>/figma/variable/<shortVarId>` and
//!   `microflow/<uniqueId>/app/variable/<shortVarId>`
//! - outbound (set): `microflow/<uniqueId>/app/variable/<shortVarId>/set`
//!
//! Like every emitter this is a pure function of the [`FlowNode`]: identical
//! input yields byte-identical output (determinism invariant).

use crate::codegen::cloud::transport::{cpp_string, Subscription, Transport, DEFAULT_PORT};
use crate::codegen::emit::{str_or_default, u16_or_default, NodeEmission, NodeToken};
use crate::runtime::types::FlowNode;

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

/// Convert `VariableID:123:456` → `123-456`, mirroring
/// `runtime/external/figma.rs::short_var_id`.
fn short_var_id(variable_id: &str) -> String {
    variable_id.replace("VariableID:", "").replace(':', "-")
}

/// Emit C++ for a Figma Cloud Node on a networked target.
///
/// `driver` is the C++ expression that, each time it changes, is published back
/// to Figma (the new variable value). When unwired, the Node is subscribe-only.
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let token = node.id_token();
    let prefix = format!("figma_{token}");

    let broker = first_non_empty(node, &["broker", "brokerId"], "");
    let port = u16_or_default(node, "port", DEFAULT_PORT);
    let unique_id = first_non_empty(node, &["uniqueId"], "");
    let variable_id = first_non_empty(node, &["variableId"], "");
    let wifi_ssid = first_non_empty(node, &["wifiSsid"], "");
    let broker_user = first_non_empty(node, &["brokerUsername"], "");
    let broker_pass = first_non_empty(node, &["brokerPassword"], "");

    let short = short_var_id(&variable_id);
    let plugin_topic = format!("microflow/{unique_id}/figma/variable/{short}");
    let app_topic = format!("microflow/{unique_id}/app/variable/{short}");
    let set_topic = format!("microflow/{unique_id}/app/variable/{short}/set");

    // Missing essential connection details → loud placeholder + #warning.
    let credentials_missing = wifi_ssid.is_empty() || broker.is_empty();

    // Per-Node symbols.
    let plugin_topic_var = format!("{prefix}_plugin_topic");
    let app_topic_var = format!("{prefix}_app_topic");
    let set_topic_var = format!("{prefix}_set_topic");
    let value_var = format!("{prefix}_value");
    let callback = format!("{prefix}_on_message");
    let last_var = driver.map(|_| format!("{prefix}_last_published"));

    let subscriptions = vec![
        Subscription { topic_var: plugin_topic_var.clone() },
        Subscription { topic_var: app_topic_var.clone() },
    ];

    let transport = Transport {
        prefix: &prefix,
        broker: &broker,
        port,
        broker_user: &broker_user,
        broker_pass: &broker_pass,
        subscriptions: &subscriptions,
        on_message: Some(&callback),
        kind: "Figma",
        credentials_missing,
    };

    // Node-specific declarations: topic strings, the inbound value buffer, and
    // the inbound-message callback that surfaces the latest value (mirrors the
    // live component emitting a "change" downstream when a value arrives).
    let mut extra_decls = vec![
        format!("const char* {plugin_topic_var} = {};", cpp_string(&plugin_topic)),
        format!("const char* {app_topic_var} = {};", cpp_string(&app_topic)),
        format!("const char* {set_topic_var} = {};", cpp_string(&set_topic)),
        format!("String {value_var};"),
    ];
    if let Some(last) = &last_var {
        extra_decls.push(format!("String {last};"));
    }
    extra_decls.push(format!(
        "void {callback}(char* topic, byte* payload, unsigned int length) {{"
    ));
    extra_decls.push(format!("  {value_var} = String();"));
    extra_decls.push("  for (unsigned int i = 0; i < length; i++) {".to_string());
    extra_decls.push(format!("    {value_var} += (char)payload[i];"));
    extra_decls.push("  }".to_string());
    extra_decls.push("}".to_string());

    // loop() tail: when driven, publish the new value back to Figma on the set
    // topic — but only when it changed, mirroring the live debounced dispatch
    // (no host event loop here, so de-dupe on value change instead of time).
    let mut loop_tail = Vec::new();
    if let (Some(expr), Some(last)) = (driver, &last_var) {
        let mqtt_client = transport.mqtt_client();
        loop_tail.push(format!("if ({mqtt_client}.connected()) {{"));
        loop_tail.push(format!("  String {prefix}_next = String({expr});"));
        loop_tail.push(format!("  if ({prefix}_next != {last}) {{"));
        loop_tail.push(format!("    {mqtt_client}.publish({set_topic_var}, {prefix}_next.c_str());"));
        loop_tail.push(format!("    {last} = {prefix}_next;"));
        loop_tail.push("  }".to_string());
        loop_tail.push("}".to_string());
    } else {
        loop_tail.push(format!(
            "// Figma Node {token} has no wired input — subscribe-only, nothing to publish"
        ));
    }

    transport.emission(extra_decls, loop_tail)
}

/// The C++ expression downstream Nodes read for a Figma Node: the latest inbound
/// variable value as a number (`toFloat`), mirroring the live component
/// surfacing the arrived value.
#[must_use]
pub fn value_var(node: &FlowNode) -> Option<String> {
    let token = node.id_token();
    Some(format!("figma_{token}_value.toFloat()"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::Position;
    use serde_json::json;

    fn figma(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Figma".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn joined(lines: &[String]) -> String {
        lines.join("\n")
    }

    /// Scenario: Figma Node emits working code on a `WiFi`-capable target — pulls
    /// in the `WiFi` + MQTT client libraries (the network transport).
    #[test]
    fn figma_pulls_in_wifi_and_mqtt_client_libraries() {
        let e = emit(
            &figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "wifiSsid": "net" })),
            None,
        );
        assert!(e.includes.iter().any(|i| i.contains("WiFi.h")), "missing WiFi include");
        assert!(e.includes.iter().any(|i| i.contains("PubSubClient.h")), "missing MQTT client include");
    }

    /// Scenario: the Sketch connects to the network/broker on boot and drives the
    /// Figma Node over the network transport (subscribes to its variable topics).
    #[test]
    fn connects_and_subscribes_to_figma_variable_topics() {
        let e = emit(
            &figma(
                "f-1",
                json!({ "broker": "broker.example.com", "uniqueId": "abc", "variableId": "VariableID:123:456", "wifiSsid": "net" }),
            ),
            None,
        );
        let decls = joined(&e.declarations);
        let setup = joined(&e.setup);
        assert!(setup.contains("ensure_connected()"), "connects on boot");
        assert!(decls.contains("setServer(figma_f_1_broker"), "points at the broker");
        // Topics mirror the live component (short var id 123-456).
        assert!(decls.contains("microflow/abc/figma/variable/123-456"), "plugin topic");
        assert!(decls.contains("microflow/abc/app/variable/123-456"), "app topic");
        assert!(decls.contains("subscribe(figma_f_1_plugin_topic)"), "subscribes plugin topic");
        assert!(decls.contains("subscribe(figma_f_1_app_topic)"), "subscribes app topic");
    }

    /// A subscribe-only Figma Node surfaces inbound values for downstream Nodes.
    #[test]
    fn surfaces_inbound_variable_value() {
        let n = figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "wifiSsid": "net" }));
        let e = emit(&n, None);
        let decls = joined(&e.declarations);
        assert!(decls.contains("figma_f_1_value"), "buffers the inbound value");
        assert!(decls.contains("setCallback") || joined(&e.setup).contains("setCallback"));
        assert_eq!(value_var(&n).as_deref(), Some("figma_f_1_value.toFloat()"));
    }

    /// A driven Figma Node publishes the new value back to Figma on the set
    /// topic — over the same network transport.
    #[test]
    fn driven_node_publishes_value_back_to_figma() {
        let e = emit(
            &figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "wifiSsid": "net" })),
            Some("sensor_s_1_value"),
        );
        let body = joined(&e.loop_body);
        let decls = joined(&e.declarations);
        assert!(decls.contains("microflow/u/app/variable/1-2/set"), "set topic mirrors live");
        assert!(body.contains("publish(figma_f_1_set_topic"), "publishes to the set topic");
        assert!(body.contains("sensor_s_1_value"), "publishes the driven value");
    }

    /// Scenario: the loop maintains the connection (reconnect on drop).
    #[test]
    fn loop_maintains_connection_and_pumps_client() {
        let e = emit(&figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "wifiSsid": "net" })), None);
        let body = joined(&e.loop_body);
        assert!(body.contains("ensure_connected()"), "reconnects in loop");
        assert!(body.contains("figma_f_1_client.loop()"), "pumps the MQTT client");
    }

    /// Scenario: Missing credentials produce a safe placeholder + a warning.
    #[test]
    fn missing_credentials_produce_safe_placeholder_and_warning() {
        let e = emit(&figma("f-1", json!({ "uniqueId": "u", "variableId": "VariableID:1:2" })), Some("v"));
        let decls = joined(&e.declarations);
        assert!(decls.contains("REPLACE_ME"), "emits a credential placeholder");
        assert!(decls.contains("#warning"), "warns the Author at compile time");
        assert!(joined(&e.setup).contains("ensure_connected()"), "still attempts to connect");
    }

    /// Determinism: identical Node yields byte-identical emission.
    #[test]
    fn emits_deterministically() {
        let n = figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "wifiSsid": "net" }));
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }

    /// Topic strings are escaped so generation stays valid.
    #[test]
    fn topics_are_escaped() {
        let e = emit(&figma("f-1", json!({ "broker": "b", "uniqueId": "a\"b", "variableId": "VariableID:1:2", "wifiSsid": "net" })), None);
        assert!(joined(&e.declarations).contains("a\\\"b"), "escapes the quote in the topic");
    }
}
