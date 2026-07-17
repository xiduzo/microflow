//! Network credentials for Cloud-capable Sketch generation.
//!
//! A Cloud-capable Sketch (one containing Cloud Nodes — Mqtt/Figma/Llm/Monitor)
//! must connect to the network on boot.
//! That requires runtime credentials the Flow Author supplies: at minimum a
//! `WiFi` SSID/password, and — depending on which Cloud Nodes are present — a
//! broker host/port/auth and an LLM endpoint/API key.
//!
//! This module owns the *Credentials* aggregate for the Sketch Generation
//! context. It carries the typed payload, decides which credentials are
//! *missing* for a given Flow, and emits the on-boot `WiFi` connect preamble that
//! a Cloud-capable Sketch injects into `setup()`.
//!
//! ## Secret handling (invariant)
//!
//! Secret fields (`WiFi` password, broker password, LLM API key) are **never**
//! rendered in clear text outside the generated Sketch and **never** logged.
//! The [`std::fmt::Debug`] impl masks every secret so a `Credentials` value can
//! appear in a `log::debug!`/`{:?}` without leaking. Storage is the caller's
//! concern: these are passed per-generation and are not persisted in the Flow.
//!
//! ## Determinism
//!
//! Like the rest of codegen, every function here is a pure function of its
//! inputs: identical `(flow, credentials)` yields byte-identical text.

use crate::codegen::placeholder::CLOUD_NODE_TYPES;
use crate::flow::FlowUpdate;
use serde::{Deserialize, Serialize};
use std::fmt;
use ts_rs::TS;

/// True when `node_type` names a Cloud (networked) Node.
fn is_cloud_node(node_type: &str) -> bool {
    CLOUD_NODE_TYPES.contains(&node_type)
}

/// True when `flow` contains at least one Cloud Node — the condition under
/// which a Sketch needs `WiFi` credentials.
#[must_use]
pub fn has_cloud_node(flow: &FlowUpdate) -> bool {
    flow.nodes
        .iter()
        .any(|n| n.node_type.as_deref().is_some_and(is_cloud_node))
}

/// True when `flow` contains at least one Node of the given Cloud type.
fn has_node_type(flow: &FlowUpdate, kind: &str) -> bool {
    flow.nodes.iter().any(|n| n.node_type.as_deref() == Some(kind))
}

/// One required-but-missing credential, naming the field the Author left empty
/// and a human-readable reason. Surfaced to the Author so they know *which*
/// credential to supply rather than getting a silently non-connecting Sketch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct MissingCredential {
    /// The credentials field that is required but empty (e.g. `wifiSsid`). Names
    /// the JSON field of [`Credentials`] so the surface can highlight it.
    pub field: String,
    /// Human-readable reason the credential is required for this Flow.
    pub reason: String,
}

/// The network credentials a Cloud-capable Sketch uses to connect on boot.
///
/// Every field is optional at the type level: which credentials are *required*
/// depends on the Flow's Cloud Nodes (see [`Credentials::missing_for`]). A
/// `WiFi`-only Flow needs just SSID/password; an Mqtt Flow additionally needs a
/// broker host; an Llm Flow needs an endpoint + API key.
///
/// Secret fields are masked by the [`fmt::Debug`] impl and must never be logged
/// in clear text.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export, rename_all = "camelCase")]
pub struct Credentials {
    /// `WiFi` network name (SSID) the device joins on boot.
    pub wifi_ssid: String,
    /// `WiFi` password (secret — masked in `Debug`, never logged).
    pub wifi_password: String,
    /// MQTT broker host, e.g. `broker.example.com`.
    pub broker_host: String,
    /// MQTT broker port (defaults to 1883 in the emitted Sketch when 0).
    pub broker_port: u16,
    /// MQTT broker username (optional auth).
    pub broker_username: String,
    /// MQTT broker password (secret — masked in `Debug`, never logged).
    pub broker_password: String,
    /// LLM HTTP endpoint URL.
    pub llm_endpoint: String,
    /// LLM API key (secret — masked in `Debug`, never logged).
    pub llm_api_key: String,
}

impl Credentials {
    /// The required-but-empty credentials for `flow`.
    ///
    /// Returns an empty vec when no credential is needed — i.e. the Flow has no
    /// Cloud Nodes. Otherwise:
    /// - any Cloud Node requires `wifiSsid` and `wifiPassword`;
    /// - an Mqtt Node additionally requires `brokerHost`;
    /// - an Llm Node additionally requires `llmEndpoint` and `llmApiKey`.
    ///
    /// The check is independent of the board target: a Cloud Flow on a
    /// non-networking target still emits its network code (with a validation
    /// warning), so its credential needs are the same.
    ///
    /// Naming the missing field lets the surface warn the Author specifically
    /// rather than producing a silently non-connecting Sketch.
    #[must_use]
    pub fn missing_for(&self, flow: &FlowUpdate) -> Vec<MissingCredential> {
        if !has_cloud_node(flow) {
            return Vec::new();
        }

        let mut missing = Vec::new();
        let mut require = |empty: bool, field: &str, reason: &str| {
            if empty {
                missing.push(MissingCredential {
                    field: field.to_string(),
                    reason: reason.to_string(),
                });
            }
        };

        require(
            self.wifi_ssid.trim().is_empty(),
            "wifiSsid",
            "Cloud Nodes need a WiFi network to join on boot",
        );
        require(
            self.wifi_password.trim().is_empty(),
            "wifiPassword",
            "Cloud Nodes need the WiFi password to join on boot",
        );

        if has_node_type(flow, "Mqtt") {
            require(
                self.broker_host.trim().is_empty(),
                "brokerHost",
                "the Mqtt Node needs a broker host to connect to",
            );
        }

        if has_node_type(flow, "Llm") {
            require(
                self.llm_endpoint.trim().is_empty(),
                "llmEndpoint",
                "the Llm Node needs an endpoint to call",
            );
            require(
                self.llm_api_key.trim().is_empty(),
                "llmApiKey",
                "the Llm Node needs an API key to authenticate",
            );
        }

        missing
    }
}

/// Mask secrets in `Debug` so credentials can be logged without leaking. Only
/// the presence (not the value) of a secret is shown.
impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fn redact(secret: &str) -> &'static str {
            if secret.is_empty() {
                "<empty>"
            } else {
                "<redacted>"
            }
        }
        f.debug_struct("Credentials")
            .field("wifi_ssid", &self.wifi_ssid)
            .field("wifi_password", &redact(&self.wifi_password))
            .field("broker_host", &self.broker_host)
            .field("broker_port", &self.broker_port)
            .field("broker_username", &self.broker_username)
            .field("broker_password", &redact(&self.broker_password))
            .field("llm_endpoint", &self.llm_endpoint)
            .field("llm_api_key", &redact(&self.llm_api_key))
            .finish()
    }
}

/// Escape a credential value for embedding inside a C++ double-quoted string
/// literal so a stray quote or backslash can never break the generated Sketch.
fn cpp_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// The on-boot `WiFi` connect preamble for a Cloud-capable Sketch.
///
/// Returns `None` when the Sketch needs no networking — the Flow has no Cloud
/// Node — so non-networked Sketches are byte-for-byte unchanged (additive,
/// backward-compatible). The preamble follows the *Flow*, not the board: a
/// Cloud Flow on a non-networking target still emits complete network code
/// (validation surfaces the board mismatch as a warning).
///
/// When returned, the preamble carries:
/// - an `#include <WiFi.h>` line,
/// - SSID/password declarations holding the Author's credentials,
/// - `setup()` statements that set `WiFi.mode(WIFI_STA)`, call
///   `WiFi.begin(ssid, pass)` and **wait** for a connection, so the device is
///   online before the rest of `setup()` runs.
///
/// This is the **sole** source of `WiFi` bring-up in a generated Sketch: Cloud
/// emitters (Mqtt/Figma/Monitor/Llm) assume `WiFi` is already connecting and
/// only do their protocol-specific work.
///
/// The password is embedded as a string literal in the Sketch (its destination)
/// but is never logged.
#[must_use]
pub fn wifi_preamble(
    flow: &FlowUpdate,
    credentials: Option<&Credentials>,
) -> Option<WifiPreamble> {
    if !has_cloud_node(flow) {
        return None;
    }
    let creds = credentials.cloned().unwrap_or_default();
    Some(WifiPreamble {
        include: "#include <WiFi.h>".to_string(),
        declarations: vec![
            format!("const char* wifi_ssid = {};", cpp_string(&creds.wifi_ssid)),
            format!("const char* wifi_password = {};", cpp_string(&creds.wifi_password)),
        ],
        setup: vec![
            "// --- WiFi connect (Cloud Nodes) ---".to_string(),
            "WiFi.mode(WIFI_STA);".to_string(),
            "WiFi.begin(wifi_ssid, wifi_password);".to_string(),
            // Cooperative connect-wait: `yield()` services the WiFi/RTOS stack
            // without a blocking `delay()`, keeping the Sketch free of blocking
            // calls (consistent with the non-blocking `loop()` scheduler).
            "while (WiFi.status() != WL_CONNECTED) {".to_string(),
            "  yield();".to_string(),
            "}".to_string(),
        ],
    })
}

/// The C++ fragments of the `WiFi` connect preamble injected into a Cloud-capable
/// Sketch. Mirrors [`crate::codegen::emit::NodeEmission`]'s region split so the
/// assembler can place each part in the right region.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WifiPreamble {
    /// The `#include` line for the `WiFi` client library.
    pub include: String,
    /// Global declarations holding the SSID/password.
    pub declarations: Vec<String>,
    /// `setup()` statements that begin and await the `WiFi` connection.
    pub setup: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::{FlowEdge, FlowNode, Position};
    use serde_json::json;

    fn node(id: &str, kind: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some(kind.to_string()),
            data: json!({}),
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn flow(nodes: Vec<FlowNode>) -> FlowUpdate {
        FlowUpdate { nodes, edges: Vec::<FlowEdge>::new() }
    }

    fn full_creds() -> Credentials {
        Credentials {
            wifi_ssid: "my-network".to_string(),
            wifi_password: "hunter2".to_string(), // ggignore
            broker_host: "broker.example.com".to_string(),
            broker_port: 1883,
            broker_username: "user".to_string(),
            broker_password: "brokerpass".to_string(), // ggignore
            llm_endpoint: "https://api.example.com/v1".to_string(),
            llm_api_key: "sk-secret".to_string(), // ggignore
        }
    }

    /// Scenario: Author provides credentials used by the generated sketch.
    /// Given a Cloud Node on the ESP32 and supplied `WiFi` credentials, the `WiFi`
    /// preamble carries `WiFi.begin(ssid, pass)` and a connect-wait, and the
    /// values are the ones the Author supplied.
    #[test]
    fn preamble_uses_supplied_credentials_to_connect_on_boot() {
        let f = flow(vec![node("mqtt-1", "Mqtt")]);
        let creds = full_creds();
        let preamble =
            wifi_preamble(&f, Some(&creds)).expect("cloud node needs WiFi");

        assert_eq!(preamble.include, "#include <WiFi.h>");
        assert!(
            preamble.declarations.iter().any(|d| d.contains("\"my-network\"")),
            "SSID embedded: {:?}",
            preamble.declarations
        );
        assert!(
            preamble.declarations.iter().any(|d| d.contains("\"hunter2\"")),
            "password embedded in sketch"
        );
        let setup = preamble.setup.join("\n");
        assert!(setup.contains("WiFi.begin(wifi_ssid, wifi_password);"), "begin call");
        assert!(setup.contains("WL_CONNECTED"), "connect-wait present");
    }

    /// The preamble follows the Flow, not the board: a Cloud Flow still gets
    /// its `WiFi` preamble on a non-networking target (validation warns about
    /// the board mismatch separately), so the emitted network code is complete.
    #[test]
    fn preamble_is_emitted_regardless_of_target() {
        let f = flow(vec![node("mqtt-1", "Mqtt")]);
        assert!(wifi_preamble(&f, Some(&full_creds())).is_some());
    }

    /// A networking target with no Cloud Node needs no `WiFi` preamble, keeping
    /// non-networked Sketches byte-for-byte unchanged.
    #[test]
    fn no_preamble_without_cloud_node() {
        let f = flow(vec![node("led-1", "Led")]);
        assert!(wifi_preamble(&f, Some(&full_creds())).is_none());
    }

    /// Scenario: Missing credentials warn the Author.
    /// Given Cloud Nodes with empty required credentials, `missing_for` names
    /// each missing field so the surface can warn specifically.
    #[test]
    fn missing_credentials_are_reported_per_field() {
        let f = flow(vec![node("mqtt-1", "Mqtt"), node("llm-1", "Llm")]);
        let missing = Credentials::default().missing_for(&f);
        let fields: Vec<&str> = missing.iter().map(|m| m.field.as_str()).collect();

        assert!(fields.contains(&"wifiSsid"));
        assert!(fields.contains(&"wifiPassword"));
        assert!(fields.contains(&"brokerHost"), "Mqtt needs a broker host");
        assert!(fields.contains(&"llmEndpoint"), "Llm needs an endpoint");
        assert!(fields.contains(&"llmApiKey"), "Llm needs an API key");
    }

    /// Fully supplied credentials produce no warnings.
    #[test]
    fn complete_credentials_have_no_missing() {
        let f = flow(vec![node("mqtt-1", "Mqtt"), node("llm-1", "Llm")]);
        assert!(full_creds().missing_for(&f).is_empty());
    }

    /// Partial credentials: only the missing fields are named, not the supplied
    /// ones.
    #[test]
    fn partial_credentials_name_only_the_missing_fields() {
        let f = flow(vec![node("mqtt-1", "Mqtt")]);
        let creds = Credentials { wifi_ssid: "net".to_string(), ..Credentials::default() };
        let fields: Vec<String> =
            creds.missing_for(&f).into_iter().map(|m| m.field).collect();
        assert!(!fields.contains(&"wifiSsid".to_string()), "ssid was supplied");
        assert!(fields.contains(&"wifiPassword".to_string()));
        assert!(fields.contains(&"brokerHost".to_string()));
    }

    /// No Cloud Nodes → no required credentials regardless of emptiness.
    #[test]
    fn no_cloud_node_has_no_missing_credentials() {
        let f = flow(vec![node("led-1", "Led")]);
        assert!(Credentials::default().missing_for(&f).is_empty());
    }

    /// Invariant: the `Debug` impl never reveals secret values.
    #[test]
    fn debug_masks_secret_values() {
        let dbg = format!("{:?}", full_creds());
        assert!(!dbg.contains("hunter2"), "wifi password leaked: {dbg}");
        assert!(!dbg.contains("brokerpass"), "broker password leaked: {dbg}");
        assert!(!dbg.contains("sk-secret"), "api key leaked: {dbg}");
        // Non-secret fields remain visible for debugging.
        assert!(dbg.contains("my-network"), "ssid should be visible");
        assert!(dbg.contains("<redacted>"), "secrets shown as redacted");
    }

    /// A credential value containing a double quote can never break the emitted
    /// C++ string literal.
    #[test]
    fn credential_values_are_escaped_for_cpp() {
        let f = flow(vec![node("mqtt-1", "Mqtt")]);
        let creds = Credentials {
            wifi_ssid: "a\"b\\c".to_string(),
            wifi_password: "p".to_string(),
            ..Credentials::default()
        };
        let preamble = wifi_preamble(&f, Some(&creds)).expect("needs WiFi");
        let ssid_decl =
            preamble.declarations.iter().find(|d| d.contains("ssid")).expect("ssid decl");
        assert!(ssid_decl.contains("\\\""), "quote escaped: {ssid_decl}");
        assert!(ssid_decl.contains("\\\\"), "backslash escaped: {ssid_decl}");
    }

    /// Missing credentials must never echo a secret value back to the Author.
    #[test]
    fn missing_reasons_carry_no_secret_values() {
        let f = flow(vec![node("mqtt-1", "Mqtt")]);
        let creds =
            Credentials { wifi_password: "topsecret".to_string(), ..Credentials::default() }; // ggignore
        for m in creds.missing_for(&f) {
            assert!(!m.reason.contains("topsecret"));
        }
    }
}
