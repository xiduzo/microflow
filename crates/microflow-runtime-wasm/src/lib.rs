//! WebAssembly wrapper around [`microflow_core::runtime::FlowRuntime`].
//!
//! Adds **no** runtime logic — a thin `wasm-bindgen` shim so the browser runs
//! the exact same flow engine the desktop runs natively (single source of
//! truth). The browser owns the transport and the clock: it reads Web Serial
//! bytes and hands them in, supplies `now_ms` each call, and applies the
//! returned [`Effects`](microflow_core::runtime::Effects) — writing
//! `outboundBytes` to the port, pushing `componentEvents` to the UI stores, and
//! arming/cancelling `setTimeout`s for `wakeups`/`cancellations`.
//!
//! Every entry point returns the turn's `Effects` as JSON, ready to `JSON.parse`.

use microflow_core::flow::FlowUpdate;
use microflow_core::runtime::{ComponentValue, Effects, FlowRuntime as CoreRuntime};
use wasm_bindgen::prelude::*;

/// Install a panic hook so a Rust panic surfaces as a readable `console.error`.
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(target_arch = "wasm32")]
    console_error_panic_hook::set_once();
}

/// A live flow runtime for one board connection. The browser drives it; the
/// codec, executor, and node logic all live in `microflow-core`.
#[wasm_bindgen]
pub struct FlowRuntime {
    inner: CoreRuntime,
}

#[wasm_bindgen]
impl FlowRuntime {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self { inner: CoreRuntime::new() }
    }

    /// Apply a flow graph (nodes + edges as JSON). Returns the setup `Effects`
    /// (reporting-enable bytes, pin modes, any on-start emissions).
    ///
    /// # Errors
    /// `JsError` if the JSON is not a valid `FlowUpdate`.
    #[wasm_bindgen(js_name = updateFlow)]
    pub fn update_flow(&mut self, json: &str, now_ms: f64) -> Result<String, JsError> {
        let update: FlowUpdate = serde_json::from_str(json)
            .map_err(|e| JsError::new(&format!("invalid flow update: {e}")))?;
        self.inner.set_now(now_ms);
        effects_json(&self.inner.update_flow(update))
    }

    /// Feed raw inbound serial bytes. Returns the cascade `Effects`.
    ///
    /// # Errors
    /// `JsError` only if the resulting `Effects` fails to serialize.
    #[wasm_bindgen(js_name = feedBytes)]
    pub fn feed_bytes(&mut self, bytes: &[u8], now_ms: f64) -> Result<String, JsError> {
        self.inner.set_now(now_ms);
        effects_json(&self.inner.feed_bytes(bytes))
    }

    /// A host timer fired: deliver `method` to `node_id` (e.g. `_tick`).
    ///
    /// # Errors
    /// `JsError` only if the resulting `Effects` fails to serialize.
    pub fn wake(&mut self, node_id: &str, method: &str, now_ms: f64) -> Result<String, JsError> {
        self.inner.set_now(now_ms);
        effects_json(&self.inner.wake(node_id, method))
    }

    /// Inject an external call at a component input (`component_call` analog),
    /// the value given as JSON (e.g. `true`, `42`, `"x"`).
    ///
    /// # Errors
    /// `JsError` if `value_json` is not a valid `ComponentValue`.
    pub fn dispatch(
        &mut self,
        id: &str,
        method: &str,
        value_json: &str,
        now_ms: f64,
    ) -> Result<String, JsError> {
        let value: ComponentValue = serde_json::from_str(value_json)
            .map_err(|e| JsError::new(&format!("invalid value: {e}")))?;
        self.inner.set_now(now_ms);
        effects_json(&self.inner.dispatch(id, method, value))
    }
}

impl Default for FlowRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn effects_json(effects: &Effects) -> Result<String, JsError> {
    serde_json::to_string(effects)
        .map_err(|e| JsError::new(&format!("failed to serialize effects: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Only the Ok paths are exercised on the host — constructing a JsError off
    // the host panics (wasm-bindgen imported fn), so error cases are browser-only.

    #[test]
    fn update_flow_then_feed_returns_effects_json() {
        let mut rt = FlowRuntime::new();
        // A constant -> led flow; update returns valid Effects JSON.
        let flow = r#"{
            "nodes": [
                {"id":"c","type":"Constant","data":{"instance":"Constant","value":1},"position":{"x":0,"y":0}},
                {"id":"led","type":"Led","data":{"instance":"Led","pin":13},"position":{"x":0,"y":0}}
            ],
            "edges": [
                {"id":null,"source":"c","target":"led","sourceHandle":"value","targetHandle":"value"}
            ]
        }"#;
        let json = rt.update_flow(flow, 0.0).expect("update ok");
        assert!(json.contains("\"outboundBytes\""), "got: {json}");
        assert!(json.contains("\"componentEvents\""), "got: {json}");

        // Feeding empty bytes is a no-op cascade with valid JSON.
        let json = rt.feed_bytes(&[], 1.0).expect("feed ok");
        assert!(json.contains("\"wakeups\""), "got: {json}");
    }

    #[test]
    fn dispatch_parses_value_json() {
        let mut rt = FlowRuntime::new();
        let json = rt.dispatch("missing", "value", "true", 0.0).expect("dispatch ok");
        // No such component, but the call returns a well-formed empty Effects.
        assert!(json.contains("\"componentEvents\":[]"), "got: {json}");
    }
}
