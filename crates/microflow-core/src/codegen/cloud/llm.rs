//! Llm emitter — the on-device counterpart of `runtime/external/llm.rs`.
//!
//! The live Llm component renders a prompt and POSTs an OpenAI-compatible
//! `/v1/chat/completions` request to a provider, then surfaces
//! `choices[0].message.content` downstream (see `runtime/services/llm.rs`).
//! On a networked target (ESP32) there is no host to run that request, so the
//! generated sketch must do it itself: ride the shared `WiFi` connection brought
//! up by [`crate::codegen::credentials::wifi_preamble`], open an
//! `HTTPClient` over a TLS-capable `WiFiClientSecure`, send the rendered
//! prompt as the user message, and parse the assistant text out of the
//! response. This mirrors the live semantics so standalone behaviour matches
//! live mode.
//!
//! Unlike the Mqtt emitter — which predates the shared preamble and brings up
//! its own `WiFi` — this emitter does **not** duplicate `WiFi` setup. Cloud
//! Sketches already connect on boot via the preamble; the Llm Node only owns
//! the HTTP request.
//!
//! ## Config (`node.data`)
//!
//! Read leniently, accepting the generation request shape (and mirroring the
//! runtime `LlmConfig` field names):
//! - `endpoint` — provider base URL; the `/v1/chat/completions` suffix is
//!   appended (matching `OpenAiCompatibleProvider`). Falls back to `baseUrl`.
//! - `model` — model id sent in the request body.
//! - `prompt` — user-role prompt content.
//! - `system` — optional system-role prompt prepended to the messages.
//! - credentials: `wifiSsid` (the Cloud Node connection prerequisite) and
//!   `llmApiKey` (the `Authorization: Bearer` token). When the endpoint, `WiFi`
//!   SSID, or API key is absent the sketch emits a clearly-marked credential
//!   placeholder and a `#warning` rather than silently failing to connect or
//!   authenticate.
//!
//! Like every emitter this is a pure function of the [`FlowNode`]: identical
//! input yields byte-identical output (determinism invariant).

use crate::codegen::emit::{str_or_default, NodeEmission, NodeToken};
use crate::flow::FlowNode;

/// Sentinel emitted in place of a missing credential so the sketch never
/// silently connects or authenticates with an empty value.
const PLACEHOLDER: &str = "REPLACE_ME";

/// The HTTP + TLS + JSON includes for an on-device LLM request. De-duplicated
/// by the assembler. `WiFi.h` is contributed by the shared preamble too;
/// duplicates are harmless (the include block is a de-duped set).
fn includes() -> Vec<String> {
    vec![
        "#include <WiFi.h>".to_string(),
        "#include <WiFiClientSecure.h>".to_string(),
        "#include <HTTPClient.h>".to_string(),
        "#include <ArduinoJson.h>".to_string(),
    ]
}

/// Escape a string for embedding inside a C++ double-quoted literal. Keeps
/// generation safe (and deterministic) for prompts/credentials that contain a
/// quote, backslash, or newline.
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

/// Emit C++ for an Llm Cloud Node on a networked target.
///
/// `driver` is the C++ expression that fires the request: when it transitions
/// truthy (its `trigger` input), the sketch renders + sends the prompt once.
/// With no wired input the request fires once after boot. The target is
/// assumed to offer networking — validation refuses the Node otherwise.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let token = node.id_token();

    let endpoint = first_non_empty(node, &["endpoint", "baseUrl"], "");
    let model = first_non_empty(node, &["model"], "");
    let prompt = first_non_empty(node, &["prompt"], "");
    let system = first_non_empty(node, &["system"], "");
    let wifi_ssid = first_non_empty(node, &["wifiSsid"], "");
    let api_key = first_non_empty(node, &["llmApiKey", "apiKey"], "");

    // A Node is missing its essentials if it has no endpoint to call, no WiFi
    // SSID (the connection prerequisite), or no API key to authenticate with.
    // We still emit a requesting sketch, but with a loud placeholder + #warning
    // so the Author is told rather than silently failing.
    let credentials_missing = endpoint.is_empty() || wifi_ssid.is_empty() || api_key.is_empty();

    let endpoint_lit = cpp_string(if endpoint.is_empty() { PLACEHOLDER } else { &endpoint });
    let api_key_lit = cpp_string(if api_key.is_empty() { PLACEHOLDER } else { &api_key });
    let model_lit = cpp_string(&model);
    let prompt_lit = cpp_string(&prompt);
    let system_lit = cpp_string(&system);

    // Per-Node config names — token-scoped so multiple Llm Nodes coexist.
    let endpoint_var = format!("llm_{token}_endpoint");
    let api_key_var = format!("llm_{token}_api_key");
    let model_var = format!("llm_{token}_model");
    let prompt_var = format!("llm_{token}_prompt");
    let system_var = format!("llm_{token}_system");
    let value_var = format!("llm_{token}_value");
    let sent_var = format!("llm_{token}_sent");
    let request_fn = format!("llm_{token}_request");

    let mut declarations = vec![
        format!("const char* {endpoint_var} = {endpoint_lit};"),
        format!("const char* {api_key_var} = {api_key_lit};"),
        format!("const char* {model_var} = {model_lit};"),
        format!("const char* {prompt_var} = {prompt_lit};"),
        format!("const char* {system_var} = {system_lit};"),
        // The latest assistant text (mirrors the live component surfacing
        // `response.text` as its value). Empty until the first response.
        format!("String {value_var};"),
    ];
    if credentials_missing {
        // A compile-time signal plus a human-readable note. The #warning keeps
        // the placeholder honest: the sketch builds but the Author is told.
        declarations.insert(
            0,
            format!(
                "#warning \"Llm Node {token}: missing endpoint/WiFi/API credentials — using {PLACEHOLDER} placeholder; set them before flashing\""
            ),
        );
    }

    // The request routine: only runs once WiFi is up (the shared preamble
    // connects on boot, but loop() keeps ticking regardless). Builds the
    // OpenAI-compatible body via ArduinoJson, POSTs over TLS, and parses
    // `choices[0].message.content` into the value buffer. Mirrors
    // `OpenAiCompatibleProvider::generate`. Non-blocking: a single attempt per
    // call, returning immediately so the millis()-based scheduler keeps ticking.
    let declared_fn = vec![
        format!("void {request_fn}() {{"),
        "  if (WiFi.status() != WL_CONNECTED) {".to_string(),
        "    return; // WiFi not up yet; retry on the next loop tick".to_string(),
        "  }".to_string(),
        "  WiFiClientSecure client;".to_string(),
        // The on-device CA bundle is out of scope here; skip verification so the
        // request reaches HTTPS endpoints. Documented as a constraint.
        "  client.setInsecure();".to_string(),
        "  HTTPClient http;".to_string(),
        format!("  String url = String({endpoint_var}) + \"/v1/chat/completions\";"),
        "  if (!http.begin(client, url)) {".to_string(),
        "    return; // could not start the request; retry next tick".to_string(),
        "  }".to_string(),
        "  http.addHeader(\"Content-Type\", \"application/json\");".to_string(),
        format!("  http.addHeader(\"Authorization\", String(\"Bearer \") + {api_key_var});"),
        // Build the request body: model + messages[{system?},{user}].
        "  JsonDocument requestDoc;".to_string(),
        format!("  requestDoc[\"model\"] = {model_var};"),
        "  JsonArray messages = requestDoc[\"messages\"].to<JsonArray>();".to_string(),
        format!("  if (strlen({system_var}) > 0) {{"),
        "    JsonObject sys = messages.add<JsonObject>();".to_string(),
        "    sys[\"role\"] = \"system\";".to_string(),
        format!("    sys[\"content\"] = {system_var};"),
        "  }".to_string(),
        "  JsonObject user = messages.add<JsonObject>();".to_string(),
        "  user[\"role\"] = \"user\";".to_string(),
        format!("  user[\"content\"] = {prompt_var};"),
        "  String requestBody;".to_string(),
        "  serializeJson(requestDoc, requestBody);".to_string(),
        "  int status = http.POST(requestBody);".to_string(),
        "  if (status == HTTP_CODE_OK) {".to_string(),
        "    JsonDocument responseDoc;".to_string(),
        "    if (deserializeJson(responseDoc, http.getStream()) == DeserializationError::Ok) {".to_string(),
        // Surface choices[0].message.content downstream (mirrors the live parse).
        format!(
            "      {value_var} = responseDoc[\"choices\"][0][\"message\"][\"content\"].as<String>();"
        ),
        "    }".to_string(),
        "  }".to_string(),
        "  http.end();".to_string(),
        "}".to_string(),
    ];
    for line in declared_fn {
        declarations.push(line);
    }

    // loop(): fire the request when the wired input fires (rising edge). With no
    // wired input, fire once after boot. The `sent` latch makes the request
    // edge-triggered rather than spamming every tick.
    declarations.push(format!("bool {sent_var} = false;"));

    let setup = vec![format!("// Llm Node {token}: request issued from loop() once connected")];

    let mut loop_body = Vec::new();
    if let Some(expr) = driver {
        // Edge-triggered: fire on the rising edge of the wired trigger.
        loop_body.push(format!("if (({expr}) && !{sent_var}) {{"));
        loop_body.push(format!("  {sent_var} = true;"));
        loop_body.push(format!("  {request_fn}();"));
        loop_body.push("}".to_string());
        loop_body.push(format!("if (!({expr})) {{"));
        loop_body.push(format!("  {sent_var} = false; // re-arm for the next trigger"));
        loop_body.push("}".to_string());
    } else {
        // No wired input: fire once after boot.
        loop_body.push(format!("if (!{sent_var}) {{"));
        loop_body.push(format!("  {sent_var} = true;"));
        loop_body.push(format!("  {request_fn}();"));
        loop_body.push("}".to_string());
    }

    NodeEmission {
        includes: includes(),
        declarations,
        setup,
        loop_body,
    }
}

/// The C++ expression downstream Nodes read for an Llm Node: the latest
/// assistant text as a C-string. Mirrors the live component surfacing
/// `response.text` as its value.
#[must_use]
pub fn value_var(node: &FlowNode) -> Option<String> {
    let token = node.id_token();
    Some(format!("llm_{token}_value.c_str()"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn llm(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Llm".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn joined(lines: &[String]) -> String {
        lines.join("\n")
    }

    fn full(id: &str) -> FlowNode {
        llm(
            id,
            json!({
                "endpoint": "https://api.example.com",
                "model": "test-model",
                "prompt": "Hello",
                "wifiSsid": "net",
                "llmApiKey": "dummy-key" // ggignore
            }),
        )
    }

    /// Scenario: Llm Node emits working code on a WiFi-capable target — it pulls
    /// in the HTTP/TLS/JSON client libraries.
    #[test]
    fn llm_pulls_in_http_tls_and_json_libraries() {
        let e = emit(&full("l-1"), None);
        assert!(e.includes.iter().any(|i| i.contains("HTTPClient.h")), "missing HTTPClient include");
        assert!(
            e.includes.iter().any(|i| i.contains("WiFiClientSecure.h")),
            "missing TLS client include"
        );
        assert!(e.includes.iter().any(|i| i.contains("ArduinoJson.h")), "missing JSON include");
    }

    /// Scenario: the request is issued over the network to the LLM endpoint and
    /// the response is surfaced downstream.
    #[test]
    fn issues_request_to_endpoint_and_surfaces_response() {
        let n = full("l-1");
        let e = emit(&n, None);
        let decls = joined(&e.declarations);
        assert!(decls.contains("/v1/chat/completions"), "targets the chat-completions path");
        assert!(decls.contains("http.POST(requestBody)"), "POSTs the request body");
        assert!(
            decls.contains("choices\"][0][\"message\"][\"content\"]"),
            "parses the assistant content"
        );
        assert!(decls.contains("llm_l_1_value ="), "buffers the response value");
        assert_eq!(value_var(&n).as_deref(), Some("llm_l_1_value.c_str()"));
    }

    /// Scenario: does not duplicate `WiFi` setup — relies on the shared preamble.
    #[test]
    fn does_not_duplicate_wifi_setup() {
        let e = emit(&full("l-1"), None);
        let all = format!("{}\n{}\n{}", joined(&e.declarations), joined(&e.setup), joined(&e.loop_body));
        assert!(!all.contains("WiFi.begin"), "must not bring up WiFi itself");
        // It still guards on the connection the preamble establishes.
        assert!(all.contains("WiFi.status() != WL_CONNECTED"), "guards on the shared connection");
    }

    /// Scenario: a wired trigger fires the request edge-triggered.
    #[test]
    fn wired_trigger_fires_request_on_rising_edge() {
        let e = emit(&full("l-1"), Some("button_b_1_state"));
        let body = joined(&e.loop_body);
        assert!(body.contains("button_b_1_state"), "uses the wired trigger expression");
        assert!(body.contains("llm_l_1_request()"), "issues the request");
        assert!(body.contains("llm_l_1_sent"), "latches so it is edge-triggered");
    }

    /// With no wired input the request fires once after boot.
    #[test]
    fn fires_once_when_no_wired_input() {
        let e = emit(&full("l-1"), None);
        let body = joined(&e.loop_body);
        assert!(body.contains("if (!llm_l_1_sent)"), "fires once via the sent latch");
        assert!(body.contains("llm_l_1_request()"), "issues the request");
    }

    /// Scenario: Generated Llm sketch reflects supplied credentials.
    #[test]
    fn reflects_supplied_credentials() {
        let e = emit(
            &llm(
                "l-1",
                json!({
                    "endpoint": "https://api.example.com",
                    "model": "gpt-test",
                    "prompt": "Translate this",
                    "system": "You are helpful",
                    "wifiSsid": "home-net",
                    "llmApiKey": "secret-token" // ggignore
                }),
            ),
            None,
        );
        let decls = joined(&e.declarations);
        assert!(decls.contains("\"https://api.example.com\""), "embeds the supplied endpoint");
        assert!(decls.contains("\"gpt-test\""), "embeds the supplied model");
        assert!(decls.contains("\"Translate this\""), "embeds the supplied prompt");
        assert!(decls.contains("\"You are helpful\""), "embeds the supplied system prompt");
        assert!(decls.contains("\"secret-token\""), "embeds the supplied API key");
        assert!(decls.contains("Bearer"), "authenticates with a Bearer token");
        assert!(!decls.contains("REPLACE_ME"), "no placeholder when creds supplied");
        assert!(!decls.contains("#warning"), "no warning when creds supplied");
    }

    /// Scenario: Missing credentials produce a safe placeholder + a warning.
    #[test]
    fn missing_credentials_produce_safe_placeholder_and_warning() {
        let e = emit(&llm("l-1", json!({ "model": "m", "prompt": "p" })), None);
        let decls = joined(&e.declarations);
        assert!(decls.contains("REPLACE_ME"), "emits a credential placeholder");
        assert!(decls.contains("#warning"), "warns the Author at compile time");
        // It still emits requesting code rather than silently doing nothing.
        assert!(decls.contains("http.POST(requestBody)"), "still attempts the request");
    }

    /// A missing API key alone (endpoint + `WiFi` present) still warns.
    #[test]
    fn missing_api_key_alone_warns() {
        let e = emit(
            &llm(
                "l-1",
                json!({ "endpoint": "https://api.example.com", "model": "m", "prompt": "p", "wifiSsid": "net" }),
            ),
            None,
        );
        let decls = joined(&e.declarations);
        assert!(decls.contains("#warning"), "warns when the API key is absent");
        assert!(decls.contains("REPLACE_ME"), "placeholder for the absent key");
    }

    /// Prompt strings with a quote are escaped so generation stays valid.
    #[test]
    fn prompt_is_escaped() {
        let e = emit(
            &llm(
                "l-1",
                json!({ "endpoint": "https://e", "prompt": "a\"b", "wifiSsid": "net", "llmApiKey": "k" }), // ggignore
            ),
            None,
        );
        assert!(joined(&e.declarations).contains("\"a\\\"b\""), "escapes the quote in the prompt");
    }

    /// Determinism: identical Node yields byte-identical emission.
    #[test]
    fn emits_deterministically() {
        let n = full("l-1");
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }
}
