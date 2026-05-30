//! WebAssembly wrapper around [`microflow_core::codegen`].
//!
//! This crate adds **no** generation logic — it is a thin `wasm-bindgen` shim so
//! the browser can run the exact same Arduino code generator the desktop app
//! runs natively (single source of truth, no drift). The boundary is JSON in /
//! JSON out, mirroring the desktop Tauri IPC boundary (which serializes the same
//! types anyway): the browser passes the Flow and credentials as JSON strings
//! and receives the serialized [`GenerationOutcome`] / `Vec<MissingCredential>`
//! back, ready to `JSON.parse` into the existing ts-rs bindings.
//!
//! Target resolution mirrors the desktop `generate_sketch` command exactly: an
//! absent or unknown `target_id` falls back to the default board (`uno`) so
//! existing Flows still generate.
//!
//! Secret handling is unchanged from the desktop path: credentials are passed
//! per-generation, never persisted, and the password is embedded only in the
//! emitted Sketch (its intended destination).

// The `#[wasm_bindgen]` entry points must take `Option<String>` by value — the
// JS↔wasm ABI does not support borrowed `Option<&str>` arguments — even though
// we only borrow them internally. Allow the pedantic lint that flags this.
#![allow(clippy::needless_pass_by_value)]

use microflow_core::codegen::{
    board::{supported_targets, target_by_id, BoardTarget},
    credentials::Credentials,
    generate_with_credentials,
};
use microflow_core::flow::FlowUpdate;
use wasm_bindgen::prelude::*;

/// Initialise the wasm module. Installs a panic hook so a Rust panic surfaces as
/// a readable `console.error` instead of an opaque wasm trap. Safe to call more
/// than once; the web glue calls it on load.
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(target_arch = "wasm32")]
    console_error_panic_hook::set_once();
}

/// The default board target (`uno`), used when a Flow has no explicit selection
/// or names an unknown target. Falls back to the first supported target if the
/// `uno` id ever changes, so generation always has a target to work with.
///
/// Mirrors `runtime::commands::default_board_target` on the desktop side.
fn default_board_target() -> BoardTarget {
    target_by_id("uno").unwrap_or_else(|| {
        supported_targets()
            .into_iter()
            .next()
            .expect("at least one supported board target")
    })
}

/// Resolve `target_id` to a [`BoardTarget`], defaulting to the Uno when none is
/// given or the id is unknown — identical resolution to the desktop command.
fn resolve_target(target_id: Option<&str>) -> BoardTarget {
    target_id
        .and_then(target_by_id)
        .unwrap_or_else(default_board_target)
}

/// Generate the Arduino sketch for a Flow, targeting a selected board — the
/// browser equivalent of the desktop `generate_sketch` Tauri command.
///
/// Arguments are JSON strings so the boundary stays language-agnostic:
/// - `flow_json` — a serialized [`FlowUpdate`] (`{ nodes, edges }`).
/// - `target_id` — the selected board id, or `None`/`null` to default to `uno`.
/// - `credentials_json` — a serialized [`Credentials`], or `None`/`null` when the
///   Flow needs no network credentials.
///
/// Returns the serialized [`microflow_core::codegen::GenerationOutcome`] as a
/// JSON string (the `sketch` variant with the `.ino` source, or the `problems`
/// variant listing why the Flow cannot run on the target). Validation runs first,
/// so unrunnable code is never emitted — same contract as the desktop path.
///
/// # Errors
///
/// Returns a `JsError` (rejected promise / thrown value on the JS side) only when
/// an input JSON string fails to deserialize, or when the underlying generator
/// returns an error. A Flow that cannot run on the target is **not** an error —
/// it comes back as the `problems` variant inside the returned JSON.
#[wasm_bindgen]
pub fn generate_sketch(
    flow_json: &str,
    target_id: Option<String>,
    credentials_json: Option<String>,
) -> Result<String, JsError> {
    let flow: FlowUpdate = serde_json::from_str(flow_json)
        .map_err(|e| JsError::new(&format!("invalid flow JSON: {e}")))?;

    let credentials: Option<Credentials> = match credentials_json {
        Some(json) => Some(
            serde_json::from_str(&json)
                .map_err(|e| JsError::new(&format!("invalid credentials JSON: {e}")))?,
        ),
        None => None,
    };

    let target = resolve_target(target_id.as_deref());

    let outcome = generate_with_credentials(&flow, &target, credentials.as_ref())
        .map_err(|e| JsError::new(&e))?;

    serde_json::to_string(&outcome)
        .map_err(|e| JsError::new(&format!("failed to serialize outcome: {e}")))
}

/// Report which required network credentials are missing for a Flow on the
/// selected target — the browser equivalent of the desktop `check_credentials`
/// command — so the editor can warn the Author *before* generating.
///
/// Returns the serialized `Vec<MissingCredential>` as a JSON string (empty array
/// when nothing is required: no Cloud Nodes, or a non-networking target).
///
/// # Errors
///
/// Returns a `JsError` when an input JSON string fails to deserialize. Secret
/// values are never logged.
#[wasm_bindgen]
pub fn check_credentials(
    flow_json: &str,
    target_id: Option<String>,
    credentials_json: Option<String>,
) -> Result<String, JsError> {
    let flow: FlowUpdate = serde_json::from_str(flow_json)
        .map_err(|e| JsError::new(&format!("invalid flow JSON: {e}")))?;

    let credentials: Credentials = match credentials_json {
        Some(json) => serde_json::from_str(&json)
            .map_err(|e| JsError::new(&format!("invalid credentials JSON: {e}")))?,
        None => Credentials::default(),
    };

    let target = resolve_target(target_id.as_deref());
    let missing = credentials.missing_for(&flow, &target);

    serde_json::to_string(&missing)
        .map_err(|e| JsError::new(&format!("failed to serialize missing credentials: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMPTY_FLOW: &str = r#"{"nodes":[],"edges":[]}"#;

    fn ok(result: Result<String, JsError>) -> String {
        result.unwrap_or_else(|_| panic!("expected Ok, got a JsError"))
    }

    #[test]
    fn generates_a_sketch_for_an_empty_flow() {
        // An empty Flow is runnable on the default target, so the JSON boundary
        // round-trips to the `sketch` variant (the skeleton always compiles).
        let json = ok(generate_sketch(EMPTY_FLOW, None, None));
        assert!(json.contains("\"sketch\""), "expected a sketch, got: {json}");
    }

    #[test]
    fn unknown_target_falls_back_to_the_default() {
        // Mirrors the desktop command: an unknown id resolves to the Uno rather
        // than erroring, so existing Flows still generate.
        let json = ok(generate_sketch(EMPTY_FLOW, Some("no-such-board".into()), None));
        assert!(json.contains("\"sketch\""), "expected a sketch, got: {json}");
    }

    // The error path (invalid JSON → JsError) is only exercisable on a wasm
    // target: constructing a `JsError` panics on the host ("cannot call
    // wasm-bindgen imported functions on non-wasm targets"). The mapping itself
    // is a trivial `map_err`, so the happy paths above are the meaningful host
    // coverage.

    #[test]
    fn check_credentials_is_empty_for_a_non_cloud_flow() {
        let json = ok(check_credentials(EMPTY_FLOW, None, None));
        assert_eq!(json, "[]");
    }
}
