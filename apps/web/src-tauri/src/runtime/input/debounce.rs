//! Shared deferred-settle debounce worker for digital-edge inputs (Button,
//! Switch) in the desktop runtime.
//!
//! Digital pins report only ON CHANGE. A naive lockout that *drops* an edge
//! arriving too soon after the last one desyncs internal state from the pin
//! forever: the dropped edge is never re-reported, so a quick release leaves
//! the input stuck "on" (its "false"/release trigger never fires). Instead, a
//! level seen while the line is still bouncing is *deferred* and accepted once
//! the line has held quiet for [`DEBOUNCE_MS`] — never dropped.
//!
//! The `microflow-core` runtime does this with a host clock + wakeup scheduler.
//! This (pre-re-host) desktop runtime has neither, so the state machine lives
//! in one background thread driven by `recv_timeout`: the same timeout serves
//! both the settle window and the optional hold timer. The thread owns all
//! debounce state, so the owning component's runtime-thread path only forwards
//! raw edges; settled events are pushed straight onto the event channel exactly
//! like `Interval`/`Delay`.

use crate::runtime::base::{ComponentEvent, ComponentValue};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

/// Quiet window a line must hold before a deferred level is accepted. Must
/// exceed one 50Hz mains period (20ms): a floating pin picks up hum as
/// dead-regular ~20ms edges, and a window at exactly that period razor-edges
/// between accepting and rejecting every edge (observed as random on/off
/// "interference" toggles). A clean edge after a quiet line is accepted
/// immediately, so real press latency stays imperceptible.
const DEBOUNCE_MS: u64 = 50;

/// Handle to a running debounce worker. Created by a digital-edge input
/// component once its event sender is wired; raw pin levels go in via
/// [`Debouncer::feed`], settled trigger events come out on the event channel.
pub struct Debouncer {
    /// Raw-edge feed to the worker. `Mutex` only to keep the owning component
    /// `Sync` (the `Component` bound); it is contended by nobody — only
    /// `&mut self` component paths touch it.
    edge_tx: Option<Mutex<Sender<bool>>>,
    worker: Option<JoinHandle<()>>,
}

impl Debouncer {
    /// Spawn a worker that debounces raw `bool` levels and emits settled edges
    /// on `sender` as `value`/`event`/`true`/`false`. `hold`, when `Some`, arms
    /// a one-shot `hold` pulse that long after a `true` edge if it is still
    /// held; `None` disables hold (e.g. a latching Switch).
    pub fn spawn(
        sender: UnboundedSender<ComponentEvent>,
        source: Arc<str>,
        hold: Option<Duration>,
    ) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let worker = std::thread::spawn(move || run(&rx, &sender, &source, hold));
        Self { edge_tx: Some(Mutex::new(tx)), worker: Some(worker) }
    }

    /// Forward one raw pin level to the worker.
    pub fn feed(&self, level: bool) {
        if let Some(tx) = &self.edge_tx {
            if let Ok(tx) = tx.lock() {
                let _ = tx.send(level);
            }
        }
    }

    /// Stop the worker and join it. Idempotent.
    pub fn stop(&mut self) {
        // Drop the sender so the worker observes `Disconnected` and exits.
        self.edge_tx = None;
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Debouncer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Push one settled event straight onto the runtime's event channel. Always
/// fires — `true`/`false`/`hold`/`event` are momentary triggers, not state.
fn emit(sender: &UnboundedSender<ComponentEvent>, source: &Arc<str>, handle: &'static str, level: bool) {
    let _ = sender.send(ComponentEvent {
        source: Arc::clone(source),
        source_handle: Arc::from(handle),
        value: ComponentValue::Bool(level),
        edge_id: None,
        sequence: 0,
    });
}

/// Commit an accepted state change: `value` (node display) + the edge trigger,
/// and (re)arm or clear the hold timer.
fn apply(
    level: bool,
    now: Instant,
    state: &mut bool,
    hold_deadline: &mut Option<Instant>,
    hold: Option<Duration>,
    sender: &UnboundedSender<ComponentEvent>,
    source: &Arc<str>,
) {
    *state = level;
    emit(sender, source, "value", level);
    emit(sender, source, "event", level);
    if level {
        *hold_deadline = hold.map(|h| now + h);
        emit(sender, source, "true", level);
    } else {
        *hold_deadline = None;
        emit(sender, source, "false", level);
    }
}

/// The debounce state machine. Owns all timing state; exits when the owning
/// [`Debouncer`] is dropped (the edge sender is dropped → `Disconnected`).
fn run(
    rx: &Receiver<bool>,
    sender: &UnboundedSender<ComponentEvent>,
    source: &Arc<str>,
    hold: Option<Duration>,
) {
    let debounce = Duration::from_millis(DEBOUNCE_MS);

    let mut state = false;
    let mut pending: Option<bool> = None;
    let mut last_edge: Option<Instant> = None;
    // `Some` while held and the hold pulse has not yet fired.
    let mut hold_deadline: Option<Instant> = None;

    loop {
        // Soonest pending wakeup: the settle window (if a level is deferred) and
        // the hold pulse (if armed).
        let mut wake: Option<Instant> = None;
        if pending.is_some() {
            if let Some(edge) = last_edge {
                wake = soonest(wake, edge + debounce);
            }
        }
        if let Some(hd) = hold_deadline {
            wake = soonest(wake, hd);
        }

        let msg = match wake {
            Some(at) => {
                let dur = at.saturating_duration_since(Instant::now());
                match rx.recv_timeout(dur) {
                    Ok(level) => Some(level),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            None => match rx.recv() {
                Ok(level) => Some(level),
                Err(_) => break,
            },
        };

        let now = Instant::now();
        match msg {
            // A raw edge arrived.
            Some(level) => {
                let quiet = last_edge.map_or(true, |edge| now.duration_since(edge) >= debounce);
                last_edge = Some(now);
                if quiet {
                    // Clean edge after a quiet line: accept immediately.
                    pending = None;
                    if level != state {
                        apply(level, now, &mut state, &mut hold_deadline, hold, sender, source);
                    }
                } else {
                    // Line is bouncing (or humming): remember the level; the
                    // settle wakeup (last_edge + debounce) accepts it once quiet.
                    pending = Some(level);
                }
            }
            // A timer fired: try to settle a deferred level, and/or emit hold.
            None => {
                if let Some(p) = pending {
                    let quiet = last_edge.map_or(true, |edge| now.duration_since(edge) >= debounce);
                    if quiet {
                        pending = None;
                        if p != state {
                            apply(p, now, &mut state, &mut hold_deadline, hold, sender, source);
                        }
                    }
                    // else: still bouncing — re-armed on the next loop.
                }
                if let Some(hd) = hold_deadline {
                    if state && now >= hd {
                        emit(sender, source, "hold", true);
                        hold_deadline = None;
                    }
                }
            }
        }
    }
}

fn soonest(current: Option<Instant>, candidate: Instant) -> Option<Instant> {
    match current {
        Some(c) if c <= candidate => Some(c),
        _ => Some(candidate),
    }
}
