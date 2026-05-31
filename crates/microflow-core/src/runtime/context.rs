//! The per-dispatch capability context and the side-effect record the host
//! applies after each turn.
//!
//! The runtime is sans-IO: a node never touches the serial port, a clock, or a
//! timer. Instead, during one `dispatch`/`on_pin_change`/`wake` it is handed a
//! [`RuntimeContext`] exposing a board writer (encodes bytes into a buffer), the
//! host clock (`now_ms`), and a wakeup scheduler (records requests). When the
//! turn drains, the runtime folds everything into one [`Effects`] the host
//! executes: write the bytes, dispatch the events to the UI, arm/cancel timers.

use crate::runtime::board::BoardWriter;
use crate::runtime::value::ComponentEvent;
use serde::Serialize;

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

/// Everything the host must do after one runtime turn. Bytes go to the serial
/// port, events to the UI stores, wakeups to host timers, cancellations clear
/// timers that are no longer wanted.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effects {
    pub outbound_bytes: Vec<u8>,
    pub component_events: Vec<ComponentEvent>,
    pub wakeups: Vec<Wakeup>,
    pub cancellations: Vec<WakeupId>,
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
}
