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
//! The cloud nodes (`Mqtt`/`Llm`/`Figma`) compile in via core's `cloud` feature
//! (ADR-0009): they are sans-IO, so they emit `cloudRequests` the browser host
//! performs (LLM via `fetch`, MQTT/Figma via WSS) and feeds back through
//! [`inject_event`](FlowRuntime::inject_event).
//!
//! Every entry point returns the turn's `Effects` as JSON, ready to `JSON.parse`.

use microflow_core::flow::FlowUpdate;
use microflow_core::runtime::{ComponentValue, Effects, FlowRuntime as CoreRuntime, SubscriberWiring};
use wasm_bindgen::prelude::*;

/// Install a panic hook so a Rust panic surfaces as a readable `console.error`.
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(target_arch = "wasm32")]
    {
        use tracing_subscriber::filter::LevelFilter;
        use tracing_subscriber::fmt::format::DefaultFields;
        use tracing_subscriber::prelude::*;
        use tracing_web::{performance_layer, MakeWebConsoleWriter};

        console_error_panic_hook::set_once();

        // Bridge the crate's existing `log::` records into tracing — the browser
        // has no `log` subscriber otherwise, so build/dispatch warnings would vanish.
        let _ = tracing_log::LogTracer::init();

        // Render core's `tracing` events (the `flow_tick` span + drain traces) to
        // the devtools console. DEBUG in dev surfaces each flow tick; release stays
        // quiet at WARN. The per-event TRACE drain is opt-in — raise the level. No
        // timestamps (wasm has no `Instant`); the performance layer records
        // User-Timing spans instead, viewable in the browser profiler.
        let level = if cfg!(debug_assertions) {
            LevelFilter::DEBUG
        } else {
            LevelFilter::WARN
        };
        let fmt_layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .without_time()
            .with_writer(MakeWebConsoleWriter::new());
        let perf_layer = performance_layer().with_details_from_fields(DefaultFields::new());
        tracing_subscriber::registry()
            .with(level)
            .with(fmt_layer)
            .with(perf_layer)
            .init();
    }
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

    /// Seed the pin table from the connection's `FirmataSession.pinsJson()` so
    /// inbound digital/analog messages decode (the detection session consumed
    /// the capability response before this runtime attached). Call once on attach.
    ///
    /// # Errors
    /// `JsError` if `pins_json` is not the expected `PinInfo[]` shape.
    #[wasm_bindgen(js_name = setPins)]
    pub fn set_pins(&mut self, pins_json: &str) -> Result<(), JsError> {
        self.inner
            .seed_pins(pins_json)
            .map_err(|e| JsError::new(&format!("invalid pins json: {e}")))
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

    /// Re-enter an asynchronous cloud result as if `source` emitted `value` on
    /// `handle` — the browser host's path for an LLM/MQTT result, mirroring the
    /// desktop actor's `ActorMsg::Inject` → `FlowRuntime::inject_event`. Returns
    /// the cascade `Effects` (e.g. an LLM `value` driving downstream nodes).
    ///
    /// # Errors
    /// `JsError` if `value_json` is not a valid `ComponentValue`.
    #[wasm_bindgen(js_name = injectEvent)]
    pub fn inject_event(
        &mut self,
        source: &str,
        handle: &str,
        value_json: &str,
        now_ms: f64,
    ) -> Result<String, JsError> {
        let value: ComponentValue = serde_json::from_str(value_json)
            .map_err(|e| JsError::new(&format!("invalid value: {e}")))?;
        self.inner.set_now(now_ms);
        effects_json(&self.inner.inject_event(source, handle, value))
    }

    /// The active subscribe components' broker wirings, as a JSON array of
    /// `{ nodeId, kind, brokerId, topic }` (`kind` ∈ `plain`/`topicAware`/
    /// `displayEcho`). The browser host reconciles these into WSS subscriptions
    /// and routes inbound payloads back via [`deliver_message`](FlowRuntime::deliver_message)
    /// (the analog of the desktop `flow_update` reply + MQTT manager).
    ///
    /// # Errors
    /// `JsError` only if the wiring list fails to serialize.
    #[wasm_bindgen(js_name = subscriberWirings)]
    pub fn subscriber_wirings(&self) -> Result<String, JsError> {
        let arr: Vec<serde_json::Value> = self
            .inner
            .collect_subscriber_wirings()
            .iter()
            .map(|(node_id, wiring)| {
                let kind = match wiring {
                    SubscriberWiring::Plain { .. } => "plain",
                    SubscriberWiring::TopicAware { .. } => "topicAware",
                    SubscriberWiring::DisplayEcho { .. } => "displayEcho",
                };
                serde_json::json!({
                    "nodeId": node_id,
                    "kind": kind,
                    "brokerId": wiring.broker_id(),
                    "topic": wiring.topic(),
                })
            })
            .collect();
        serde_json::to_string(&arr)
            .map_err(|e| JsError::new(&format!("failed to serialize wirings: {e}")))
    }

    /// Deliver an inbound broker payload (MQTT / Figma) to subscribe component
    /// `id`, then return the cascade `Effects`. Mirrors the desktop
    /// `ActorMsg::Deliver` path; the browser host calls this from its WSS message
    /// callback for `plain`/`topicAware` wirings.
    ///
    /// # Errors
    /// `JsError` only if the resulting `Effects` fails to serialize.
    #[wasm_bindgen(js_name = deliverMessage)]
    pub fn deliver_message(
        &mut self,
        id: &str,
        topic: &str,
        payload: &[u8],
        now_ms: f64,
    ) -> Result<String, JsError> {
        self.inner.set_now(now_ms);
        effects_json(&self.inner.deliver_message(id, topic, payload))
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

    #[test]
    fn inject_event_surfaces_value_as_component_event() {
        // The cloud-result re-entry path: inject pushes the event into the drain,
        // so it surfaces in `componentEvents` even with no node of that id.
        let mut rt = FlowRuntime::new();
        let json = rt.inject_event("n", "value", "\"hi\"", 0.0).expect("inject ok");
        assert!(json.contains("\"componentEvents\""), "got: {json}");
        assert!(json.contains("hi"), "injected value should surface: {json}");
    }

    #[test]
    fn cloud_node_builds_and_dispatch_records_cloud_request() {
        // `cloud` feature is on: an Llm node builds in the browser runtime and a
        // trigger records a `cloudRequests` entry for the host to perform.
        let mut rt = FlowRuntime::new();
        let flow = r#"{
            "nodes": [
                {"id":"l","type":"Llm","data":{"instance":"Llm","providerId":"p","model":"m","prompt":"hi"},"position":{"x":0,"y":0}}
            ],
            "edges": []
        }"#;
        rt.update_flow(flow, 0.0).expect("update ok");
        let json = rt.dispatch("l", "trigger", "true", 1.0).expect("dispatch ok");
        assert!(json.contains("llmGenerate"), "expected a cloud request: {json}");
    }

    #[test]
    fn subscriber_wirings_reports_subscribe_topics() {
        // An Mqtt subscribe node advertises a `plain` wiring the browser host
        // turns into a WSS subscription.
        let mut rt = FlowRuntime::new();
        let flow = r#"{
            "nodes": [
                {"id":"m","type":"Mqtt","data":{"instance":"Mqtt","direction":"subscribe","brokerId":"b","topic":"sensors/x"},"position":{"x":0,"y":0}}
            ],
            "edges": []
        }"#;
        rt.update_flow(flow, 0.0).expect("update ok");
        let json = rt.subscriber_wirings().expect("wirings ok");
        assert!(json.contains("\"kind\":\"plain\""), "got: {json}");
        assert!(json.contains("sensors/x"), "got: {json}");
        assert!(json.contains("\"nodeId\":\"m\""), "got: {json}");
    }

    #[test]
    fn deliver_message_routes_payload_to_subscribe_node() {
        // Inbound broker payload → the subscribe node emits the parsed value.
        let mut rt = FlowRuntime::new();
        let flow = r#"{
            "nodes": [
                {"id":"m","type":"Mqtt","data":{"instance":"Mqtt","direction":"subscribe","brokerId":"b","topic":"t"},"position":{"x":0,"y":0}}
            ],
            "edges": []
        }"#;
        rt.update_flow(flow, 0.0).expect("update ok");
        let json = rt.deliver_message("m", "t", b"42", 1.0).expect("deliver ok");
        assert!(json.contains("\"componentEvents\""), "got: {json}");
        assert!(json.contains("42"), "delivered value should surface: {json}");
    }
}
