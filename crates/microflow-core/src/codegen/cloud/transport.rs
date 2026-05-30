//! Shared on-device network transport for Cloud Nodes that bridge over MQTT.
//!
//! `Figma` and `Monitor` both talk to the host/plugin over the **same network
//! transport the Mqtt Node uses**: `WiFi` (ESP32 core) plus an MQTT client
//! (`PubSubClient`). Rather than each emitter re-implementing the `WiFi`/broker
//! bring-up, they share this helper, which builds a token-scoped, non-blocking
//! (re)connect routine mirroring `cloud::mqtt`'s `ensure_connected` shape.
//!
//! The `WiFi` SSID/password themselves come from the shared credentials surface
//! ([`crate::codegen::credentials::wifi_preamble`]), which the assembler injects
//! once per Sketch — this helper therefore only owns the *broker* connection and
//! the per-Node MQTT client, never a second copy of the `WiFi` setup.
//!
//! Like every emitter, the produced fragments are a pure function of their
//! inputs: identical configuration yields byte-identical text (determinism).

use crate::codegen::emit::NodeEmission;

/// Default broker port — standard unencrypted MQTT, matching `cloud::mqtt`.
pub const DEFAULT_PORT: u16 = 1883;
/// Sentinel emitted in place of a missing credential so the Sketch never
/// silently connects with an empty value. Matches `cloud::mqtt::PLACEHOLDER`.
pub const PLACEHOLDER: &str = "REPLACE_ME";

/// Escape a string for embedding inside a C++ double-quoted literal so a stray
/// quote/backslash/newline can never break the generated Sketch.
#[must_use]
pub fn cpp_string(value: &str) -> String {
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

/// The `WiFi` + MQTT client includes shared by every MQTT-bridging Cloud Node.
/// De-duplicated by the assembler against the credentials preamble's `WiFi.h`.
#[must_use]
pub fn includes() -> Vec<String> {
    vec![
        "#include <WiFi.h>".to_string(),
        "#include <PubSubClient.h>".to_string(),
    ]
}

/// A topic this Node subscribes to on every (re)connect, mapped to nothing —
/// subscriptions are emitted into the connect routine.
#[derive(Debug, Clone)]
pub struct Subscription {
    /// The C++ expression naming the topic to subscribe to (a `const char*`).
    pub topic_var: String,
}

/// Configuration for the shared MQTT transport of one Cloud Node.
pub struct Transport<'a> {
    /// Per-Node prefix (e.g. `figma_f_1`) keeping every symbol Node-scoped so
    /// multiple Cloud Nodes coexist in one Sketch.
    pub prefix: &'a str,
    /// Broker host (already resolved; empty → placeholder + warning).
    pub broker: &'a str,
    /// Broker TCP port.
    pub port: u16,
    /// Optional broker username (empty → anonymous connect).
    pub broker_user: &'a str,
    /// Optional broker password (only used when `broker_user` is set).
    pub broker_pass: &'a str,
    /// Topics to (re)subscribe on every connect.
    pub subscriptions: &'a [Subscription],
    /// Optional inbound-message callback name. When set, the connect routine
    /// installs it via `setCallback` and the caller is expected to declare it.
    pub on_message: Option<&'a str>,
    /// Human-readable Node kind for the missing-credentials `#warning`.
    pub kind: &'a str,
    /// True when essential connection details are absent (emits placeholder +
    /// `#warning` so the Author is told rather than silently failing).
    pub credentials_missing: bool,
}

impl Transport<'_> {
    /// The per-Node `WiFiClient` symbol.
    fn wifi_client(&self) -> String {
        format!("{}_wifi_client", self.prefix)
    }

    /// The per-Node `PubSubClient` symbol downstream code publishes through.
    #[must_use]
    pub fn mqtt_client(&self) -> String {
        format!("{}_client", self.prefix)
    }

    /// The per-Node broker host symbol.
    fn broker_var(&self) -> String {
        format!("{}_broker", self.prefix)
    }

    /// The per-Node broker port symbol.
    fn port_var(&self) -> String {
        format!("{}_port", self.prefix)
    }

    /// The per-Node MQTT client-id symbol.
    fn client_id_var(&self) -> String {
        format!("{}_client_id", self.prefix)
    }

    /// The per-Node `ensure_connected` routine name.
    #[must_use]
    pub fn ensure_fn(&self) -> String {
        format!("{}_ensure_connected", self.prefix)
    }

    /// Global declarations: broker config, the MQTT client, the (re)connect
    /// routine, and — when credentials are missing — a `#warning`.
    ///
    /// `extra_decls` are the caller's Node-specific declarations (e.g. topic
    /// strings and value buffers), emitted before the connect routine so it can
    /// reference them.
    #[must_use]
    pub fn declarations(&self, extra_decls: Vec<String>) -> Vec<String> {
        let broker_lit = cpp_string(if self.broker.is_empty() { PLACEHOLDER } else { self.broker });
        let client_id_lit = cpp_string(&format!("microflow-{}", self.prefix));

        let mut decls = Vec::new();
        if self.credentials_missing {
            decls.push(format!(
                "#warning \"{} Node {}: missing network credentials — using {PLACEHOLDER} placeholder; set WiFi SSID and broker before flashing\"",
                self.kind, self.prefix
            ));
        }
        decls.push(format!("const char* {} = {broker_lit};", self.broker_var()));
        decls.push(format!("const uint16_t {} = {};", self.port_var(), self.port));
        decls.push(format!("const char* {} = {client_id_lit};", self.client_id_var()));
        decls.push(format!("WiFiClient {};", self.wifi_client()));
        decls.push(format!("PubSubClient {}({});", self.mqtt_client(), self.wifi_client()));

        decls.extend(extra_decls);

        // Connect/auth arguments differ when a broker username is configured.
        let connect_call = if self.broker_user.is_empty() {
            format!("{}.connect({})", self.mqtt_client(), self.client_id_var())
        } else {
            format!(
                "{}.connect({}, {}, {})",
                self.mqtt_client(),
                self.client_id_var(),
                cpp_string(self.broker_user),
                cpp_string(if self.broker_pass.is_empty() { PLACEHOLDER } else { self.broker_pass })
            )
        };

        // Non-blocking (re)connect: ensure WiFi is up, then the broker. Returns
        // immediately so the `millis()`-based scheduler keeps ticking. The WiFi
        // bring-up itself is owned by the shared credentials preamble; here we
        // only wait for it to be connected before touching the broker.
        decls.push(format!("void {}() {{", self.ensure_fn()));
        decls.push("  if (WiFi.status() != WL_CONNECTED) {".to_string());
        decls.push("    return; // WiFi not up yet; retry on the next loop tick".to_string());
        decls.push("  }".to_string());
        decls.push(format!("  if (!{}.connected()) {{", self.mqtt_client()));
        decls.push(format!("    {}.setServer({}, {});", self.mqtt_client(), self.broker_var(), self.port_var()));
        decls.push(format!("    if ({connect_call}) {{"));
        if self.subscriptions.is_empty() {
            decls.push("      // no inbound topics to subscribe".to_string());
        } else {
            for sub in self.subscriptions {
                decls.push(format!("      {}.subscribe({});", self.mqtt_client(), sub.topic_var));
            }
        }
        decls.push("    }".to_string());
        decls.push("  }".to_string());
        decls.push("}".to_string());

        decls
    }

    /// `setup()` statements: point the client at the broker, install the inbound
    /// callback (if any), and kick off the first connect attempt. `WiFi.mode` /
    /// `WiFi.begin` are owned by the shared credentials preamble.
    #[must_use]
    pub fn setup(&self) -> Vec<String> {
        let mut setup = vec![format!(
            "{}.setServer({}, {});",
            self.mqtt_client(),
            self.broker_var(),
            self.port_var()
        )];
        if let Some(cb) = self.on_message {
            setup.push(format!("{}.setCallback({cb});", self.mqtt_client()));
        }
        setup.push(format!("{}();", self.ensure_fn()));
        setup
    }

    /// `loop()` statements every MQTT-bridging Node shares: maintain the
    /// connection (reconnect on drop) and pump the client. The caller appends
    /// its own publish logic after these.
    #[must_use]
    pub fn loop_prelude(&self) -> Vec<String> {
        vec![
            format!("{}();", self.ensure_fn()),
            format!("{}.loop();", self.mqtt_client()),
        ]
    }

    /// Assemble a full [`NodeEmission`] from the shared fragments plus the
    /// caller's Node-specific declarations and loop body.
    #[must_use]
    pub fn emission(&self, extra_decls: Vec<String>, loop_tail: Vec<String>) -> NodeEmission {
        let mut loop_body = self.loop_prelude();
        loop_body.extend(loop_tail);
        NodeEmission {
            includes: includes(),
            declarations: self.declarations(extra_decls),
            setup: self.setup(),
            loop_body,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base<'a>(prefix: &'a str, subs: &'a [Subscription]) -> Transport<'a> {
        Transport {
            prefix,
            broker: "broker.example.com",
            port: DEFAULT_PORT,
            broker_user: "",
            broker_pass: "",
            subscriptions: subs,
            on_message: None,
            kind: "Test",
            credentials_missing: false,
        }
    }

    #[test]
    fn includes_pull_in_wifi_and_mqtt_client() {
        let inc = includes();
        assert!(inc.iter().any(|i| i.contains("WiFi.h")));
        assert!(inc.iter().any(|i| i.contains("PubSubClient.h")));
    }

    #[test]
    fn connect_routine_waits_for_wifi_then_broker() {
        let t = base("x_1", &[]);
        let decls = t.declarations(vec![]).join("\n");
        assert!(decls.contains("WiFi.status() != WL_CONNECTED"), "waits for WiFi");
        assert!(decls.contains("x_1_client.setServer(x_1_broker, x_1_port)"), "points at broker");
        assert!(decls.contains("x_1_client.connect(x_1_client_id)"), "anonymous connect");
        // The WiFi bring-up is owned by the credentials preamble, not here.
        assert!(!decls.contains("WiFi.begin"), "does not duplicate WiFi setup");
    }

    #[test]
    fn subscriptions_are_emitted_into_the_connect_routine() {
        let subs = [Subscription { topic_var: "x_1_topic".to_string() }];
        let t = base("x_1", &subs);
        assert!(t.declarations(vec![]).join("\n").contains("subscribe(x_1_topic)"));
    }

    #[test]
    fn broker_auth_used_when_username_present() {
        let mut t = base("x_1", &[]);
        t.broker_user = "user";
        t.broker_pass = "pass"; // ggignore
        assert!(t
            .declarations(vec![])
            .join("\n")
            .contains("connect(x_1_client_id, \"user\", \"pass\")"));
    }

    #[test]
    fn missing_credentials_emit_warning_and_placeholder() {
        let mut t = base("x_1", &[]);
        t.broker = "";
        t.credentials_missing = true;
        let decls = t.declarations(vec![]).join("\n");
        assert!(decls.contains("#warning"), "warns the Author");
        assert!(decls.contains("REPLACE_ME"), "emits a placeholder broker");
    }

    #[test]
    fn loop_prelude_reconnects_and_pumps() {
        let t = base("x_1", &[]);
        let body = t.loop_prelude().join("\n");
        assert!(body.contains("x_1_ensure_connected()"), "reconnects in loop");
        assert!(body.contains("x_1_client.loop()"), "pumps the client");
    }

    #[test]
    fn setup_installs_callback_when_present() {
        let mut t = base("x_1", &[]);
        t.on_message = Some("x_1_on_message");
        assert!(t.setup().join("\n").contains("setCallback(x_1_on_message)"));
    }

    #[test]
    fn cpp_string_escapes_quotes_and_backslashes() {
        assert_eq!(cpp_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }
}
