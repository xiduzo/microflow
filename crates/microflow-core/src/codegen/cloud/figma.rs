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
use crate::codegen::wire::{CppExpr, NodeInputs, SourceExpr};
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

/// Convert `VariableID:123:456` → `123-456`, mirroring
/// `runtime/external/figma.rs::short_var_id`.
fn short_var_id(variable_id: &str) -> String {
    variable_id.replace("VariableID:", "").replace(':', "-")
}

/// Emit C++ for a Figma Cloud Node on a networked target.
///
/// The `set` port publishes each new sample of its first wired source back to
/// Figma on the set topic (the on-device twin of the live set dispatch). The
/// runtime's other mutation ports (`true`/`false`/`toggle`, the numeric
/// `increment`/`decrement`/`reset`, and the color channels) manipulate typed
/// Figma variables the generated sketch does not model; wiring them emits an
/// explicit note. When unwired, the Node is subscribe-only.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let driver_source = inputs.first("set");
    let driver = driver_source.map(|s| s.value.as_string());
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
    let last_var = driver.as_ref().map(|_| format!("{prefix}_last_published"));

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

    // Extra sources on `set` and the unmodelled mutation ports are surfaced as
    // notes rather than silently dropped.
    if inputs.on("set").len() > 1 {
        extra_decls.push(format!(
            "// note: {} additional source(s) wired into 'set' are ignored — generated code follows the first source only",
            inputs.on("set").len() - 1
        ));
    }
    for port in [
        "true", "false", "toggle", "increment", "decrement", "reset", "red", "green", "blue",
        "opacity",
    ] {
        if !inputs.on(port).is_empty() {
            extra_decls.push(format!(
                "// note: input '{port}' mutates a typed Figma variable codegen does not model — edge ignored"
            ));
        }
    }

    // loop() tail: when driven, publish the new value back to Figma on the set
    // topic — but only when it changed, mirroring the live debounced dispatch
    // (no host event loop here, so de-dupe on value change instead of time).
    let mut loop_tail = Vec::new();
    if let (Some(expr), Some(last)) = (&driver, &last_var) {
        let mqtt_client = transport.mqtt_client();
        loop_tail.push(format!("if ({mqtt_client}.connected()) {{"));
        loop_tail.push(format!("  String {prefix}_next = {expr};"));
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

/// What downstream Nodes read from a Figma Node: the latest inbound variable
/// value parsed as a number (`toFloat`), mirroring the live component's parse
/// of FLOAT variables — the common case for hardware-driving design tokens.
#[must_use]
pub fn output(node: &FlowNode) -> Option<SourceExpr> {
    let token = node.id_token();
    Some(SourceExpr::level(CppExpr::number(format!(
        "figma_{token}_value.toFloat()"
    ))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
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

    /// A single numeric source wired into the `set` port.
    fn set_input(expr: &str) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add("set", SourceExpr::level(CppExpr::number(expr)));
        inputs
    }

    /// Scenario: Figma Node emits working code on a `WiFi`-capable target — pulls
    /// in the `WiFi` + MQTT client libraries (the network transport).
    #[test]
    fn figma_pulls_in_wifi_and_mqtt_client_libraries() {
        let e = emit(
            &figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "wifiSsid": "net" })),
            &NodeInputs::default(),
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
            &NodeInputs::default(),
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
        let e = emit(&n, &NodeInputs::default());
        let decls = joined(&e.declarations);
        assert!(decls.contains("figma_f_1_value"), "buffers the inbound value");
        assert!(decls.contains("setCallback") || joined(&e.setup).contains("setCallback"));
        assert_eq!(
            output(&n).map(|s| s.value.code),
            Some("figma_f_1_value.toFloat()".to_string())
        );
    }

    /// A Figma Node with a wired `set` port publishes the new value back to
    /// Figma on the set topic — over the same network transport.
    #[test]
    fn set_port_publishes_value_back_to_figma() {
        let e = emit(
            &figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "wifiSsid": "net" })),
            &set_input("sensor_s_1_value"),
        );
        let body = joined(&e.loop_body);
        let decls = joined(&e.declarations);
        assert!(decls.contains("microflow/u/app/variable/1-2/set"), "set topic mirrors live");
        assert!(body.contains("publish(figma_f_1_set_topic"), "publishes to the set topic");
        assert!(body.contains("sensor_s_1_value"), "publishes the driven value");
    }

    /// Unmodelled mutation ports are noted instead of silently dropped.
    #[test]
    fn unmodelled_mutation_ports_are_noted() {
        let mut inputs = NodeInputs::default();
        inputs.add("toggle", SourceExpr::level(CppExpr::boolean("btn")));
        let e = emit(
            &figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "wifiSsid": "net" })),
            &inputs,
        );
        assert!(
            joined(&e.declarations).contains("input 'toggle' mutates a typed Figma variable"),
            "wired toggle is noted"
        );
    }

    /// Scenario: the loop maintains the connection (reconnect on drop).
    #[test]
    fn loop_maintains_connection_and_pumps_client() {
        let e = emit(&figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "wifiSsid": "net" })), &NodeInputs::default());
        let body = joined(&e.loop_body);
        assert!(body.contains("ensure_connected()"), "reconnects in loop");
        assert!(body.contains("figma_f_1_client.loop()"), "pumps the MQTT client");
    }

    /// Scenario: Missing credentials produce a safe placeholder + a warning.
    #[test]
    fn missing_credentials_produce_safe_placeholder_and_warning() {
        let e = emit(&figma("f-1", json!({ "uniqueId": "u", "variableId": "VariableID:1:2" })), &set_input("v"));
        let decls = joined(&e.declarations);
        assert!(decls.contains("REPLACE_ME"), "emits a credential placeholder");
        assert!(decls.contains("#warning"), "warns the Author at compile time");
        assert!(joined(&e.setup).contains("ensure_connected()"), "still attempts to connect");
    }

    /// Determinism: identical Node yields byte-identical emission.
    #[test]
    fn emits_deterministically() {
        let n = figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "wifiSsid": "net" }));
        assert_eq!(emit(&n, &set_input("v")), emit(&n, &set_input("v")));
    }

    /// Topic strings are escaped so generation stays valid.
    #[test]
    fn topics_are_escaped() {
        let e = emit(&figma("f-1", json!({ "broker": "b", "uniqueId": "a\"b", "variableId": "VariableID:1:2", "wifiSsid": "net" })), &NodeInputs::default());
        assert!(joined(&e.declarations).contains("a\\\"b"), "escapes the quote in the topic");
    }
}
