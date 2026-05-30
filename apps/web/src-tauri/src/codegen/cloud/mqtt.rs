//! Mqtt emitter — the on-device counterpart of `runtime/external/mqtt.rs`.
//!
//! The live Mqtt component publishes to / subscribes from a broker through a
//! host-driven adapter. On a networked target (ESP32) there is no host, so the
//! generated sketch must do it itself: connect to the broker over the `WiFi`
//! link the shared credentials preamble already brought up, and — depending on the
//! Node's `direction` — publish on `trigger` or subscribe and surface inbound
//! messages. This mirrors the live semantics so standalone behaviour matches
//! live mode.
//!
//! The emission uses the ubiquitous Arduino MQTT stack: `WiFi.h` (ESP32 core)
//! plus `PubSubClient`. The `WiFi` bring-up itself (mode + `WiFi.begin` +
//! connect-wait) is owned centrally by
//! [`crate::codegen::credentials::wifi_preamble`]; this emitter only waits for
//! `WL_CONNECTED` and owns the broker connection.
//!
//! ## Config (`node.data`)
//!
//! Read leniently, accepting both the live runtime shape and the generation
//! request shape:
//! - `broker` — broker host (the request shape); falls back to `brokerId`.
//! - `port` — broker TCP port (default `1883`).
//! - `topic` — topic to publish on / subscribe to.
//! - `direction` — `"publish"` or `"subscribe"` (default `"subscribe"`,
//!   matching `MqttConfig::default`).
//! - credentials: `wifiSsid` (only gates the missing-credentials warning; the
//!   `WiFi` join itself lives in the shared preamble), `brokerUsername`,
//!   `brokerPassword`. When `wifiSsid`/`broker` are absent the sketch emits a
//!   clearly-marked credential placeholder and a `#warning` rather than
//!   silently failing to connect.
//!
//! Like every emitter this is a pure function of the [`FlowNode`]: identical
//! input yields byte-identical output (determinism invariant).

use crate::codegen::emit::{str_or_default, u16_or_default, NodeEmission, NodeToken};
use crate::runtime::types::FlowNode;

/// Default broker port — standard unencrypted MQTT.
const DEFAULT_PORT: u16 = 1883;
/// Default direction matches `runtime/external/mqtt.rs::MqttConfig::default`.
const DEFAULT_DIRECTION: &str = "subscribe";
/// Sentinel emitted in place of a missing credential so the sketch never
/// silently connects with an empty value.
const PLACEHOLDER: &str = "REPLACE_ME";

/// The `WiFi` + MQTT client includes. De-duplicated by the assembler.
fn includes() -> Vec<String> {
    vec![
        "#include <WiFi.h>".to_string(),
        "#include <PubSubClient.h>".to_string(),
    ]
}

/// Escape a string for embedding inside a C++ double-quoted literal. Keeps
/// generation safe (and deterministic) for topics/credentials that contain a
/// quote or backslash.
fn cpp_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// A single config value read from `data`, with the first non-empty key
/// winning, falling back to `default`.
fn first_non_empty(node: &FlowNode, keys: &[&str], default: &str) -> String {
    for key in keys {
        let value = str_or_default(node, key, "");
        if !value.is_empty() {
            return value;
        }
    }
    default.to_string()
}

/// Emit C++ for an Mqtt Cloud Node on a networked target.
///
/// `driver` is the C++ expression a publish Node sends each time its input
/// fires (the payload). A subscribe Node ignores it. The target is assumed to
/// offer networking — validation refuses the Node otherwise.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let token = node.id_token();
    let direction = {
        let d = str_or_default(node, "direction", DEFAULT_DIRECTION);
        if d.is_empty() { DEFAULT_DIRECTION.to_string() } else { d }
    };
    let is_publish = direction == "publish";

    let topic = first_non_empty(node, &["topic"], "");
    let broker = first_non_empty(node, &["broker", "brokerId"], "");
    let port = u16_or_default(node, "port", DEFAULT_PORT);
    let wifi_ssid = first_non_empty(node, &["wifiSsid"], "");
    let broker_user = first_non_empty(node, &["brokerUsername"], "");
    let broker_pass = first_non_empty(node, &["brokerPassword"], "");

    // A Node is missing its essential connection details if it has no WiFi SSID
    // or no broker host. We still emit a connecting sketch, but with a loud
    // placeholder + #warning so the Author is told rather than silently failing.
    // The WiFi credentials themselves live in the shared credentials preamble;
    // the Node-level SSID only gates whether this Node believes it can connect.
    let credentials_missing = wifi_ssid.is_empty() || broker.is_empty();

    let broker_lit = cpp_string(if broker.is_empty() { PLACEHOLDER } else { &broker });
    let topic_lit = cpp_string(&topic);

    // Per-Node config names — token-scoped so multiple Mqtt Nodes coexist.
    let broker_var = format!("mqtt_{token}_broker");
    let port_var = format!("mqtt_{token}_port");
    let topic_var = format!("mqtt_{token}_topic");
    let client_id_var = format!("mqtt_{token}_client_id");
    let wifi_client = format!("mqtt_{token}_wifi_client");
    let mqtt_client = format!("mqtt_{token}_client");

    let mut declarations = vec![
        format!("const char* {broker_var} = {broker_lit};"),
        format!("const uint16_t {port_var} = {port};"),
        format!("const char* {topic_var} = {topic_lit};"),
        format!("const char* {client_id_var} = {};", cpp_string(&format!("microflow-{token}"))),
        format!("WiFiClient {wifi_client};"),
        format!("PubSubClient {mqtt_client}({wifi_client});"),
    ];
    if credentials_missing {
        // A compile-time signal plus a human-readable note. The #warning keeps
        // the placeholder honest: the sketch builds but the Author is told.
        declarations.insert(
            0,
            format!(
                "#warning \"MQTT Node {token}: missing network credentials — using {PLACEHOLDER} placeholder; set WiFi SSID and broker before flashing\""
            ),
        );
    }

    // Connect/auth arguments differ when a broker username is configured.
    let connect_call = if broker_user.is_empty() {
        format!("{mqtt_client}.connect({client_id_var})")
    } else {
        format!(
            "{mqtt_client}.connect({client_id_var}, {}, {})",
            cpp_string(&broker_user),
            cpp_string(if broker_pass.is_empty() { PLACEHOLDER } else { &broker_pass })
        )
    };

    // The (re)connect routine: wait for WiFi (brought up by the shared
    // credentials preamble in setup()), then connect the broker. Mirrors the
    // live component maintaining its connection; here it runs in loop() with no
    // host event loop. It is *non-blocking* — it attempts the broker connect
    // once per call, returning immediately so the sketch's `millis()`-based
    // scheduler keeps ticking (no blocking `delay`). It never calls
    // `WiFi.begin` itself — the preamble already initiated the join.
    // Subscribe Nodes (re)subscribe on every (re)connect.
    let mut ensure_fn = vec![
        format!("void mqtt_{token}_ensure_connected() {{"),
        "  if (WiFi.status() != WL_CONNECTED) {".to_string(),
        "    return; // WiFi not up yet; retry on the next loop tick".to_string(),
        "  }".to_string(),
        format!("  if (!{mqtt_client}.connected()) {{"),
        format!("    {mqtt_client}.setServer({broker_var}, {port_var});"),
        format!("    if ({connect_call}) {{"),
    ];
    if is_publish {
        ensure_fn.push("      // publish-only Node: nothing to subscribe".to_string());
    } else {
        ensure_fn.push(format!("      {mqtt_client}.subscribe({topic_var});"));
    }
    ensure_fn.push("    }".to_string());
    ensure_fn.push("  }".to_string());
    ensure_fn.push("}".to_string());

    // Inbound message handling for subscribe Nodes: copy the latest payload into
    // a Node-scoped buffer so downstream Nodes can read it (mirrors the live
    // component surfacing the message as its value).
    if !is_publish {
        let callback = format!("mqtt_{token}_on_message");
        let value_var = format!("mqtt_{token}_value");
        declarations.push(format!("String {value_var};"));
        declarations.push(format!(
            "void {callback}(char* topic, byte* payload, unsigned int length) {{"
        ));
        declarations.push(format!("  {value_var} = String();"));
        declarations.push("  for (unsigned int i = 0; i < length; i++) {".to_string());
        declarations.push(format!("    {value_var} += (char)payload[i];"));
        declarations.push("  }".to_string());
        declarations.push("}".to_string());
    }
    // The ensure-connected helper is appended after the message callback it may
    // reference (subscribe uses the callback name only in setup, so order is
    // not strictly required, but keep declarations readable).
    for line in ensure_fn {
        declarations.push(line);
    }

    // WiFi bring-up (mode + begin + connect-wait) is owned by the shared
    // credentials preamble; here we only point the client at the broker.
    let mut setup = vec![
        format!("{mqtt_client}.setServer({broker_var}, {port_var});"),
    ];
    if !is_publish {
        setup.push(format!("{mqtt_client}.setCallback(mqtt_{token}_on_message);"));
    }
    setup.push(format!("mqtt_{token}_ensure_connected();"));

    // loop(): keep the connection alive (reconnect on drop), pump the client,
    // and — for publish Nodes — send the driven payload when its input fires.
    let mut loop_body = vec![
        format!("mqtt_{token}_ensure_connected();"),
        format!("{mqtt_client}.loop();"),
    ];
    if is_publish {
        if let Some(expr) = driver {
            loop_body.push(format!("if ({mqtt_client}.connected()) {{"));
            loop_body.push(format!(
                "  {mqtt_client}.publish({topic_var}, String({expr}).c_str());"
            ));
            loop_body.push("}".to_string());
        } else {
            loop_body.push(format!(
                "// publish Node {token} has no wired input — nothing to publish"
            ));
        }
    }

    NodeEmission {
        includes: includes(),
        declarations,
        setup,
        loop_body,
    }
}

/// The C++ expression downstream Nodes read for a subscribe Mqtt Node: the
/// latest inbound message as a numeric value (`toFloat`). Publish Nodes expose
/// no readable value. Mirrors the live component surfacing the message as its
/// value.
#[must_use]
pub fn value_var(node: &FlowNode) -> Option<String> {
    let direction = str_or_default(node, "direction", DEFAULT_DIRECTION);
    if direction == "publish" {
        return None;
    }
    let token = node.id_token();
    Some(format!("mqtt_{token}_value.toFloat()"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::Position;
    use serde_json::json;

    fn mqtt(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Mqtt".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn joined(lines: &[String]) -> String {
        lines.join("\n")
    }

    /// Scenario: Mqtt Node emits working code on a `WiFi`-capable target — it
    /// pulls in the `WiFi` + MQTT client libraries.
    #[test]
    fn mqtt_pulls_in_wifi_and_mqtt_client_libraries() {
        let e = emit(
            &mqtt("m-1", json!({ "broker": "broker.example.com", "topic": "t", "wifiSsid": "net" })),
            None,
        );
        assert!(e.includes.iter().any(|i| i.contains("WiFi.h")), "missing WiFi include");
        assert!(
            e.includes.iter().any(|i| i.contains("PubSubClient.h")),
            "missing MQTT client include"
        );
    }

    /// Scenario: connects to the broker on boot, waiting on the shared `WiFi`
    /// connection brought up by the credentials preamble — it does not duplicate
    /// the `WiFi` bring-up itself.
    #[test]
    fn connects_to_broker_on_boot_over_shared_wifi() {
        let e = emit(
            &mqtt(
                "m-1",
                json!({ "broker": "broker.example.com", "port": 1883, "topic": "t", "wifiSsid": "net", "wifiPassword": "pw" }), // ggignore
            ),
            None,
        );
        let setup = joined(&e.setup);
        let decls = joined(&e.declarations);
        assert!(setup.contains("ensure_connected()"), "connects on boot");
        assert!(setup.contains("setServer(mqtt_m_1_broker"), "points at the broker host/port");
        // Waits for the shared WiFi connection but never brings it up itself.
        assert!(decls.contains("WiFi.status() != WL_CONNECTED"), "waits for shared WiFi");
        assert!(!decls.contains("WiFi.begin"), "does not duplicate WiFi bring-up");
        assert!(!setup.contains("WiFi.mode"), "does not duplicate WiFi mode");
    }

    /// Scenario: a subscribe Node subscribes on its configured topic and
    /// surfaces inbound messages.
    #[test]
    fn subscribe_node_subscribes_and_surfaces_messages() {
        let n = mqtt(
            "m-1",
            json!({ "broker": "b", "topic": "microflow/sensor", "wifiSsid": "net", "direction": "subscribe" }),
        );
        let e = emit(&n, None);
        let decls = joined(&e.declarations);
        assert!(decls.contains("subscribe(mqtt_m_1_topic)"), "subscribes to its topic");
        assert!(decls.contains("setCallback") || joined(&e.setup).contains("setCallback"));
        assert!(decls.contains("mqtt_m_1_value"), "buffers the inbound message");
        assert_eq!(value_var(&n).as_deref(), Some("mqtt_m_1_value.toFloat()"));
    }

    /// Scenario: a publish Node publishes its driven payload on its topic.
    #[test]
    fn publish_node_publishes_driven_payload() {
        let n = mqtt(
            "m-1",
            json!({ "broker": "b", "topic": "microflow/sensor", "wifiSsid": "net", "direction": "publish" }),
        );
        let e = emit(&n, Some("sensor_s_1_value"));
        let body = joined(&e.loop_body);
        assert!(body.contains("publish(mqtt_m_1_topic"), "publishes on its topic");
        assert!(body.contains("sensor_s_1_value"), "publishes the driven payload");
        // Publish Nodes expose no readable value.
        assert_eq!(value_var(&n), None);
    }

    /// Scenario: the loop maintains the connection (reconnect on drop) without
    /// a host event loop.
    #[test]
    fn loop_maintains_connection_and_pumps_client() {
        let e = emit(&mqtt("m-1", json!({ "broker": "b", "topic": "t", "wifiSsid": "net" })), None);
        let body = joined(&e.loop_body);
        assert!(body.contains("ensure_connected()"), "reconnects in loop");
        assert!(body.contains("mqtt_m_1_client.loop()"), "pumps the MQTT client");
    }

    /// Scenario: Generated Mqtt sketch reflects supplied credentials.
    #[test]
    fn reflects_supplied_credentials() {
        let e = emit(
            &mqtt(
                "m-1",
                json!({
                    "broker": "broker.example.com",
                    "port": 8883,
                    "topic": "microflow/sensor",
                    "wifiSsid": "home-net",
                    "wifiPassword": "s3cret", // ggignore
                    "brokerUsername": "user",
                    "brokerPassword": "pass", // ggignore
                    "direction": "publish"
                }),
            ),
            Some("v"),
        );
        let decls = joined(&e.declarations);
        // WiFi SSID/password live in the shared credentials preamble, not here.
        assert!(!decls.contains("\"home-net\""), "WiFi SSID belongs to the preamble");
        assert!(!decls.contains("\"s3cret\""), "WiFi password belongs to the preamble");
        assert!(decls.contains("\"broker.example.com\""), "embeds the broker host");
        assert!(decls.contains("8883"), "embeds the supplied port");
        assert!(decls.contains("connect(mqtt_m_1_client_id, \"user\", \"pass\")"), "uses broker auth");
        assert!(!decls.contains("REPLACE_ME"), "no placeholder when creds supplied");
        assert!(!decls.contains("#warning"), "no warning when creds supplied");
    }

    /// Scenario: Missing credentials produce a safe placeholder + a warning.
    #[test]
    fn missing_credentials_produce_safe_placeholder_and_warning() {
        let e = emit(&mqtt("m-1", json!({ "topic": "microflow/sensor", "direction": "publish" })), Some("v"));
        let decls = joined(&e.declarations);
        assert!(decls.contains("REPLACE_ME"), "emits a credential placeholder");
        assert!(decls.contains("#warning"), "warns the Author at compile time");
        // It still emits connecting code rather than silently doing nothing.
        assert!(joined(&e.setup).contains("ensure_connected()"), "still attempts to connect");
    }

    /// Direction defaults to subscribe when absent (matches runtime default).
    #[test]
    fn direction_defaults_to_subscribe() {
        let n = mqtt("m-1", json!({ "broker": "b", "topic": "t", "wifiSsid": "net" }));
        let e = emit(&n, None);
        assert!(joined(&e.declarations).contains("subscribe(mqtt_m_1_topic)"), "defaults to subscribe");
        assert!(value_var(&n).is_some(), "subscribe Node exposes a value");
    }

    /// Topic strings with a quote are escaped so generation stays valid.
    #[test]
    fn topic_is_escaped() {
        let e = emit(&mqtt("m-1", json!({ "broker": "b", "topic": "a\"b", "wifiSsid": "net" })), None);
        assert!(joined(&e.declarations).contains("\"a\\\"b\""), "escapes the quote in the topic");
    }

    /// Determinism: identical Node yields byte-identical emission.
    #[test]
    fn emits_deterministically() {
        let n = mqtt("m-1", json!({ "broker": "b", "topic": "t", "wifiSsid": "net", "direction": "publish" }));
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }
}
