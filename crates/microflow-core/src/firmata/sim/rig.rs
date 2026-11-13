//! A test host around a [`SimBoard`]: the Runtime Host role, played in-process.
//!
//! [`SimRig`] owns a [`FlowRuntime`] and a [`SimBoard`] and plays the part the
//! desktop and browser hosts play for real hardware: it runs the detection
//! handshake on its own codec and seeds the runtime's pin table from it
//! (ADR-0018 D3), applies every turn's [`Effects`] through
//! [`Effects::apply`] (ADR-0008) — bytes to the board, wakeups onto a virtual
//! clock, events and diagnostics into logs — and feeds whatever the board sends
//! back into [`FlowRuntime::feed_bytes`]. A Node test then reads:
//!
//! ```ignore
//! let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
//! rig.apply_flow(vec![node("led", "Led", json!({ "pin": 9 }))], vec![]);
//! rig.dispatch("led", "value", 128.0);
//! assert_eq!(rig.board.pin(9).pwm(), Some(128));
//! ```

use super::SimBoard;
use crate::firmata::FirmataClient;
use crate::flow::{FlowEdge, FlowNode, FlowUpdate, Position};
use crate::runtime::{
    CloudRequest, ComponentEvent, ComponentValue, Effects, EffectsSink, FlowRuntime,
    NodeDiagnostic, Wakeup, WakeupId,
};

/// A wakeup the runtime armed, waiting on the rig's virtual clock.
#[derive(Debug, Clone)]
struct Timer {
    id: WakeupId,
    due_ms: u64,
    node_id: String,
    method: String,
}

/// The rig's [`EffectsSink`]: one turn's view of the board, the clock and the
/// logs.
struct Host<'a> {
    board: &'a mut SimBoard,
    now_ms: u64,
    timers: &'a mut Vec<Timer>,
    events: &'a mut Vec<ComponentEvent>,
    diagnostics: &'a mut Vec<NodeDiagnostic>,
    cloud: &'a mut Vec<CloudRequest>,
}

impl EffectsSink for Host<'_> {
    fn write_bytes(&mut self, bytes: &[u8]) {
        self.board.receive(bytes);
    }

    fn cancel_wakeup(&mut self, id: WakeupId) {
        self.timers.retain(|t| t.id != id);
    }

    fn arm_wakeup(&mut self, wakeup: &Wakeup) {
        self.timers.push(Timer {
            id: wakeup.id,
            due_ms: self.now_ms + wakeup.delay_ms,
            node_id: wakeup.node_id.clone(),
            method: wakeup.method.clone(),
        });
    }

    fn perform_cloud(&mut self, request: &CloudRequest) {
        self.cloud.push(request.clone());
    }

    fn dispatch_event(&mut self, event: &ComponentEvent) {
        self.events.push(event.clone());
    }

    fn report_diagnostic(&mut self, diagnostic: &NodeDiagnostic) {
        self.diagnostics.push(diagnostic.clone());
    }
}

/// A [`FlowRuntime`] attached to a [`SimBoard`] through an in-process host.
pub struct SimRig {
    pub board: SimBoard,
    pub runtime: FlowRuntime,
    now_ms: u64,
    timers: Vec<Timer>,
    events: Vec<ComponentEvent>,
    diagnostics: Vec<NodeDiagnostic>,
    cloud: Vec<CloudRequest>,
}

/// How many board ⇄ runtime round trips one stimulus may cause before the rig
/// gives up (a feedback loop between a reply and a write would spin forever).
const MAX_ROUND_TRIPS: usize = 32;

impl SimRig {
    /// Bring `board` up the way a Runtime Host does: drain its boot
    /// announcement, ask for the firmware, then the capabilities and analog
    /// mapping, all on a detection codec; then build a runtime and seed its pin
    /// table from that codec. Panics if the board never names its firmware.
    #[must_use]
    pub fn connect(mut board: SimBoard) -> Self {
        let mut probe = FirmataClient::new();
        probe.feed(&board.take_output());
        board.receive(&probe.encode_query_firmware());
        probe.feed(&board.take_output());
        assert!(!probe.firmware_name.is_empty(), "board never answered REPORT_FIRMWARE");
        board.receive(&probe.encode_query_capabilities());
        board.receive(&probe.encode_query_analog_mapping());
        probe.feed(&board.take_output());

        let mut runtime = FlowRuntime::new();
        runtime
            .seed_pins(&Self::pin_seed_json(&probe))
            .expect("pin seed is well-formed JSON");
        Self {
            board,
            runtime,
            now_ms: 0,
            timers: Vec::new(),
            events: Vec::new(),
            diagnostics: Vec::new(),
            cloud: Vec::new(),
        }
    }

    /// The `PinInfo[]` pin seed both hosts build from their detection codec
    /// (`microflow-firmata-wasm` `pinsJson`, desktop `hardware/firmata.rs`):
    /// the codec's [`PinProfile`](crate::firmata::PinProfile), projected.
    #[must_use]
    pub fn pin_seed_json(probe: &FirmataClient) -> String {
        serde_json::to_string(&probe.profile.pin_infos()).expect("pin infos serialize")
    }

    // --- Stimuli -------------------------------------------------------------

    /// Apply a flow (`update_flow`), then let the board answer.
    pub fn apply_flow(&mut self, nodes: Vec<FlowNode>, edges: Vec<FlowEdge>) {
        self.runtime.set_now(self.now_ms as f64);
        let effects = self.runtime.update_flow(FlowUpdate { nodes, edges });
        self.apply(&effects);
        self.deliver();
    }

    /// Call `port` on `node_id` from outside (an edge from a node the test does
    /// not model), then let the board answer.
    pub fn dispatch(&mut self, node_id: &str, port: &str, value: impl Into<ComponentValue>) {
        self.runtime.set_now(self.now_ms as f64);
        let effects = self.runtime.dispatch(node_id, port, value.into());
        self.apply(&effects);
        self.deliver();
    }

    /// One firmware main-loop pass (digital change reports, stepper moves),
    /// delivered to the runtime.
    pub fn pump(&mut self) {
        self.board.run_loop();
        self.deliver();
    }

    /// One sampling interval on the board (analog reports, continuous I2C
    /// reads) plus a main-loop pass, delivered to the runtime.
    pub fn sample(&mut self) {
        self.board.sample();
        self.pump();
    }

    /// Advance the virtual clock by `ms`, firing every wakeup that falls due in
    /// order (each its own turn, followed by a main-loop pass).
    pub fn advance(&mut self, ms: u64) {
        let until = self.now_ms + ms;
        loop {
            let next = self
                .timers
                .iter()
                .enumerate()
                .filter(|(_, t)| t.due_ms <= until)
                .min_by_key(|(_, t)| (t.due_ms, t.id))
                .map(|(i, _)| i);
            let Some(index) = next else { break };
            let timer = self.timers.remove(index);
            self.now_ms = timer.due_ms;
            self.runtime.set_now(self.now_ms as f64);
            let effects = self.runtime.wake(&timer.node_id, &timer.method);
            self.apply(&effects);
            self.pump();
        }
        self.now_ms = until;
        self.runtime.set_now(self.now_ms as f64);
    }

    /// Feed everything the board has sent to the runtime, applying each turn,
    /// until the board goes quiet.
    pub fn deliver(&mut self) {
        for _ in 0..MAX_ROUND_TRIPS {
            let bytes = self.board.take_output();
            if bytes.is_empty() {
                return;
            }
            self.runtime.set_now(self.now_ms as f64);
            let effects = self.runtime.feed_bytes(&bytes);
            self.apply(&effects);
        }
        panic!("board and runtime never went quiet after {MAX_ROUND_TRIPS} round trips");
    }

    fn apply(&mut self, effects: &Effects) {
        let mut host = Host {
            board: &mut self.board,
            now_ms: self.now_ms,
            timers: &mut self.timers,
            events: &mut self.events,
            diagnostics: &mut self.diagnostics,
            cloud: &mut self.cloud,
        };
        effects.apply(&mut host);
    }

    // --- Observations -----------------------------------------------------------

    #[must_use]
    pub fn now_ms(&self) -> u64 {
        self.now_ms
    }

    /// Every UI event since the last [`take_events`](Self::take_events).
    #[must_use]
    pub fn events(&self) -> &[ComponentEvent] {
        &self.events
    }

    /// Drain the UI event log.
    pub fn take_events(&mut self) -> Vec<ComponentEvent> {
        std::mem::take(&mut self.events)
    }

    /// The handles `node_id` emitted on since the last drain, in order.
    #[must_use]
    pub fn handles_from(&self, node_id: &str) -> Vec<&str> {
        self.events
            .iter()
            .filter(|e| e.source.as_ref() == node_id)
            .map(|e| e.source_handle.as_ref())
            .collect()
    }

    /// The last value `node_id` emitted on `value` since the last drain.
    #[must_use]
    pub fn last_value(&self, node_id: &str) -> Option<&ComponentValue> {
        self.events
            .iter()
            .rev()
            .find(|e| e.source.as_ref() == node_id && e.source_handle.as_ref() == "value")
            .map(|e| &e.value)
    }

    /// Node diagnostics reported so far.
    #[must_use]
    pub fn diagnostics(&self) -> &[NodeDiagnostic] {
        &self.diagnostics
    }

    /// Wakeups armed and not yet fired: `(node, method, due_ms)`.
    #[must_use]
    pub fn pending_wakeups(&self) -> Vec<(&str, &str, u64)> {
        self.timers.iter().map(|t| (t.node_id.as_str(), t.method.as_str(), t.due_ms)).collect()
    }
}

/// A flow node of catalog type `instance` with `data` (the `instance` key is
/// filled in, as the editor stores it).
#[must_use]
pub fn node(id: &str, instance: &str, mut data: serde_json::Value) -> FlowNode {
    if let Some(object) = data.as_object_mut() {
        object.entry("instance").or_insert_with(|| serde_json::Value::from(instance));
    }
    FlowNode {
        id: id.to_string(),
        node_type: Some(instance.to_string()),
        data,
        position: Position { x: 0.0, y: 0.0 },
    }
}

/// An edge from `source.source_handle` to `target.target_handle`.
#[must_use]
pub fn edge(source: &str, source_handle: &str, target: &str, target_handle: &str) -> FlowEdge {
    FlowEdge {
        id: None,
        source: source.to_string(),
        source_handle: source_handle.to_string(),
        target: target.to_string(),
        target_handle: target_handle.to_string(),
    }
}
