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
use microflow_core::runtime::{
    figma_announce_actions, midi_device_matches, reconcile_desired, ComponentValue, Effects,
    FlowRuntime as CoreRuntime,
};
use std::collections::BTreeMap;
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

    /// The active subscribe nodes' broker wirings, **reconciled** to one desired
    /// subscription per `(broker_id, topic)` — the deterministic winner-selection
    /// policy lives in core ([`reconcile_desired`]), shared with the desktop host
    /// so both pick the same owner per topic. Returns a JSON array of
    /// `{ brokerId, topic, nodeId, kind }` (`kind` ∈ `plain`/`topicAware`/
    /// `displayEcho`). The browser host diffs this against its live set, (un)subscribes
    /// WSS, and routes inbound payloads back via [`deliver_message`](FlowRuntime::deliver_message)
    /// (the analog of the desktop `flow_update` reply + MQTT manager).
    ///
    /// # Errors
    /// `JsError` only if the reconciled list fails to serialize.
    #[wasm_bindgen(js_name = reconcileSubscriptions)]
    pub fn reconcile_subscriptions(&self) -> Result<String, JsError> {
        let desired = reconcile_desired(&self.inner.collect_subscriber_wirings());
        serde_json::to_string(&desired)
            .map_err(|e| JsError::new(&format!("failed to serialize subscriptions: {e}")))
    }

    /// A hotkey was pressed (`pressed = true`) or released: deliver it to every
    /// node listening on `accelerator`. Mirrors the desktop `ActorMsg::Key`
    /// path; which nodes hear the key is core's decision in both hosts.
    ///
    /// # Errors
    /// `JsError` only if the resulting `Effects` fails to serialize.
    #[wasm_bindgen(js_name = keyEvent)]
    pub fn key_event(
        &mut self,
        accelerator: &str,
        pressed: bool,
        now_ms: f64,
    ) -> Result<String, JsError> {
        self.inner.set_now(now_ms);
        effects_json(&self.inner.dispatch_key_event(accelerator, pressed))
    }

    /// A raw MIDI message (`[status, data1, data2]`) arrived on the Web MIDI
    /// input `port_name`: deliver it to every `Midi` in-node listening to that
    /// port. Mirrors the desktop `ActorMsg::MidiMessage` path.
    ///
    /// # Errors
    /// `JsError` only if the resulting `Effects` fails to serialize.
    #[wasm_bindgen(js_name = midiMessage)]
    pub fn midi_message(
        &mut self,
        port_name: &str,
        bytes: &[u8],
        now_ms: f64,
    ) -> Result<String, JsError> {
        self.inner.set_now(now_ms);
        effects_json(&self.inner.dispatch_midi_message(port_name, bytes))
    }

    /// Whether any node of the flow listens to MIDI input. The browser host
    /// asks for Web MIDI access (a permission prompt) only when one does.
    #[wasm_bindgen(js_name = listensToMidi)]
    #[must_use]
    pub fn listens_to_midi(&self) -> bool {
        self.inner.listens_to_midi()
    }

    /// Whether the host should listen to the MIDI input port `port_name`.
    #[wasm_bindgen(js_name = wantsMidiInput)]
    #[must_use]
    pub fn wants_midi_input(&self, port_name: &str) -> bool {
        self.inner.wants_midi_input(port_name)
    }

    /// Whether a `midiSend` request addressed to `device_name` reaches the MIDI
    /// output port `port_name` — core's device-name rule
    /// ([`midi_device_matches`]). It reads no runtime state; it is a method so
    /// the browser host reaches it through its one crossing into this module.
    #[wasm_bindgen(js_name = midiDeviceMatches)]
    #[must_use]
    #[allow(clippy::unused_self)]
    pub fn midi_device_matches(&self, port_name: &str, device_name: &str) -> bool {
        midi_device_matches(port_name, device_name)
    }

    /// Deliver an inbound broker payload (MQTT / Figma) to subscribe component
    /// `id`, then return the cascade `Effects`. Mirrors the desktop
    /// `ActorMsg::Deliver` path; the browser host calls this from its WSS message
    /// callback for `plain`/`topicAware` wirings. MIDI does not come this way:
    /// see [`midi_message`](FlowRuntime::midi_message).
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

/// Compute the Figma plugin-handshake publishes when the live plugin-uid set
/// changes from `prev` to `next` (each a JSON `{ [uid]: brokerId }` object the
/// host derives from its reconciled subscriptions). Returns a JSON array of
/// `{ brokerId, topic, payload, retain }` the browser host publishes over WSS.
/// The handshake *protocol* lives in core ([`figma_announce_actions`]), shared
/// with the desktop host so both announce identically; the browser owns only the
/// publish I/O — the Figma-side analog of [`FlowRuntime::reconcileSubscriptions`].
///
/// # Errors
/// `JsError` if either argument is not a `{ string: string }` JSON object, or the
/// result fails to serialize.
#[wasm_bindgen(js_name = figmaAnnounceActions)]
pub fn figma_announce_actions_js(prev_json: &str, next_json: &str) -> Result<String, JsError> {
    let prev: BTreeMap<String, String> = serde_json::from_str(prev_json)
        .map_err(|e| JsError::new(&format!("invalid prev uids: {e}")))?;
    let next: BTreeMap<String, String> = serde_json::from_str(next_json)
        .map_err(|e| JsError::new(&format!("invalid next uids: {e}")))?;
    serde_json::to_string(&figma_announce_actions(&prev, &next))
        .map_err(|e| JsError::new(&format!("failed to serialize figma actions: {e}")))
}

/// Serialize a turn's `Effects` for the JS host — or return `""` when the turn
/// produced nothing, so the host can skip its `JSON.parse`.
///
/// Inbound serial chunks are the highest-frequency entry point (a board streams
/// analog reports continuously) and most of them change nothing. Serialising
/// `{"outboundBytes":[],…}` for those turns, only for the host to parse it and
/// find six empty arrays, was pure boundary cost on every read.
fn effects_json(effects: &Effects) -> Result<String, JsError> {
    if effects.is_empty() {
        return Ok(String::new());
    }
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

        // Feeding empty bytes produces nothing, so the host is handed "" and
        // skips its JSON.parse rather than parsing six empty arrays.
        let json = rt.feed_bytes(&[], 1.0).expect("feed ok");
        assert_eq!(json, "", "a no-op turn must not serialize Effects");
    }

    #[test]
    fn dispatch_parses_value_json() {
        let mut rt = FlowRuntime::new();
        let json = rt.dispatch("missing", "value", "true", 0.0).expect("dispatch ok");
        // No such component, so the turn is a no-op: the empty-Effects short
        // circuit returns "" rather than a body of empty arrays.
        assert_eq!(json, "", "a no-op turn must not serialize Effects");
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
    fn reconcile_subscriptions_reports_desired_topics() {
        // An Mqtt subscribe node advertises a `plain` wiring the browser host
        // turns into a WSS subscription — core reconciles it to one desired sub.
        let mut rt = FlowRuntime::new();
        let flow = r#"{
            "nodes": [
                {"id":"m","type":"Mqtt","data":{"instance":"Mqtt","direction":"subscribe","brokerId":"b","topic":"sensors/x"},"position":{"x":0,"y":0}}
            ],
            "edges": []
        }"#;
        rt.update_flow(flow, 0.0).expect("update ok");
        let json = rt.reconcile_subscriptions().expect("subscriptions ok");
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

    #[test]
    fn key_event_reaches_the_hotkey_nodes_through_core() {
        // The binding names an accelerator, never a node: core picks the
        // listeners, exactly as it does for the desktop host.
        let mut rt = FlowRuntime::new();
        let flow = r#"{
            "nodes": [
                {"id":"hk","type":"Hotkey","data":{"instance":"Hotkey","accelerator":"Mod+K"},"position":{"x":0,"y":0}}
            ],
            "edges": []
        }"#;
        rt.update_flow(flow, 0.0).expect("update ok");

        let json = rt.key_event("mod+k", true, 1.0).expect("key ok");
        assert!(json.contains("\"source\":\"hk\""), "got: {json}");
        assert!(json.contains("\"sourceHandle\":\"true\""), "got: {json}");

        let json = rt.key_event("mod+j", true, 2.0).expect("key ok");
        assert_eq!(json, "", "a key nothing listens on is a no-op turn");
    }

    #[test]
    fn midi_bindings_report_wanted_inputs_and_fan_a_message_out() {
        let mut rt = FlowRuntime::new();
        assert!(!rt.listens_to_midi());
        let flow = r#"{
            "nodes": [
                {"id":"m","type":"Midi","data":{"instance":"Midi","direction":"in","deviceName":"launchpad"},"position":{"x":0,"y":0}}
            ],
            "edges": []
        }"#;
        rt.update_flow(flow, 0.0).expect("update ok");

        assert!(rt.listens_to_midi());
        assert!(rt.wants_midi_input("Launchpad Mini"));
        assert!(!rt.wants_midi_input("Keystation 49"));
        assert!(rt.midi_device_matches("Micro Synth", "synth"));
        assert!(!rt.midi_device_matches("Drum Machine", "synth"));

        let json = rt.midi_message("Launchpad Mini", &[0x90, 60, 100], 1.0).expect("midi ok");
        assert!(json.contains("\"source\":\"m\""), "got: {json}");
        assert!(json.contains("\"sourceHandle\":\"note\""), "got: {json}");

        let json = rt.midi_message("Keystation 49", &[0x90, 60, 100], 2.0).expect("midi ok");
        assert_eq!(json, "", "a port nothing listens to is a no-op turn");
    }

    #[test]
    fn figma_announce_actions_js_emits_connect_publishes_for_new_uid() {
        // A uid appearing in `next` (but not `prev`) yields a retained `connected`
        // + a variable-values request — the protocol owned by core, surfaced to
        // the browser host as JSON publishes.
        let json = figma_announce_actions_js("{}", r#"{"u1":"b"}"#).expect("actions ok");
        assert!(json.contains("microflow/u1/app/status"), "got: {json}");
        assert!(json.contains("\"payload\":\"connected\""), "got: {json}");
        assert!(json.contains("microflow/u1/app/variables/request"), "got: {json}");
        assert!(json.contains("\"brokerId\":\"b\""), "got: {json}");
    }
}
