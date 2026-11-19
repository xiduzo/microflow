//! Figma emitter — the on-device counterpart of `nodes/figma/runtime.rs`.
//!
//! The live Figma component bridges design-tool variables (Figma variables,
//! Penpot tokens) into the Flow **over MQTT**: it subscribes to the plugin/app variable topics for inbound values
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
//! - `source` — the design tool (`figma` / `penpot`), the plugin's topic segment.
//! - `uniqueId` — the Bridge ID used to build the topics.
//! - `variableId` — the tool's variable ID (Figma `VariableID:123:456` → `123-456`).
//!
//! Broker host/port/auth and the `WiFi` SSID come from the generate-time
//! `credentials` surface when supplied there, falling back to the Node's own
//! `data` (`broker`, `port`, `brokerUsername`, `brokerPassword`, `wifiSsid`).
//! When the SSID or broker is absent the Sketch emits a clearly-marked credential
//! placeholder and a `#warning` rather than silently failing to connect.
//!
//! Topics come from [`crate::design_bridge`], exactly as in the live component:
//! - inbound: `microflow/<uniqueId>/<source>/variable/<wireId>` and
//!   `microflow/<uniqueId>/app/variable/<wireId>`
//! - outbound (set): `microflow/<uniqueId>/app/variable/<wireId>/set`
//!
//! Like every emitter this is a pure function of the [`FlowNode`]: identical
//! input yields byte-identical output (determinism invariant).

use super::config::FigmaConfig;
use crate::design_bridge::{self as protocol, VariableKind, DESIGN_TOOLS, STUDIO};
use crate::codegen::cloud::payload::{bridge_payload, BRIDGE, NUMBER_TEXT};
use crate::codegen::cloud::transport::{Subscription, Transport, DEFAULT_PORT};
use crate::codegen::credentials::{supplied_or, Credentials};
use crate::codegen::emit::{cpp_string_literal, str_first_non_empty, u16_or_default, NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, CppExpr, NodeInputs, SourceExpr};
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;

/// Emit C++ for a Figma Cloud Node on a networked target.
///
/// Each pulse on the `set` port (from every source wired into it) is the
/// on-device twin of one live `set` dispatch: the value is coerced to the
/// variable's type and, when it fits, published on the set topic with the
/// payload the live node writes, and the node emits it on `value` and
/// `change` (the live node emits what it sets). A value that does not fit is
/// dropped, as live. The runtime's other mutation ports (`true`/`false`/
/// `toggle`, the numeric `increment`/`decrement`/`reset`, and the color
/// channels) work on the variable's current value, which the sketch does not
/// keep; wiring them emits an explicit note. When unwired, the Node is
/// subscribe-only.
pub(crate) fn emit(
    node: &FlowNode,
    inputs: &NodeInputs,
    credentials: Option<&Credentials>,
) -> Result<NodeEmission, UnreadableConfig> {
    let token = node.id_token();
    let prefix = format!("figma_{token}");

    // `brokerId` is the editor's opaque broker-store id, not a host; only an
    // explicit `broker` in the node data is a fallback for the credentials.
    let broker = supplied_or(
        credentials.map_or("", |c| c.broker_host.as_str()),
        str_first_non_empty(node, &["broker"], ""),
    );
    let port = credentials
        .map(|c| c.broker_port)
        .filter(|p| *p != 0)
        .unwrap_or_else(|| u16_or_default(node, "port", DEFAULT_PORT));
    let config = resolve::<FigmaConfig>(&node.data)?;
    let wifi_ssid = supplied_or(
        credentials.map_or("", |c| c.wifi_ssid.as_str()),
        str_first_non_empty(node, &["wifiSsid"], ""),
    );
    let broker_user = supplied_or(
        credentials.map_or("", |c| c.broker_username.as_str()),
        str_first_non_empty(node, &["brokerUsername"], ""),
    );
    let broker_pass = supplied_or(
        credentials.map_or("", |c| c.broker_password.as_str()),
        str_first_non_empty(node, &["brokerPassword"], ""),
    );

    let tool = DESIGN_TOOLS
        .iter()
        .find(|tool| **tool == config.source)
        .unwrap_or(&DESIGN_TOOLS[0]);
    let uid = &config.unique_id;
    let wire_id = protocol::wire_id(&config.variable_id);
    let plugin_topic = protocol::value_topic(uid, tool, &wire_id);
    let app_topic = protocol::value_topic(uid, STUDIO, &wire_id);
    let set_topic = protocol::set_topic(uid, &wire_id);
    let kind = VariableKind::of(&config.resolved_type);

    // Missing essential connection details → loud placeholder + #warning.
    let credentials_missing = wifi_ssid.is_empty() || broker.is_empty();

    // Per-Node symbols.
    let plugin_topic_var = format!("{prefix}_plugin_topic");
    let app_topic_var = format!("{prefix}_app_topic");
    let set_topic_var = format!("{prefix}_set_topic");
    let value_var = format!("{prefix}_value");
    let received = received_var(&token);
    let callback = format!("{prefix}_on_message");

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
        format!("const char* {plugin_topic_var} = {};", cpp_string_literal(&plugin_topic)),
        format!("const char* {app_topic_var} = {};", cpp_string_literal(&app_topic)),
        format!("const char* {set_topic_var} = {};", cpp_string_literal(&set_topic)),
        format!("String {value_var};"),
        format!("bool {received} = false;"),
    ];
    extra_decls.push(format!(
        "void {callback}(char* topic, byte* payload, unsigned int length) {{"
    ));
    extra_decls.push(format!("  {value_var} = String();"));
    extra_decls.push("  for (unsigned int i = 0; i < length; i++) {".to_string());
    extra_decls.push(format!("    {value_var} += (char)payload[i];"));
    extra_decls.push("  }".to_string());
    extra_decls.push(format!("  {received} = true;"));
    extra_decls.push("}".to_string());

    // The unmodelled mutation ports are surfaced as notes rather than
    // silently dropped.
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

    // loop() tail: each pulse on `set` publishes the value coerced to the
    // variable's type — the payload the live node writes — and emits it.
    let sources = inputs.on("set");
    let binding = bind_pulses(&format!("{prefix}_set"), sources);
    extra_decls.extend(binding.declarations.iter().cloned());
    let mut loop_tail = binding.loop_lines.clone();
    let payload = format!("{prefix}_payload");
    let mqtt_client = transport.mqtt_client();
    for (fired, source) in binding.fired.iter().zip(sources) {
        let Some(fits) = bridge_payload(kind, &source.value, &payload) else {
            extra_decls.push(
                "// note: a colour wired into 'set' carries no channels on the board — nothing is published for it"
                    .to_string(),
            );
            continue;
        };
        loop_tail.push(format!("if ({fired}) {{"));
        loop_tail.push(format!("  String {payload};"));
        loop_tail.push(format!("  if ({fits}) {{"));
        loop_tail.push(format!("    {mqtt_client}.publish({set_topic_var}, {payload}.c_str());"));
        loop_tail.push(format!("    {value_var} = {payload};"));
        loop_tail.push(format!("    {received} = true;"));
        loop_tail.push("  }".to_string());
        loop_tail.push("}".to_string());
    }
    if sources.is_empty() {
        loop_tail.push(format!(
            "// Figma Node {token} has no wired input — subscribe-only, nothing to publish"
        ));
    }

    // `received` is up on the tick an inbound value arrived (the callback runs
    // inside the client's `loop()`) or a set was published: the live node
    // emits `value` and `change` for every one, the same value again included.
    let mut e = transport.emission(extra_decls, loop_tail);
    e.loop_body.insert(0, format!("{received} = false;"));
    if !sources.is_empty() {
        e.shared_declarations = vec![NUMBER_TEXT.to_string(), BRIDGE.to_string()];
    }
    Ok(e)
}

/// True on the tick an inbound variable value arrived.
fn received_var(token: &str) -> String {
    format!("figma_{token}_received")
}

/// What downstream Nodes read from a Figma Node: the latest variable value
/// received or set — `true`/`false` for a BOOLEAN variable, otherwise parsed
/// as a number (`toDouble`), the common case for hardware-driving design
/// variables — on each tick one arrives or is set.
#[must_use]
pub(crate) fn output(node: &FlowNode) -> Option<SourceExpr> {
    let token = node.id_token();
    let config = resolve::<FigmaConfig>(&node.data).ok()?;
    let value = if VariableKind::of(&config.resolved_type) == VariableKind::Boolean {
        CppExpr::boolean(format!("(figma_{token}_value == \"true\")"))
    } else {
        CppExpr::number(format!("figma_{token}_value.toDouble()"))
    };
    Some(SourceExpr::event(value, received_var(&token)))
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

    /// Test-local default: emit with no generate-time credentials.
    fn emit_no_creds(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
        emit(node, inputs, None).unwrap()
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
        let e = emit_no_creds(
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
        let e = emit_no_creds(
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
        let e = emit_no_creds(&n, &NodeInputs::default());
        let decls = joined(&e.declarations);
        assert!(decls.contains("figma_f_1_value"), "buffers the inbound value");
        assert!(decls.contains("setCallback") || joined(&e.setup).contains("setCallback"));
        assert_eq!(
            output(&n).map(|s| s.value.code),
            Some("figma_f_1_value.toDouble()".to_string())
        );
    }

    /// A Figma Node with a wired `set` port publishes the new value back to
    /// Figma on the set topic — over the same network transport.
    #[test]
    fn set_port_publishes_value_back_to_figma() {
        let e = emit_no_creds(
            &figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "wifiSsid": "net" })),
            &set_input("sensor_s_1_value"),
        );
        let body = joined(&e.loop_body);
        let decls = joined(&e.declarations);
        assert!(decls.contains("microflow/u/app/variable/1-2/set"), "set topic mirrors live");
        assert!(body.contains("publish(figma_f_1_set_topic"), "publishes to the set topic");
        assert!(body.contains("sensor_s_1_value"), "publishes the driven value");
    }

    /// Each pulse on `set` publishes — the same value again included — the
    /// value coerced to the variable's type, and emits it, as each live `set`
    /// dispatch does.
    #[test]
    fn each_set_publishes_the_coerced_value_and_emits_it() {
        let e = emit_no_creds(
            &figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "resolvedType": "FLOAT", "wifiSsid": "net" })),
            &set_input("v"),
        );
        let body = joined(&e.loop_body);
        assert!(body.contains("if (mf_bridge_number(1, (double)(v), figma_f_1_payload)) {"), "{body}");
        assert!(body.contains("figma_f_1_received = true;"), "a set is emitted: {body}");
        assert!(!body.contains("last_published"), "no de-duplication on the value: {body}");
        assert_eq!(e.shared_declarations, [NUMBER_TEXT.to_string(), BRIDGE.to_string()]);
    }

    /// A colour carries no channels on the board, so a colour variable set
    /// from one is refused in so many words.
    #[test]
    fn a_colour_set_on_a_colour_variable_is_refused() {
        let mut inputs = NodeInputs::default();
        inputs.add("set", SourceExpr::level(CppExpr::opaque("rgb_version")));
        let e = emit_no_creds(
            &figma("f-1", json!({ "uniqueId": "u", "variableId": "VariableID:1:2", "resolvedType": "COLOR" })),
            &inputs,
        );
        assert!(joined(&e.declarations).contains("// note: a colour wired into 'set'"), "{:?}", e.declarations);
        assert!(!joined(&e.loop_body).contains("publish(figma_f_1_set_topic"), "{:?}", e.loop_body);
    }

    /// Unmodelled mutation ports are noted instead of silently dropped.
    #[test]
    fn unmodelled_mutation_ports_are_noted() {
        let mut inputs = NodeInputs::default();
        inputs.add("toggle", SourceExpr::level(CppExpr::boolean("btn")));
        let e = emit_no_creds(
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
        let e = emit_no_creds(&figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "wifiSsid": "net" })), &NodeInputs::default());
        let body = joined(&e.loop_body);
        assert!(body.contains("ensure_connected()"), "reconnects in loop");
        assert!(body.contains("figma_f_1_client.loop()"), "pumps the MQTT client");
    }

    /// Scenario: Missing credentials produce a safe placeholder + a warning.
    #[test]
    fn missing_credentials_produce_safe_placeholder_and_warning() {
        let e = emit_no_creds(&figma("f-1", json!({ "uniqueId": "u", "variableId": "VariableID:1:2" })), &set_input("v"));
        let decls = joined(&e.declarations);
        assert!(decls.contains("REPLACE_ME"), "emits a credential placeholder");
        assert!(decls.contains("#warning"), "warns the Author at compile time");
        assert!(joined(&e.setup).contains("ensure_connected()"), "still attempts to connect");
    }

    /// Determinism: identical Node yields byte-identical emission.
    #[test]
    fn emits_deterministically() {
        let n = figma("f-1", json!({ "broker": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "wifiSsid": "net" }));
        assert_eq!(emit_no_creds(&n, &set_input("v")), emit_no_creds(&n, &set_input("v")));
    }

    /// Topic strings are escaped so generation stays valid.
    #[test]
    fn topics_are_escaped() {
        let e = emit_no_creds(&figma("f-1", json!({ "broker": "b", "uniqueId": "a\"b", "variableId": "VariableID:1:2", "wifiSsid": "net" })), &NodeInputs::default());
        assert!(joined(&e.declarations).contains("a\\\"b"), "escapes the quote in the topic");
    }

    /// A Penpot variable subscribes to the Penpot plugin's topic segment.
    #[test]
    fn penpot_source_uses_the_penpot_segment() {
        let e = emit_no_creds(
            &figma(
                "f-1",
                json!({ "broker": "b", "uniqueId": "u", "source": "penpot", "variableId": "3f9a-2b1c", "wifiSsid": "net" }),
            ),
            &NodeInputs::default(),
        );
        let decls = joined(&e.declarations);
        assert!(decls.contains("microflow/u/penpot/variable/3f9a-2b1c"), "plugin topic");
        assert!(decls.contains("microflow/u/app/variable/3f9a-2b1c"), "app topic");
    }

    /// The broker comes from the generate-time credentials, not the editor's
    /// opaque `brokerId`.
    #[test]
    fn broker_comes_from_credentials() {
        let credentials = Credentials {
            wifi_ssid: "net".into(),
            broker_host: "broker.example.com".into(),
            ..Credentials::default()
        };
        let node = figma("f-1", json!({ "brokerId": "store-id-123", "uniqueId": "u", "variableId": "VariableID:1:2" }));
        let decls = joined(&emit(&node, &NodeInputs::default(), Some(&credentials)).unwrap().declarations);
        assert!(decls.contains("broker.example.com"), "uses the credentials host");
        assert!(!decls.contains("store-id-123"), "never uses the broker-store id as a host");
        assert!(!decls.contains("REPLACE_ME"), "no placeholder when credentials are complete");
    }

    /// A BOOLEAN variable reads as a boolean downstream.
    #[test]
    fn boolean_variable_outputs_a_boolean() {
        let n = figma("f-1", json!({ "uniqueId": "u", "variableId": "VariableID:1:2", "resolvedType": "BOOLEAN" }));
        assert_eq!(
            output(&n).map(|s| s.value.code),
            Some("(figma_f_1_value == \"true\")".to_string())
        );
    }
}
