//! Monitor emitter — the on-device counterpart of `nodes/monitor/runtime.rs`.
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
//!
//! ## What the Monitor emits
//!
//! Live, a Monitor emits on `value` what it shows: the last value that reached
//! it, whatever its type, each time that changes; before anything arrives it
//! holds the number 0, so the first `false` or text it is sent is a change.
//! On-device it keeps a copy of what it shows, in the type of the source it
//! shows (`shown`: the first
//! source wired into `value` that has an on-device value, resolved by codegen
//! against the whole Flow so a Monitor fed by a Monitor knows its type). The
//! copy is taken when that source fires, and the Monitor emits on the ticks
//! the copy changes — or, for a source that carries no number, on the first
//! copy. With no such source the Monitor shows 0 for good. It publishes what
//! it shows once it has shown something, each time that reads differently.

use crate::codegen::cloud::transport::{Transport, DEFAULT_PORT};
use crate::codegen::emit::{cpp_string_literal, str_first_non_empty, u16_or_default, NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, extra_sources_note, CppExpr, CppType, NodeInputs, SourceExpr};
use crate::flow::FlowNode;

/// The copy of what the Monitor shows.
fn shown_var(node: &FlowNode) -> String {
    format!("monitor_{}_shown", node.id_token())
}

/// True on the ticks what the Monitor shows changes: the ticks it emits.
fn moved_var(node: &FlowNode) -> String {
    format!("monitor_{}_moved", node.id_token())
}

/// What the Monitor emits on `value`, given the source it shows: its copy of
/// that source, in the source's type, each time that changes — or the number
/// 0 it holds for good when it shows nothing.
#[must_use]
pub(crate) fn output(node: &FlowNode, shown: Option<&SourceExpr>) -> SourceExpr {
    shown.map_or_else(
        || SourceExpr::level(CppExpr::number("0.0")),
        |source| SourceExpr::event(CppExpr { code: shown_var(node), ty: source.value.ty }, moved_var(node)),
    )
}

/// Emit C++ for a Monitor Cloud Node on a networked target.
///
/// `shown` is the source the Monitor displays (see the module docs): the
/// Sketch keeps a copy of it and publishes the copy on the monitor topic each
/// time it reads differently. A Monitor that shows nothing has nothing to
/// display, so it only maintains its connection.
#[must_use]
pub(crate) fn emit(node: &FlowNode, inputs: &NodeInputs, shown: Option<&SourceExpr>) -> NodeEmission {
    let sources = inputs.on("value");
    // A Monitor whose shown source could not be resolved (one on a ring of
    // Monitors) still displays the first source wired into it.
    let shown = shown.or_else(|| sources.first());
    let token = node.id_token();
    let prefix = format!("monitor_{token}");

    let broker = str_first_non_empty(node, &["broker", "brokerId"], "");
    let port = u16_or_default(node, "port", DEFAULT_PORT);
    let unique_id = str_first_non_empty(node, &["uniqueId"], "");
    let wifi_ssid = str_first_non_empty(node, &["wifiSsid"], "");
    let broker_user = str_first_non_empty(node, &["brokerUsername"], "");
    let broker_pass = str_first_non_empty(node, &["brokerPassword"], "");

    let topic = format!("microflow/{unique_id}/monitor/{token}");
    let credentials_missing = wifi_ssid.is_empty() || broker.is_empty();

    let topic_var = format!("{prefix}_topic");

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

    let mut extra_decls = vec![format!("const char* {topic_var} = {};", cpp_string_literal(&topic))];
    if let Some(note) = extra_sources_note("value", sources) {
        extra_decls.push(note);
    }
    let mut loop_tail = Vec::new();
    // Keep the copy of what the Monitor shows, taken when its source fires,
    // and publish it each time it reads differently (mirrors the live sink
    // surfacing the latest value; de-dupe on change since there is no host
    // loop).
    if let Some(source) = shown {
        let (copy, moved, seen, last, next) = (
            shown_var(node),
            moved_var(node),
            format!("{prefix}_seen"),
            format!("{prefix}_last_published"),
            format!("{prefix}_next"),
        );
        let ty = source.value.storage_type();
        extra_decls.push(format!("{ty} {copy} = {};", source.value.storage_zero()));
        extra_decls.push(format!("bool {moved} = false;"));
        extra_decls.push(format!("bool {seen} = false;"));
        extra_decls.push(format!("String {last};"));
        let binding = bind_pulses(&format!("{prefix}_shown"), std::slice::from_ref(source));
        extra_decls.extend(binding.declarations);
        loop_tail.extend(binding.loop_lines);
        // The live Monitor starts at the number 0: a number (or the version
        // of a colour or list, whose 0 is that number 0) moves it when it
        // differs; a `bool` or a text is a new value the first time.
        let differs = if matches!(source.value.ty, CppType::Double | CppType::Opaque) {
            format!("{next} != {copy}")
        } else {
            format!("!{seen} || {next} != {copy}")
        };
        loop_tail.push(format!("{moved} = false;"));
        loop_tail.push(format!("if ({}) {{", binding.fired[0]));
        loop_tail.push(format!("  {ty} {next} = {};", source.value.stored()));
        loop_tail.push(format!("  {moved} = {differs};"));
        loop_tail.push(format!("  {copy} = {next}; {seen} = true;"));
        loop_tail.push("}".to_string());
        let copy_text = CppExpr { code: copy, ty: source.value.ty }.as_string();
        let mqtt_client = transport.mqtt_client();
        loop_tail.push(format!("if ({seen} && {mqtt_client}.connected()) {{"));
        loop_tail.push(format!("  String {prefix}_text = {copy_text};"));
        loop_tail.push(format!("  if ({prefix}_text != {last}) {{"));
        loop_tail.push(format!("    {mqtt_client}.publish({topic_var}, {prefix}_text.c_str());"));
        loop_tail.push(format!("    {last} = {prefix}_text;"));
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

    /// Test-local default: a Monitor showing the first source wired into its
    /// `value` port (shadows the glob-imported `emit`).
    fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
        super::emit(node, inputs, inputs.first("value"))
    }

    /// The Monitor keeps a copy of what it shows, in the shown source's type,
    /// taken when that source fires; it emits that copy each time it changes,
    /// and a first `bool` is a change from the number 0 it started at.
    #[test]
    fn a_monitor_hands_on_a_copy_of_what_it_shows() {
        let n = monitor("mon-1", json!({ "broker": "b", "uniqueId": "u", "wifiSsid": "net" }));
        let shown = SourceExpr::level(CppExpr::boolean("relay_r_open"));
        let e = super::emit(&n, &NodeInputs::default(), Some(&shown));
        assert!(e.declarations.iter().any(|d| d == "bool monitor_mon_1_shown = false;"), "{:?}", e.declarations);
        let body = joined(&e.loop_body);
        assert!(
            body.contains(
                "if (monitor_mon_1_shown_fired0) {\n  bool monitor_mon_1_next = (relay_r_open);\n  \
                 monitor_mon_1_moved = !monitor_mon_1_seen || monitor_mon_1_next != monitor_mon_1_shown;"
            ),
            "{body}"
        );
        let out = output(&n, Some(&shown));
        assert_eq!((out.value.code.as_str(), out.value.ty), ("monitor_mon_1_shown", CppType::Bool));
        assert_eq!(out.fired.as_deref(), Some("monitor_mon_1_moved"));
        // Showing nothing, it holds the number 0.
        assert_eq!(output(&n, None).value, CppExpr::number("0.0"));
    }

    /// A number moves the Monitor only when it differs from what it shows:
    /// a first 0 is no change from the 0 it started at.
    #[test]
    fn a_number_moves_a_monitor_when_it_differs() {
        let n = monitor("mon-1", json!({ "broker": "b", "uniqueId": "u", "wifiSsid": "net" }));
        let shown = SourceExpr::level(CppExpr::number("sensor_s_value"));
        let body = joined(&super::emit(&n, &NodeInputs::default(), Some(&shown)).loop_body);
        assert!(body.contains("monitor_mon_1_moved = monitor_mon_1_next != monitor_mon_1_shown;"), "{body}");
    }

    /// A single numeric source wired into the `value` port.
    fn value_input(expr: &str) -> NodeInputs {
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
