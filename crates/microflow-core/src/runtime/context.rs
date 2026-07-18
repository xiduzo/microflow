//! The per-dispatch capability context and the side-effect record the host
//! applies after each turn.
//!
//! The runtime is sans-IO: a node never touches the serial port, a clock, or a
//! timer. Instead, during one `dispatch`/`on_pin_change`/`wake` it is handed a
//! [`RuntimeContext`] exposing a board writer (encodes bytes into a buffer), the
//! host clock (`now_ms`), and a wakeup scheduler (records requests). When the
//! turn drains, the runtime folds everything into one [`Effects`] the host
//! executes: write the bytes, dispatch the events to the UI, arm/cancel timers.

use crate::runtime::board::{BoardWriter, I2cBus};
use crate::runtime::value::ComponentEvent;
use serde::Serialize;
use std::sync::Arc;

/// Opaque handle to a scheduled wakeup, so the host can cancel a specific timer.
pub type WakeupId = u64;

/// A future self-callback a timer node asked for. The host arms a timer for
/// `delay_ms`; when it fires it calls `FlowRuntime::wake(node_id, method)`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wakeup {
    pub id: WakeupId,
    pub node_id: String,
    pub method: String,
    pub delay_ms: u64,
}

/// An outbound cloud call a node asked the host to perform (ADR-0009): the
/// sans-IO replacement for the old in-component `tokio::spawn`. A cloud node's
/// `dispatch` records one of these via [`RuntimeContext::request_cloud`] instead
/// of touching the network; the host's [`EffectsSink::perform_cloud`] performs
/// it, and any result re-enters through `FlowRuntime::inject_event` on `source`.
/// `source` (the node id) is the correlation key for that re-entry.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRequest {
    /// The node that issued the request; results re-enter via `inject_event`
    /// targeting this id.
    pub source: Arc<str>,
    #[serde(flatten)]
    pub kind: CloudRequestKind,
}

/// What kind of cloud I/O a [`CloudRequest`] is. Carries only plain data (no
/// service handles, no Tokio) so a cloud node stays fully sans-IO and unit-
/// testable by asserting the emitted request. The host maps each variant onto
/// its platform transport (desktop `rumqttc`/`reqwest`; browser WSS/`fetch`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CloudRequestKind {
    /// Fire-and-forget MQTT publish (the MQTT publish node and Figma's set-back).
    /// Nothing re-enters the runtime.
    MqttPublish {
        broker_id: String,
        topic: String,
        payload: Vec<u8>,
        retain: bool,
    },
    /// LLM text generation. The result re-enters on the node's `value` / `done`
    /// / `error` / `thinking` handles via `inject_event`.
    LlmGenerate {
        provider_id: String,
        model: String,
        system: Option<String>,
        prompt: String,
    },
    /// Fire-and-forget raw MIDI message (the `MidiOut` node) to every host MIDI
    /// output whose port name contains `device_name` ("" = all). Nothing
    /// re-enters the runtime.
    MidiSend { device_name: String, bytes: Vec<u8> },
}

/// Severity of a [`NodeDiagnostic`], mapped 1:1 onto the UI's existing per-node
/// `error` (red) / `warning` (amber) badge on `NodeContainer`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticLevel {
    Warning,
    Error,
}

/// A runtime health signal a node raises about *itself* — surfaced on the node
/// in the UI (not routed across edges like a [`ComponentEvent`]). A hardware
/// node uses this to report a fault it can only see at runtime, e.g. an I2C
/// device whose reads never ACK ("too few bytes"). `message: None` clears any
/// prior diagnostic on that node (recovery). Nodes should raise these only on a
/// state *transition* so a per-poll failure doesn't spam the channel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDiagnostic {
    /// The node the diagnostic is about (and displayed on).
    pub node: String,
    pub level: DiagnosticLevel,
    /// The message to show; `None` clears the node's diagnostic.
    pub message: Option<String>,
}

/// Everything the host must do after one runtime turn. Bytes go to the serial
/// port, events to the UI stores, wakeups to host timers, cancellations clear
/// timers that are no longer wanted, cloud requests go to the network, node
/// diagnostics go to the node's badge in the UI.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effects {
    pub outbound_bytes: Vec<u8>,
    pub component_events: Vec<ComponentEvent>,
    pub wakeups: Vec<Wakeup>,
    pub cancellations: Vec<WakeupId>,
    pub cloud_requests: Vec<CloudRequest>,
    pub node_diagnostics: Vec<NodeDiagnostic>,
}

/// The per-field hook surface a **Runtime Host** implements to apply one turn's
/// [`Effects`]. [`Effects::apply`] drives these hooks in the canonical order, so
/// the ordering *policy* lives here (core), once — not re-implemented across the
/// two hosts in two languages, where it already drifted (ADR-0008). The platform
/// *primitives* behind each hook stay genuinely per-host (Tokio `abort_handle`
/// vs `clearTimeout`); only the order is shared.
///
/// Adding a field to [`Effects`] adds a hook here — a compile error in every
/// sink until handled, never a silently-dropped field. (ADR-0009's
/// `perform_cloud` will land as exactly such a hook.)
pub trait EffectsSink {
    /// Write the turn's outbound serial bytes to the wire. Called at most once
    /// per turn, and only when there are bytes ([`Effects::apply`] guards empty).
    fn write_bytes(&mut self, bytes: &[u8]);
    /// Cancel a previously-armed host timer by id — a wakeup no longer wanted.
    fn cancel_wakeup(&mut self, id: WakeupId);
    /// Arm a host timer that calls `FlowRuntime::wake(node_id, method)` after
    /// `wakeup.delay_ms`.
    fn arm_wakeup(&mut self, wakeup: &Wakeup);
    /// Perform an outbound cloud call (ADR-0009); any result re-enters via
    /// `FlowRuntime::inject_event`. Sequenced before `dispatch_event` so a
    /// request issued this turn is launched before the turn's UI events leave.
    fn perform_cloud(&mut self, request: &CloudRequest);
    /// Deliver a component event to the UI (desktop Tauri `emit`, browser store
    /// ingest). These leave the runtime and do not feed back this turn.
    fn dispatch_event(&mut self, event: &ComponentEvent);
    /// Surface a node's runtime health on its UI badge (desktop Tauri `emit`,
    /// browser store write). `message: None` clears the node's diagnostic.
    fn report_diagnostic(&mut self, diagnostic: &NodeDiagnostic);
}

impl Effects {
    /// Apply this turn's effects to `sink` in the **canonical order** (ADR-0008,
    /// extended by ADR-0009): `outbound_bytes → cancellations → wakeups →
    /// cloud_requests → component_events → node_diagnostics`.
    ///
    /// - Bytes first: lowest wire latency for the turn's hardware writes.
    /// - Cancel before arm: a cancel + re-arm of the same logical timer in one
    ///   turn must clear the old timer before the new one is set — the safe
    ///   default (and the browser host's pre-existing order).
    /// - Cloud requests launched before UI events leave, so an outbound call
    ///   issued this turn is in flight before the turn's events exit the runtime.
    /// - UI events last: they exit the runtime and never feed back this turn.
    ///
    /// The desktop host calls this directly; the browser reactor cannot (it is
    /// TypeScript) and mirrors the same order + hook shape, held to it by a
    /// shared conformance test.
    pub fn apply<S: EffectsSink + ?Sized>(&self, sink: &mut S) {
        if !self.outbound_bytes.is_empty() {
            sink.write_bytes(&self.outbound_bytes);
        }
        for &id in &self.cancellations {
            sink.cancel_wakeup(id);
        }
        for wakeup in &self.wakeups {
            sink.arm_wakeup(wakeup);
        }
        for request in &self.cloud_requests {
            sink.perform_cloud(request);
        }
        for event in &self.component_events {
            sink.dispatch_event(event);
        }
        for diagnostic in &self.node_diagnostics {
            sink.report_diagnostic(diagnostic);
        }
    }
}

/// Per-turn collector of scheduling requests made by nodes during dispatch.
/// The `FlowRuntime` resolves these into concrete [`Wakeup`] ids / cancellations
/// against its outstanding-wakeup table once the turn drains.
#[derive(Debug, Default)]
pub struct ScheduleRequests {
    /// `(node_id, method, delay_ms)` — arm a future wake.
    pub schedules: Vec<(String, String, u64)>,
    /// `(node_id, method)` — cancel any pending wake for this node + method.
    pub cancels: Vec<(String, String)>,
    /// `(node_id, kind)` — outbound cloud calls a node asked the host to perform
    /// this turn (ADR-0009). Resolved into [`Effects::cloud_requests`] when the
    /// turn drains.
    pub cloud_requests: Vec<(String, CloudRequestKind)>,
    /// Runtime health signals nodes raised about themselves this turn. Resolved
    /// into [`Effects::node_diagnostics`] when the turn drains.
    pub diagnostics: Vec<NodeDiagnostic>,
}

/// Capabilities handed to a component for the duration of one dispatch call:
/// the sans-IO board writer, the host clock, and the wakeup scheduler. The node
/// id is implicit, so `schedule_wakeup` / `cancel_wakeup` target the caller.
pub struct RuntimeContext<'a> {
    board: &'a mut dyn BoardWriter,
    now_ms: f64,
    node_id: &'a str,
    requests: &'a mut ScheduleRequests,
}

impl<'a> RuntimeContext<'a> {
    pub fn new(
        board: &'a mut dyn BoardWriter,
        now_ms: f64,
        node_id: &'a str,
        requests: &'a mut ScheduleRequests,
    ) -> Self {
        Self { board, now_ms, node_id, requests }
    }

    /// The sans-IO board writer. Calls encode Firmata bytes into the turn's
    /// outbound buffer; nothing crosses the wire until the host applies `Effects`.
    pub fn board(&mut self) -> &mut dyn BoardWriter {
        self.board
    }

    /// The I2C subset of the board writer — a narrower handle than
    /// [`board`](Self::board) for I2C device drivers, exposing only the six bus
    /// operations ([`I2cBus`]). Upcast from the same underlying writer, so encoded
    /// bytes still land in this turn's outbound buffer.
    pub fn i2c(&mut self) -> &mut dyn I2cBus {
        self.board
    }

    /// Host-supplied monotonic clock in milliseconds.
    #[must_use]
    pub fn now_ms(&self) -> f64 {
        self.now_ms
    }

    /// Ask the host to call back `dispatch_internal(method, …)` on this node
    /// after `delay_ms`. Replaces `std::thread::sleep` for timer nodes.
    pub fn schedule_wakeup(&mut self, method: &str, delay_ms: u64) {
        self.requests
            .schedules
            .push((self.node_id.to_string(), method.to_string(), delay_ms));
    }

    /// Cancel a pending wakeup previously scheduled for this node + method
    /// (e.g. a re-triggered delay or a stopped interval).
    pub fn cancel_wakeup(&mut self, method: &str) {
        self.requests
            .cancels
            .push((self.node_id.to_string(), method.to_string()));
    }

    /// Record an outbound cloud call for the host to perform after the turn
    /// drains (ADR-0009). The caller (a cloud node) is the implicit `source`, so
    /// any result re-enters via `FlowRuntime::inject_event` on this node. The
    /// node never touches the network — it stays sans-IO and testable.
    pub fn request_cloud(&mut self, kind: CloudRequestKind) {
        self.requests
            .cloud_requests
            .push((self.node_id.to_string(), kind));
    }

    /// Raise a runtime diagnostic on this node (shown on its UI badge). Use for a
    /// fault the node can only detect at runtime — e.g. an I2C read that never
    /// ACKs. Raise on a state *transition* only, so a per-poll failure doesn't
    /// spam. Clear with [`clear_diagnostic`](Self::clear_diagnostic) on recovery.
    pub fn report_diagnostic(&mut self, level: DiagnosticLevel, message: impl Into<String>) {
        self.requests.diagnostics.push(NodeDiagnostic {
            node: self.node_id.to_string(),
            level,
            message: Some(message.into()),
        });
    }

    /// Clear any diagnostic previously shown on this node (recovery).
    pub fn clear_diagnostic(&mut self) {
        self.requests.diagnostics.push(NodeDiagnostic {
            node: self.node_id.to_string(),
            level: DiagnosticLevel::Error,
            message: None,
        });
    }
}

#[cfg(test)]
mod apply_tests {
    use super::*;
    use crate::runtime::value::ComponentValue;
    use std::sync::Arc;

    /// One recorded hook invocation — enough to assert order + that nothing
    /// double-fires. The Rust side of the ADR-0008 conformance scenario; the
    /// browser mirror lives in `apps/web/src/lib/firmata/__tests__/`.
    #[derive(Debug, PartialEq)]
    enum Call {
        Write(usize),
        Cancel(WakeupId),
        Arm(WakeupId),
        Cloud(String),
        Event(String),
        Diagnostic(String),
    }

    #[derive(Default)]
    struct Recorder {
        calls: Vec<Call>,
    }

    impl EffectsSink for Recorder {
        fn write_bytes(&mut self, bytes: &[u8]) {
            self.calls.push(Call::Write(bytes.len()));
        }
        fn cancel_wakeup(&mut self, id: WakeupId) {
            self.calls.push(Call::Cancel(id));
        }
        fn arm_wakeup(&mut self, wakeup: &Wakeup) {
            self.calls.push(Call::Arm(wakeup.id));
        }
        fn perform_cloud(&mut self, request: &CloudRequest) {
            self.calls.push(Call::Cloud(request.source.to_string()));
        }
        fn dispatch_event(&mut self, event: &ComponentEvent) {
            self.calls.push(Call::Event(event.source_handle.to_string()));
        }
        fn report_diagnostic(&mut self, diagnostic: &NodeDiagnostic) {
            self.calls.push(Call::Diagnostic(diagnostic.node.clone()));
        }
    }

    fn event(handle: &str) -> ComponentEvent {
        ComponentEvent {
            source: Arc::from("n"),
            source_handle: Arc::from(handle),
            value: ComponentValue::Bool(true),
            edge_id: None,
            sequence: 0,
        }
    }

    #[test]
    fn apply_drives_hooks_in_canonical_order() {
        // The ADR-0008/0009 scenario: a turn that cancels one timer, re-arms
        // another, writes bytes, issues a cloud call, and emits — all five fields
        // present. The contract is the order (bytes → cancel → arm → cloud →
        // event) and that each fires exactly once.
        let effects = Effects {
            outbound_bytes: vec![0x90, 0x01, 0x00],
            component_events: vec![event("value")],
            wakeups: vec![Wakeup {
                id: 9,
                node_id: "t".to_string(),
                method: "_tick".to_string(),
                delay_ms: 100,
            }],
            cancellations: vec![7],
            cloud_requests: vec![CloudRequest {
                source: Arc::from("llm"),
                kind: CloudRequestKind::LlmGenerate {
                    provider_id: "p".to_string(),
                    model: "m".to_string(),
                    system: None,
                    prompt: "hi".to_string(),
                },
            }],
            node_diagnostics: vec![NodeDiagnostic {
                node: "i2c".to_string(),
                level: DiagnosticLevel::Error,
                message: Some("no ACK".to_string()),
            }],
        };

        let mut rec = Recorder::default();
        effects.apply(&mut rec);

        assert_eq!(
            rec.calls,
            vec![
                Call::Write(3),
                Call::Cancel(7),
                Call::Arm(9),
                Call::Cloud("llm".to_string()),
                Call::Event("value".to_string()),
                Call::Diagnostic("i2c".to_string()),
            ],
            "effects must apply in the canonical order with no double-fire"
        );
    }

    #[test]
    fn apply_skips_write_when_no_outbound_bytes() {
        // Empty outbound must not call `write_bytes` at all — the host's write
        // path (port flush / `connection.write`) is skipped on idle turns.
        let effects = Effects {
            component_events: vec![event("value")],
            ..Effects::default()
        };

        let mut rec = Recorder::default();
        effects.apply(&mut rec);

        assert_eq!(rec.calls, vec![Call::Event("value".to_string())]);
    }
}
