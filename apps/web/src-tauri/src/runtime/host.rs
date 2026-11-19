//! Desktop host for the shared `microflow_core::runtime::FlowRuntime`.
//!
//! `core::FlowRuntime` is `!Send` (single-threaded `Rc`/`RefCell`), so it cannot
//! sit in Tauri `State` (needs `Send + Sync`) or behind `Arc<TokioMutex>` the way
//! the desktop's own runtime does. The re-host confines it to a single **actor
//! thread** that also owns the serial port; everything else talks to it over a
//! `Send + Sync` `UnboundedSender<ActorMsg>` kept in `AppState`. The `!Send`
//! runtime is built *inside* the thread, so nothing unsendable ever crosses the
//! spawn boundary — only `Send` handles (services, the Tokio handle, the channel)
//! do.
//!
//! Each message maps to one core entry point whose returned [`Effects`] the actor
//! applies: write `outbound_bytes` to the port, `emit("component-events", …)`
//! once with the turn's whole event batch, arm Tokio timers for `wakeups`
//! (firing `ActorMsg::Wake`), abort them on
//! `cancellations`. On `Connect` the runtime is rebuilt fresh and the last flow
//! re-applied, so a (re)connected board gets clean pin-mode/reporting init — the
//! same model the browser reactor uses (a fresh runtime per connection).
//!
//! **Supervision.** Every turn — one message, or one serial read — runs under
//! `catch_unwind`. A panic throws the runtime away (its invariants died with
//! the turn), puts the board in a safe state, and respawns a fresh runtime
//! seeded from the live session's pin table with the last flow re-applied; the
//! webview hears `runtime-crashed`. After [`supervisor::CRASH_LIMIT`] panics in
//! [`supervisor::CRASH_WINDOW`] the actor halts instead and waits for
//! [`ActorMsg::Restart`]. The policy half lives in [`supervisor`].
//!
//! [`Effects`]: microflow_core::runtime::Effects

use crate::hardware::SessionId;
use crate::runtime::cloud_performer::{CloudPerformer, Reconciled};
use crate::runtime::supervisor::{self, CrashGuard, Fault, RuntimeCrash, RuntimeStatus, Verdict};
use microflow_core::flow::FlowUpdate;
use microflow_core::runtime::{
    CloudRequest, CloudRequestKind, ComponentEvent, ComponentValue, Effects,
    EffectsSink, FlowRuntime, NodeDiagnostic, Wakeup, WakeupId,
};
use serde::Serialize;
use std::any::Any;
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::runtime::Handle;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;

/// The serial read timeout the actor sets once it owns the port. Short so the
/// loop cycles back to drain pending `ActorMsg`s promptly (command latency
/// ≈ this) without spinning hot when there's no inbound serial traffic.
const READ_TIMEOUT_MS: u64 = 10;

/// A message the actor thread processes; each carries only `Send` data and maps
/// to one `FlowRuntime` entry point.
pub enum ActorMsg {
    /// A board connected: seed the codec's pin table (`FirmataSession.pinsJson`
    /// shape) and take ownership of the open port for raw read/write, as the
    /// board link's `session`.
    Connect {
        port: Box<dyn serialport::SerialPort>,
        pins_json: String,
        session: SessionId,
    },
    /// The board link ended the connection: drop the port, keep the flow state.
    Disconnect,
    /// A flow update (`flow_update` command). Replies once the flow is applied
    /// to the runtime, with the [`Reconciled`] of its MQTT subscriptions: the
    /// command waits on it, so it returns with the flow's topics subscribed.
    FlowUpdate {
        flow: FlowUpdate,
        reply: oneshot::Sender<Result<Reconciled, String>>,
    },
    /// An external component call (`component_call` command).
    Call {
        id: String,
        method: String,
        value: ComponentValue,
    },
    /// A hotkey press/release (`key_event`). The runtime delivers it to the
    /// nodes listening on `accelerator` (`FlowRuntime::dispatch_key_event`).
    /// `pressed` distinguishes key-down (`true`) from key-up (`false`).
    Key { accelerator: String, pressed: bool },
    /// An inbound MQTT / Figma broker payload routed to a subscribe component.
    Deliver {
        id: String,
        topic: String,
        payload: Vec<u8>,
    },
    /// A raw MIDI message from the open `midir` input `port_name`. The runtime
    /// delivers it to the `Midi` in-nodes listening to that port
    /// (`FlowRuntime::dispatch_midi_message`).
    MidiMessage { port_name: String, bytes: Vec<u8> },
    /// An async cloud-node result re-entering the runtime (the `CloudEmitter`
    /// path) — folded in via `FlowRuntime::inject_event`.
    Inject {
        source: Arc<str>,
        handle: String,
        value: ComponentValue,
    },
    /// A host timer fired: deliver `method` to `node_id` via `FlowRuntime::wake`.
    /// `id` lets the actor drop the fired timer from its table; `epoch` names
    /// the runtime instance that armed it, so a timer from a runtime since
    /// thrown away (replug, respawn) is dropped instead of waking the new one.
    Wake {
        id: WakeupId,
        epoch: u64,
        node_id: String,
        method: String,
    },
    /// Leave a crash-loop halt (`runtime_restart`): forget the recorded panics
    /// and respawn the runtime. A no-op beyond the reset when not halted.
    Restart,
    /// Whether the runtime is halted (`runtime_status`).
    Status { reply: oneshot::Sender<RuntimeStatus> },
    /// Tear the actor down (app exit).
    Shutdown,
}

impl ActorMsg {
    /// The turn's name in a crash fingerprint. Low-cardinality on purpose.
    #[must_use]
    pub fn op(&self) -> &'static str {
        match self {
            Self::Connect { .. } => "connect",
            Self::Disconnect => "disconnect",
            Self::FlowUpdate { .. } => "flowUpdate",
            Self::Call { .. } => "dispatch",
            Self::Key { .. } => "keyEvent",
            Self::Deliver { .. } => "deliverMessage",
            Self::MidiMessage { .. } => "midiMessage",
            Self::Inject { .. } => "injectEvent",
            Self::Wake { .. } => "wake",
            Self::Restart => "restart",
            Self::Status { .. } => "status",
            Self::Shutdown => "shutdown",
        }
    }

    /// A message that is a turn of the flow — dropped while the actor is
    /// halted, since there is no runtime it may trust to take it.
    fn drives_runtime(&self) -> bool {
        matches!(
            self,
            Self::Call { .. }
                | Self::Key { .. }
                | Self::Deliver { .. }
                | Self::MidiMessage { .. }
                | Self::Inject { .. }
                | Self::Wake { .. }
        )
    }
}

/// Where the actor's events to the webview go: the Tauri `AppHandle` in the
/// app, a recorder in the tests — the seam that keeps the actor (and its
/// supervision) testable without a Tauri app.
pub trait HostEvents {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S);
}

impl HostEvents for AppHandle {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        let _ = Emitter::emit(self, event, payload);
    }
}

/// What a halted actor answers a `flow_update` with. The flow is kept for the
/// restart; it is not running.
pub const HALTED: &str = "the flow runtime is halted after crashing repeatedly; reload to restart it";

/// Spawn the actor thread. The caller owns the channel (so the `Send + Sync`
/// sender can live on `AppState` + the hardware [`ActorLink`]) and the
/// `session_ended` sender: the actor reports a serial I/O failure on it as a
/// fact, and the hardware board link — the one owner of connection state —
/// decides what it means. The `!Send` `FlowRuntime` is built inside the thread,
/// so nothing unsendable crosses the spawn boundary.
///
/// Returns the [`ActorStopped`] the app waits on at exit, after sending
/// [`ActorMsg::Shutdown`].
#[must_use]
pub fn run_actor(
    rx: UnboundedReceiver<ActorMsg>,
    self_tx: UnboundedSender<ActorMsg>,
    session_ended: Sender<SessionId>,
    app: AppHandle,
    rt_handle: Handle,
    cloud: Arc<CloudPerformer>,
) -> ActorStopped {
    supervisor::install_panic_hook();
    spawn_actor(rx, move || {
        Actor::new(app, rt_handle, cloud, self_tx, session_ended, Box::new(FlowRuntime::new))
    })
}

/// Run the actor `build` makes on its own thread until `Shutdown` (or every
/// sender is gone). The actor is dropped *before* the thread reports itself
/// stopped, so a live board session has written its safe state by then.
fn spawn_actor<E: HostEvents + 'static>(
    rx: UnboundedReceiver<ActorMsg>,
    build: impl FnOnce() -> Actor<E> + Send + 'static,
) -> ActorStopped {
    let (stopped_tx, stopped_rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("microflow-runtime".into())
        .spawn(move || {
            // `run` consumes the actor; returning drops it, and with it the
            // board session (whose `Drop` writes the safe state).
            build().run(rx);
            log::info!("[actor] runtime thread stopped");
            let _ = stopped_tx.send(());
        })
        .expect("spawn microflow-runtime thread");
    ActorStopped(stopped_rx)
}

/// How long app exit waits for the actor to stop. The actor notices
/// `Shutdown` within one serial read timeout; the rest is the safe-state write.
pub const SHUTDOWN_GRACE: Duration = Duration::from_millis(500);

/// The actor thread's "I have stopped" signal. Tauri exits the process as soon
/// as its exit handler returns, which would kill the actor mid-read without
/// ever dropping its board session — so the board would keep driving whatever
/// the flow left on. The exit handler sends `Shutdown`, then waits here.
pub struct ActorStopped(std::sync::mpsc::Receiver<()>);

impl ActorStopped {
    /// Wait up to `grace` for the actor thread to stop. `true` once it has
    /// (or died: a thread that unwound past the supervisor dropped its session
    /// on the way out, too); `false` on timeout.
    #[must_use]
    pub fn wait(&self, grace: Duration) -> bool {
        !matches!(self.0.recv_timeout(grace), Err(std::sync::mpsc::RecvTimeoutError::Timeout))
    }
}

/// The hardware board link's seam to the runtime actor: hands it a detected
/// board's port and takes it back. Holds no connection state of its own — the
/// board link owns that; the actor only reports facts back, by [`SessionId`].
#[derive(Clone)]
pub struct ActorLink {
    actor: UnboundedSender<ActorMsg>,
}

impl ActorLink {
    #[must_use]
    pub fn new(actor: UnboundedSender<ActorMsg>) -> Self {
        Self { actor }
    }

    /// Hand the freshly-detected board (open port + `pins_json`) to the actor as
    /// `session`.
    pub fn connect_board(
        &self,
        port: Box<dyn serialport::SerialPort>,
        pins_json: String,
        session: SessionId,
    ) {
        let _ = self.actor.send(ActorMsg::Connect { port, pins_json, session });
    }

    /// Tell the actor to drop the board's port.
    pub fn disconnect(&self) {
        let _ = self.actor.send(ActorMsg::Disconnect);
    }
}

/// The serial byte stream the actor needs from a port. `Box<dyn SerialPort>`
/// is one; a test stands in a fake.
pub trait SerialIo: Read + Write + Send {}
impl<T: Read + Write + Send + ?Sized> SerialIo for T {}

/// A serial I/O failure ended the session (already reported).
#[derive(Debug)]
pub struct SessionEnded;

/// One live board connection as the actor holds it: the open port plus the
/// session id the board link minted for it. The first real I/O failure is
/// reported — once, by id — to the board link, which decides what it means;
/// the caller drops the session.
///
/// Dropping a healthy session writes the board's **safe state** first
/// ([`microflow_core::firmata::encode_safe_state`], the encoder the browser
/// link uses too), so nothing the flow drove stays driven. Drop is the one
/// place every end passes through: a deliberate disconnect (`ActorMsg::Disconnect`),
/// app exit (`Shutdown` ends the actor, and the exit waits for it — see
/// [`ActorStopped`]), a replacing `Connect`, and a panic
/// that escapes the actor's supervision and unwinds the thread. A panic the
/// supervisor catches keeps the session for the respawned runtime and writes
/// the safe state through [`BoardSession::write_safe_state`] instead. A
/// session that ended on an I/O failure skips it: the link that failed cannot
/// carry the reset.
pub struct BoardSession {
    id: SessionId,
    port: Box<dyn SerialIo>,
    ended: Sender<SessionId>,
    /// Written on drop while the link is healthy; empty = nothing to write.
    safe_state: Vec<u8>,
    /// An I/O failure was reported; the port is not written again.
    failed: bool,
}

impl BoardSession {
    #[must_use]
    pub fn new(id: SessionId, port: Box<dyn SerialIo>, ended: Sender<SessionId>) -> Self {
        Self { id, port, ended, safe_state: Vec::new(), failed: false }
    }

    /// Write `bytes` (the board's safe state) when this session is dropped
    /// while healthy.
    #[must_use]
    pub fn with_safe_state(mut self, bytes: Vec<u8>) -> Self {
        self.safe_state = bytes;
        self
    }

    /// Read whatever arrived; `Ok(0)` when nothing did within the port timeout.
    ///
    /// # Errors
    /// [`SessionEnded`] on a real I/O failure, after reporting it.
    pub fn read(&mut self, buf: &mut [u8]) -> Result<usize, SessionEnded> {
        match self.port.read(buf) {
            Ok(n) => Ok(n),
            Err(e) if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => Ok(0),
            Err(e) => Err(self.end("read", &e)),
        }
    }

    /// Write `bytes` in full. No `flush()`: on macOS it blocks (`tcdrain`) until
    /// the bytes finish transmitting, so flushing every outbound batch made a
    /// 60fps oscillator's write take longer than its tick period and starve the
    /// serial read (see `Actor::run`). `write_all` hands the bytes to the OS in
    /// order; the kernel transmits them — synchronous drain isn't needed.
    ///
    /// # Errors
    /// [`SessionEnded`] on an I/O failure, after reporting it.
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), SessionEnded> {
        self.port.write_all(bytes).map_err(|e| self.end("write", &e))
    }

    fn end(&mut self, op: &str, error: &std::io::Error) -> SessionEnded {
        log::warn!("[actor] serial {op} error on session {}: {error}; dropping board", self.id);
        self.failed = true;
        let _ = self.ended.send(self.id);
        SessionEnded
    }
}

impl BoardSession {
    /// Write the safe state now and keep the session — the actor's answer to a
    /// panic, where the board stays connected for the respawned runtime. A
    /// no-op on a session without one.
    ///
    /// # Errors
    /// [`SessionEnded`] on an I/O failure, after reporting it.
    pub fn write_safe_state(&mut self) -> Result<(), SessionEnded> {
        if self.failed || self.safe_state.is_empty() {
            return Ok(());
        }
        let bytes = self.safe_state.clone();
        self.write(&bytes)
    }
}

impl Drop for BoardSession {
    /// Best effort: a failure here is not reported — the session is already
    /// over, and the board link learns about a gone port from the port scan.
    fn drop(&mut self) {
        if self.failed || self.safe_state.is_empty() {
            return;
        }
        match self.port.write_all(&self.safe_state) {
            Ok(()) => log::info!("[actor] wrote the safe state to session {}", self.id),
            Err(e) => log::debug!("[actor] safe state not written to session {}: {e}", self.id),
        }
    }
}

/// The safe state for the board a `pins_json` describes: its pin profile, as
/// the browser uses its detection codec's.
fn safe_state_for(pins_json: &str) -> Vec<u8> {
    use microflow_core::firmata::{encode_safe_state, PinInfo, PinProfile};
    let infos = serde_json::from_str::<Vec<PinInfo>>(pins_json).unwrap_or_default();
    encode_safe_state(&PinProfile::from_pin_infos(&infos))
}

/// Builds a fresh runtime: `FlowRuntime::new` in the app; tests add a node.
type RuntimeFactory = Box<dyn Fn() -> FlowRuntime>;

/// Owns the `!Send` `FlowRuntime` + the serial port; lives entirely on one thread.
struct Actor<E: HostEvents> {
    rt: FlowRuntime,
    /// How a fresh runtime is built — on connect, and on respawn after a panic.
    make_runtime: RuntimeFactory,
    /// Bumped each time the runtime is rebuilt; a `Wake` armed by an older
    /// runtime is stale.
    epoch: u64,
    /// The board connection while one is live; `None` otherwise.
    session: Option<BoardSession>,
    /// The live session's pin table (`FirmataSession.pinsJson` shape), kept so
    /// a respawned runtime is seeded exactly as the connect seeded the last one.
    pins_json: Option<String>,
    /// Last flow, re-applied on (re)connect for clean board init.
    last_flow: Option<FlowUpdate>,
    /// The crash-loop guard.
    guard: CrashGuard,
    /// The guard tripped: no runtime drives the board until `Restart`.
    halted: bool,
    /// The crash that tripped the guard, for `runtime_status`.
    halt_crash: Option<RuntimeCrash>,
    events: E,
    rt_handle: Handle,
    self_tx: UnboundedSender<ActorMsg>,
    /// Where a [`BoardSession`] reports its own end (to the board link).
    session_ended: Sender<SessionId>,
    /// Monotonic clock origin; `now_ms` is elapsed-since-start.
    start: Instant,
    /// Live host timers keyed by wakeup id, so cancellations + fired timers
    /// can be dropped.
    timers: HashMap<WakeupId, tokio::task::AbortHandle>,
    /// Performs cloud `Effects` (ADR-0009) on the broker pool and owns the MQTT
    /// subscriptions. `EffectsSink::perform_cloud` delegates here.
    cloud: Arc<CloudPerformer>,
    /// Open `midir` connections; inputs reconciled per flow update, outputs
    /// opened lazily per `MidiSend`. Thread-confined like the runtime.
    midi: crate::runtime::midi::MidiManager,
}

impl<E: HostEvents> Actor<E> {
    fn new(
        events: E,
        rt_handle: Handle,
        cloud: Arc<CloudPerformer>,
        self_tx: UnboundedSender<ActorMsg>,
        session_ended: Sender<SessionId>,
        make_runtime: RuntimeFactory,
    ) -> Self {
        // Cloud nodes are sans-IO and auto-registered by core (the `cloud`
        // feature); the actor only supplies the `CloudPerformer` that performs
        // their recorded requests.
        Self {
            rt: make_runtime(),
            make_runtime,
            epoch: 0,
            session: None,
            pins_json: None,
            last_flow: None,
            guard: CrashGuard::default(),
            halted: false,
            halt_crash: None,
            events,
            rt_handle,
            self_tx,
            session_ended,
            start: Instant::now(),
            timers: HashMap::new(),
            cloud,
            midi: crate::runtime::midi::MidiManager::new(),
        }
    }

    /// Advance the runtime clock to now.
    fn set_now(&mut self) {
        self.rt.set_now(self.start.elapsed().as_secs_f64() * 1000.0);
    }

    fn run(mut self, mut rx: UnboundedReceiver<ActorMsg>) {
        loop {
            // Drain queued messages — but read the serial port after EACH one so a
            // relentless outbound wake loop can never starve inbound reads. A 60fps
            // oscillator arms a `_tick` every ~16ms; if we drained the WHOLE queue
            // before reading (as this once did) and processing a wake takes longer
            // than that period, the queue never empties, `pump_port` never runs,
            // and every input (buttons, I2C, NFC) goes silent while outbound floods.
            loop {
                match rx.try_recv() {
                    Ok(msg) => {
                        if !self.step(msg) {
                            return;
                        }
                        if self.session.is_some() {
                            self.supervised_pump();
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }

            // Idle: keep reading while connected; block for the next message when
            // disconnected (no busy spin).
            if self.session.is_some() {
                self.supervised_pump();
            } else {
                match rx.blocking_recv() {
                    Some(msg) => {
                        if !self.step(msg) {
                            return;
                        }
                    }
                    None => return,
                }
            }
        }
    }

    /// One message as a supervised turn. Returns `false` on shutdown.
    fn step(&mut self, msg: ActorMsg) -> bool {
        let op = msg.op();
        self.supervised(op, |actor| actor.handle(msg))
    }

    /// One serial read as a supervised turn.
    fn supervised_pump(&mut self) {
        self.supervised("feedBytes", |actor| {
            actor.pump_port();
            true
        });
    }

    /// Run `turn`; a panic inside it is caught here and answered by
    /// [`Self::recover`] instead of killing the thread (and the port with it).
    fn supervised(&mut self, op: &'static str, turn: impl FnOnce(&mut Self) -> bool) -> bool {
        match catch_unwind(AssertUnwindSafe(|| turn(self))) {
            Ok(keep_running) => keep_running,
            Err(payload) => {
                self.recover(op, &*payload);
                true
            }
        }
    }

    /// A turn panicked. Report it, throw the runtime away, put the board in a
    /// safe state, and — unless the crash guard trips — respawn. A respawn
    /// that panics too (the re-applied flow is what panics) is one more crash,
    /// so a deterministic fault halts after [`supervisor::CRASH_LIMIT`] tries.
    fn recover(&mut self, op: &'static str, payload: &(dyn Any + Send)) {
        let mut fault = Fault::capture(op);
        let mut message = supervisor::panic_message(payload).to_string();
        loop {
            let verdict = self.guard.record(Instant::now());
            log::error!(
                "[actor] runtime panicked in {} at {} (#{}): {message}",
                fault.op,
                fault.location,
                fault.fingerprint
            );
            let crash = fault.event(verdict == Verdict::Respawn, self.guard.recent());
            self.events.emit("runtime-crashed", crash.clone());
            // The panicked runtime's state is indeterminate (ADR-0017 D3): it
            // never drives the board again, and neither do its timers.
            self.rebuild_runtime(false);
            self.safe_state();
            if verdict == Verdict::Halt {
                log::error!("[actor] {} panics within the crash window; runtime halted", self.guard.recent());
                self.halted = true;
                self.halt_crash = Some(crash);
                // No runtime serves the flow's subscribers until the restart:
                // its MQTT subscriptions go, and the design-tool plugins hear
                // that Studio left. Nothing is asked of the runtime that
                // panicked; the restart reconciles the flow's wirings again.
                let _ = self.cloud.reconcile(Vec::new());
                return;
            }
            match catch_unwind(AssertUnwindSafe(|| self.respawn())) {
                Ok(()) => return,
                Err(payload) => {
                    fault = Fault::capture("respawn");
                    message = supervisor::panic_message(&*payload).to_string();
                }
            }
        }
    }

    /// A fresh runtime with the live session's pins and the last flow: the
    /// state a replug would reach, without the replug.
    fn respawn(&mut self) {
        self.halted = false;
        self.halt_crash = None;
        self.rebuild_runtime(true);
        self.apply_last_flow();
        // MQTT subscriptions. The `CloudPerformer` holds what the last flow
        // update that got through wired; the update that panicked (or one kept
        // while halted) never got that far, so the respawned runtime may wire
        // subscribers differently. Reconcile every time: it is a diff, so an
        // unchanged set touches nothing. Nobody waits on this one.
        let _ = self.cloud.reconcile(self.rt.collect_subscriber_wirings());
        // MIDI inputs live on the actor: reconcile the open ports against the
        // respawned runtime.
        self.midi.reconcile(&self.rt, &self.self_tx);
        log::info!("[actor] runtime respawned (epoch {})", self.epoch);
    }

    /// Replace the runtime with a fresh one and abort the old one's timers — the
    /// rebuild mints fresh wakeup ids, so stale timers would double-fire (e.g.
    /// an interval ticking twice as fast after a replug). `seed`: seed the pin
    /// table from the live session, if there is one.
    fn rebuild_runtime(&mut self, seed: bool) {
        for (_, handle) in self.timers.drain() {
            handle.abort();
        }
        self.epoch += 1;
        self.rt = (self.make_runtime)();
        if !seed || self.session.is_none() {
            return;
        }
        if let Some(pins_json) = &self.pins_json {
            if let Err(e) = self.rt.seed_pins(pins_json) {
                log::warn!("[actor] seed_pins failed: {e}");
            }
        }
    }

    /// Re-apply the last flow to the current runtime: clean pin-mode/reporting
    /// init on the board.
    fn apply_last_flow(&mut self) {
        if let Some(flow) = self.last_flow.clone() {
            self.set_now();
            let effects = self.rt.update_flow(flow);
            self.apply(effects);
        }
    }

    /// Put the board in its safe state before a new runtime (or none) drives
    /// it: whatever the panicked flow drove — a motor, a relay — goes low,
    /// and the respawn's re-applied flow starts from a reset board. The
    /// session stays open; a write failure ends it like any other.
    fn safe_state(&mut self) {
        if let Some(session) = self.session.as_mut() {
            if session.write_safe_state().is_err() {
                self.session = None;
            }
        }
    }

    /// A board connected: hold its port, and — unless halted — build a fresh
    /// runtime seeded from its pin table and re-apply the flow.
    fn connect(&mut self, port: Box<dyn SerialIo>, pins_json: String, session: SessionId) {
        // Diagnostic (Bug B): the seeded table decides which pins the
        // runtime will accept analog reporting for (a pin needs
        // `analogChannel >= 0`). Logging the raw JSON distinguishes
        // "analog mapping never parsed" (no pin analog) from "A0 is not
        // pin 14 on this board" (some other pin carries the analog flag).
        log::info!("[actor] seeded pins_json: {pins_json}");
        // Replacing a live session drops it, which writes its safe state.
        self.session = Some(
            BoardSession::new(session, port, self.session_ended.clone())
                .with_safe_state(safe_state_for(&pins_json)),
        );
        self.pins_json = Some(pins_json);
        log::info!("[actor] board connected (session {session})");
        if self.halted {
            return;
        }
        // Fresh runtime → clean pin-mode/reporting init on the new board.
        self.rebuild_runtime(true);
        self.apply_last_flow();
    }

    /// Process one message. Returns `false` on shutdown.
    fn handle(&mut self, msg: ActorMsg) -> bool {
        if self.halted && msg.drives_runtime() {
            return true;
        }
        match msg {
            ActorMsg::Connect { port, pins_json, session } => {
                let mut port = port;
                let _ = port.set_timeout(Duration::from_millis(READ_TIMEOUT_MS));
                self.connect(Box::new(port), pins_json, session);
            }
            ActorMsg::Disconnect => {
                // Dropping the session writes the safe state (see `BoardSession`).
                self.session = None;
                log::info!("[actor] board disconnected");
            }
            ActorMsg::FlowUpdate { flow, reply } if self.halted => {
                // Kept for the restart (which reconciles the subscriptions),
                // but not running: say so rather than ack it.
                self.last_flow = Some(flow);
                let _ = reply.send(Err(HALTED.to_string()));
            }
            ActorMsg::FlowUpdate { flow, reply } => {
                self.last_flow = Some(flow.clone());
                self.set_now();
                let effects = self.rt.update_flow(flow);
                self.apply(effects);
                // The reply carries the reconcile it is answered for: what the
                // command waits on cannot be anything older.
                let reconciled = self.cloud.reconcile(self.rt.collect_subscriber_wirings());
                let _ = reply.send(Ok(reconciled));
                // The flow changed, and with it the MIDI inputs it wants open.
                self.midi.reconcile(&self.rt, &self.self_tx);
            }
            ActorMsg::Call { id, method, value } => {
                self.set_now();
                let effects = self.rt.dispatch(&id, &method, value);
                self.apply(effects);
            }
            ActorMsg::Key { accelerator, pressed } => {
                self.set_now();
                let effects = self.rt.dispatch_key_event(&accelerator, pressed);
                self.apply(effects);
            }
            ActorMsg::Deliver { id, topic, payload } => {
                self.set_now();
                let effects = self.rt.deliver_message(&id, &topic, &payload);
                self.apply(effects);
            }
            ActorMsg::MidiMessage { port_name, bytes } => {
                self.set_now();
                let effects = self.rt.dispatch_midi_message(&port_name, &bytes);
                self.apply(effects);
            }
            ActorMsg::Inject { source, handle, value } => {
                self.set_now();
                let effects = self.rt.inject_event(&source, &handle, value);
                self.apply(effects);
            }
            ActorMsg::Wake { epoch, .. } if epoch != self.epoch => {
                // Armed by a runtime since thrown away (replug, respawn).
            }
            ActorMsg::Wake { id, node_id, method, .. } => {
                self.timers.remove(&id);
                self.set_now();
                let effects = self.rt.wake(&node_id, &method);
                self.apply(effects);
            }
            ActorMsg::Status { reply } => {
                let _ = reply.send(RuntimeStatus { halted: self.halted, crash: self.halt_crash.clone() });
            }
            ActorMsg::Restart => {
                self.guard.reset();
                if self.halted {
                    log::info!("[actor] restart requested; leaving the crash-loop halt");
                    self.respawn();
                }
            }
            ActorMsg::Shutdown => return false,
        }
        true
    }

    /// Read available serial bytes into the codec and apply the resulting turn.
    /// Halted, the bytes are read (so a dead port is still noticed) and dropped.
    fn pump_port(&mut self) {
        let mut buf = [0u8; 256];
        let Some(session) = self.session.as_mut() else { return };
        match session.read(&mut buf) {
            Ok(0) => {}
            Ok(_) if self.halted => {}
            Ok(n) => {
                self.set_now();
                let effects = self.rt.feed_bytes(&buf[..n]);
                self.apply(effects);
            }
            Err(SessionEnded) => self.session = None,
        }
    }

    /// Apply one turn's [`Effects`] in the canonical order (ADR-0008). The order
    /// lives in core (`Effects::apply`); this actor is the `EffectsSink` that
    /// supplies the four desktop platform primitives.
    fn apply(&mut self, effects: Effects) {
        effects.apply(self);
    }
}

/// The desktop platform primitives behind the ADR-0008 [`EffectsSink`] hooks:
/// serial write + flush, Tauri `emit`, and Tokio timer arm/abort. The canonical
/// *order* these fire in is owned by `Effects::apply`, not here.
impl<E: HostEvents> EffectsSink for Actor<E> {
    fn write_bytes(&mut self, bytes: &[u8]) {
        if let Some(session) = self.session.as_mut() {
            if session.write(bytes).is_err() {
                self.session = None;
            }
        }
    }

    fn cancel_wakeup(&mut self, id: WakeupId) {
        if let Some(handle) = self.timers.remove(&id) {
            handle.abort();
        }
    }

    /// Arm a host timer that fires `ActorMsg::Wake` after the wakeup's delay.
    fn arm_wakeup(&mut self, wakeup: &Wakeup) {
        let tx = self.self_tx.clone();
        let id = wakeup.id;
        let epoch = self.epoch;
        let node_id = wakeup.node_id.clone();
        let method = wakeup.method.clone();
        let delay_ms = wakeup.delay_ms;
        let join = self.rt_handle.spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let _ = tx.send(ActorMsg::Wake { id, epoch, node_id, method });
        });
        self.timers.insert(id, join.abort_handle());
    }

    /// Perform a cloud node's outbound call (ADR-0009) by delegating to the
    /// [`CloudPerformer`], which holds the broker pool. The ordering (cloud
    /// before UI events) is fixed by `Effects::apply`; this just supplies the
    /// primitive.
    fn perform_cloud(&mut self, request: &CloudRequest) {
        // MIDI is host-peripheral I/O on the actor's own `midir` connections,
        // not an async network call — handled here, not by the `CloudPerformer`.
        if let CloudRequestKind::MidiSend { device_name, bytes } = &request.kind {
            self.midi.send(device_name, bytes);
            return;
        }
        // Audio plays in the webview: the desktop app already *is* a browser, so
        // forwarding the request lets both hosts share one `AudioPerformer`
        // instead of linking an audio backend here. The webview resolves the
        // node's `src` (see `desktop-runtime-host.ts`).
        if matches!(request.kind, CloudRequestKind::AudioPlay { .. } | CloudRequestKind::AudioStop) {
            self.events.emit("audio-request", request);
            return;
        }
        // LLM generation runs in the webview too, for the same reason and with
        // more to gain (ADR-0021): one TanStack AI transport serves both hosts,
        // so streaming, tool calls and provider quirks are implemented once
        // instead of twice-and-parity-tested. The webview resolves the provider
        // from its own store and injects the result back through the
        // `llm_result` command (see `ai/llm-performer.ts`).
        //
        // Reaching a laptop-local endpoint from the webview would normally die
        // on CORS; the frontend performs it over `@tauri-apps/plugin-http`,
        // which requests from Rust exactly as this host used to.
        if matches!(request.kind, CloudRequestKind::LlmGenerate { .. }) {
            self.events.emit("llm-request", request);
            return;
        }
        self.cloud.perform(request);
    }

    fn dispatch_event(&mut self, event: &ComponentEvent) {
        self.dispatch_events(std::slice::from_ref(event));
    }

    /// One Tauri IPC message per turn: event name `component-events`, payload a
    /// `ComponentEvent[]` in emission order. Every event of a turn costs one
    /// serialize + one IPC hop + one webview `JSON.parse` together, not each.
    fn dispatch_events(&mut self, events: &[ComponentEvent]) {
        self.events.emit("component-events", events);
    }

    fn report_diagnostic(&mut self, diagnostic: &NodeDiagnostic) {
        self.events.emit("node-diagnostic", diagnostic);
    }
}

#[cfg(test)]
#[path = "hardware_smoke.rs"]
mod hardware_smoke;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::services::RecordingMqttBrokers;
    use microflow_core::flow::{FlowEdge, FlowNode, Position};

    fn node(id: &str, instance: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some(instance.to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    /// A port whose reads replay a script and whose writes succeed or fail.
    struct ScriptedPort {
        reads: std::collections::VecDeque<std::io::Result<Vec<u8>>>,
        write_error: Option<ErrorKind>,
        /// Every successful write, shared so a test can read it after the drop.
        written: Arc<std::sync::Mutex<Vec<u8>>>,
    }

    impl ScriptedPort {
        fn new(reads: Vec<std::io::Result<Vec<u8>>>, write_error: Option<ErrorKind>) -> Self {
            Self { reads: reads.into(), write_error, written: Arc::default() }
        }
    }

    impl Read for ScriptedPort {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.reads.pop_front() {
                Some(Ok(bytes)) => {
                    buf[..bytes.len()].copy_from_slice(&bytes);
                    Ok(bytes.len())
                }
                Some(Err(e)) => Err(e),
                None => Err(ErrorKind::TimedOut.into()),
            }
        }
    }

    impl Write for ScriptedPort {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if let Some(kind) = self.write_error {
                return Err(kind.into());
            }
            self.written.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn session(port: ScriptedPort) -> (BoardSession, std::sync::mpsc::Receiver<SessionId>) {
        let (tx, rx) = std::sync::mpsc::channel();
        (BoardSession::new(7, Box::new(port), tx), rx)
    }

    #[test]
    fn session_read_timeout_is_no_data_not_an_end() {
        let (mut s, ended) =
            session(ScriptedPort::new(vec![Err(ErrorKind::TimedOut.into()), Ok(vec![0xF9, 2, 5])], None));
        let mut buf = [0u8; 8];
        assert_eq!(s.read(&mut buf).unwrap(), 0);
        assert_eq!(s.read(&mut buf).unwrap(), 3);
        assert!(s.write(&[0x90, 0, 0]).is_ok());
        assert!(ended.try_recv().is_err(), "nothing ended");
    }

    #[test]
    fn session_read_error_reports_its_id() {
        let (mut s, ended) = session(ScriptedPort::new(vec![Err(ErrorKind::BrokenPipe.into())], None));
        assert!(s.read(&mut [0u8; 8]).is_err());
        assert_eq!(ended.try_iter().collect::<Vec<_>>(), vec![7]);
    }

    #[test]
    fn session_write_error_reports_its_id() {
        // A write failure mid-session used to clear a shared flag the monitor
        // only noticed if the port was tagged `has_firmata`; now it is a fact
        // the board link receives by session id.
        let (mut s, ended) = session(ScriptedPort::new(vec![], Some(ErrorKind::BrokenPipe)));
        assert!(s.write(&[0x90, 0, 0]).is_err());
        assert_eq!(ended.try_iter().collect::<Vec<_>>(), vec![7]);
    }

    /// The pins JSON both hosts seed from: `[{ pin, supportedModes, analogChannel }]`.
    fn pins_json(count: usize) -> String {
        let pins: Vec<_> = (0..count)
            .map(|pin| serde_json::json!({ "pin": pin, "supportedModes": [0, 1], "analogChannel": -1 }))
            .collect();
        serde_json::Value::Array(pins).to_string()
    }

    #[test]
    fn dropping_a_healthy_session_writes_the_safe_state() {
        // Disconnect, app exit, a replacing connect and an unwinding actor all
        // end a session by dropping it.
        let port = ScriptedPort::new(vec![], None);
        let written = Arc::clone(&port.written);
        let (s, _ended) = session(port);
        drop(s.with_safe_state(safe_state_for(&pins_json(20))));
        let twenty = microflow_core::firmata::PinProfile::new(vec![microflow_core::firmata::PinCaps::default(); 20]);
        assert_eq!(*written.lock().unwrap(), microflow_core::firmata::encode_safe_state(&twenty));
    }

    #[test]
    fn a_session_that_failed_is_not_written_on_drop() {
        let port = ScriptedPort::new(vec![Err(ErrorKind::BrokenPipe.into())], None);
        let written = Arc::clone(&port.written);
        let (s, _ended) = session(port);
        let mut s = s.with_safe_state(safe_state_for(&pins_json(20)));
        assert!(s.read(&mut [0u8; 8]).is_err());
        drop(s);
        assert!(written.lock().unwrap().is_empty(), "a lost link cannot carry the reset");
    }

    /// The safe state, applied by a simulated board, leaves every output low —
    /// what the desktop now sends where it used to send nothing.
    #[test]
    fn the_desktop_safe_state_lowers_a_flow_driven_output_on_the_sim_board() {
        use microflow_core::firmata::sim::{BoardLayout, SimBoard};
        use microflow_core::firmata::{FirmataClient, MODE_OUTPUT};
        let mut board = SimBoard::new(BoardLayout::uno());
        let mut codec = FirmataClient::new();
        board.receive(&codec.encode_set_pin_mode(13, MODE_OUTPUT));
        board.receive(&codec.encode_digital_write(13, true));
        assert!(board.pin(13).is_high());
        board.receive(&safe_state_for(&pins_json(20)));
        assert!(!board.pin(13).is_high());
    }

    #[test]
    fn registered_figma_node_emits_cloud_request_on_dispatch() {
        // End-to-end of the registration + sans-IO seam: core auto-registers the
        // cloud nodes → update_flow builds the node from JSON → dispatch returns
        // the `CloudRequest` in the turn's `Effects` (no broker, no Tokio).
        let mut rt = FlowRuntime::new();
        rt.update_flow(FlowUpdate {
            nodes: vec![node(
                "fig",
                "Figma",
                serde_json::json!({
                    "brokerId": "broker-1",
                    "uniqueId": "uid-1",
                    "variableId": "VariableID:1:2",
                    "resolvedType": "BOOLEAN",
                }),
            )],
            edges: vec![],
        });

        let effects = rt.dispatch("fig", "true", ComponentValue::Bool(true));
        assert_eq!(effects.cloud_requests.len(), 1);
        match effects.cloud_requests.into_iter().next().unwrap().kind {
            CloudRequestKind::MqttPublish { topic, payload, .. } => {
                assert_eq!(topic, "microflow/uid-1/app/variable/1-2/set");
                assert_eq!(payload, b"true");
            }
            other @ (CloudRequestKind::LlmGenerate { .. }
            | CloudRequestKind::MidiSend { .. }
            | CloudRequestKind::AudioPlay { .. }
            | CloudRequestKind::AudioStop) => {
                panic!("expected MqttPublish, got {other:?}")
            }
        }
    }

    #[test]
    fn registers_mqtt_and_llm_without_error() {
        // Smoke: both build from JSON via core's auto-registration (no ComponentNotFound).
        let mut rt = FlowRuntime::new();
        rt.update_flow(FlowUpdate {
            nodes: vec![
                node(
                    "m",
                    "Mqtt",
                    serde_json::json!({ "direction": "publish", "brokerId": "b", "topic": "t" }),
                ),
                node(
                    "l",
                    "Llm",
                    serde_json::json!({ "providerId": "p", "model": "m", "prompt": "hi" }),
                ),
            ],
            edges: Vec::<FlowEdge>::new(),
        });
    }

    // --- Supervision: a panicking turn respawns the runtime -----------------

    use microflow_core::runtime::{Component, ComponentBase, RuntimeContext, RuntimeError};
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use std::sync::Mutex;

    /// The actor's webview events, recorded as JSON.
    #[derive(Clone, Default)]
    struct RecordingEvents(Rc<RefCell<Vec<(String, serde_json::Value)>>>);

    impl HostEvents for RecordingEvents {
        fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
            self.0.borrow_mut().push((event.to_string(), serde_json::to_value(payload).unwrap()));
        }
    }

    impl RecordingEvents {
        fn named(&self, name: &str) -> Vec<serde_json::Value> {
            self.0.borrow().iter().filter(|(e, _)| e == name).map(|(_, p)| p.clone()).collect()
        }

        fn crashes(&self) -> Vec<serde_json::Value> {
            self.named("runtime-crashed")
        }
    }

    /// A port that never has input and records every byte written to it.
    struct RecordingPort(Arc<Mutex<Vec<u8>>>);

    impl Read for RecordingPort {
        fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
            Err(ErrorKind::TimedOut.into())
        }
    }

    impl Write for RecordingPort {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// A node that panics: in dispatch on `boom`, on a `_boom` wakeup (core
    /// strips the `_`), on start when `data.panicOnStart`, and on the first
    /// start of any `data.panicOnce` node (a shared fuse). Counts its starts —
    /// one per flow apply.
    struct Panicker {
        base: ComponentBase,
        panic_on_start: bool,
        panic_once: bool,
        fuse: Rc<Cell<bool>>,
        starts: Rc<Cell<u32>>,
    }

    impl Component for Panicker {
        fn base(&self) -> &ComponentBase {
            &self.base
        }
        fn base_mut(&mut self) -> &mut ComponentBase {
            &mut self.base
        }
        fn component_type(&self) -> &'static str {
            "Panicker"
        }
        fn dispatch(&mut self, method: &str, _a: ComponentValue, _c: &mut RuntimeContext) -> Result<(), RuntimeError> {
            assert!(method != "boom", "node panicked in dispatch");
            Ok(())
        }
        fn dispatch_internal(&mut self, method: &str, _v: ComponentValue, _c: &mut RuntimeContext) -> Result<(), RuntimeError> {
            assert!(method != "boom", "node panicked in a wakeup");
            Ok(())
        }
        fn on_start(&mut self, _ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
            self.starts.set(self.starts.get() + 1);
            assert!(!self.panic_on_start, "node panicked on start");
            let first = self.panic_once && !self.fuse.replace(true);
            assert!(!first, "node panicked on its first start");
            Ok(())
        }
    }

    struct Rig {
        actor: Actor<RecordingEvents>,
        events: RecordingEvents,
        written: Arc<Mutex<Vec<u8>>>,
        starts: Rc<Cell<u32>>,
        /// The actor's real `CloudPerformer`, on a recording broker pool with
        /// broker `b` connected.
        cloud: Arc<CloudPerformer>,
        brokers: Arc<RecordingMqttBrokers>,
        /// Never running on its own: [`Rig::subscriptions`] drives it.
        tokio: tokio::runtime::Runtime,
    }

    impl Rig {
        /// An actor whose runtimes know `Panicker`, connected as session 7 to a
        /// 20-pin board whose pins 14–19 are analog (A0 = pin 14).
        fn connected() -> Self {
            Self::connected_to(Arc::new(Mutex::new(Vec::new())))
        }

        /// As [`Rig::connected`], with the port writing into `written`.
        fn connected_to(written: Arc<Mutex<Vec<u8>>>) -> Self {
            supervisor::install_panic_hook();
            let tokio = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
            let starts = Rc::new(Cell::new(0));
            let factory_starts = Rc::clone(&starts);
            let fuse = Rc::new(Cell::new(false));
            let make_runtime: RuntimeFactory = Box::new(move || {
                let mut rt = FlowRuntime::new();
                let starts = Rc::clone(&factory_starts);
                let fuse = Rc::clone(&fuse);
                rt.register_test_factory(
                    "Panicker",
                    Box::new(move |id, data| {
                        let flag = |key: &str| data.get(key).and_then(serde_json::Value::as_bool).unwrap_or(false);
                        Ok(Box::new(Panicker {
                            base: ComponentBase::new(id, ComponentValue::default()),
                            panic_on_start: flag("panicOnStart"),
                            panic_once: flag("panicOnce"),
                            fuse: Rc::clone(&fuse),
                            starts: Rc::clone(&starts),
                        }))
                    }),
                );
                rt
            });
            let events = RecordingEvents::default();
            let (self_tx, _self_rx) = tokio::sync::mpsc::unbounded_channel();
            let (ended_tx, _ended_rx) = std::sync::mpsc::channel();
            let (cloud, brokers) = CloudPerformer::on_recording_pool(self_tx.clone(), tokio.handle().clone());
            let mut actor = Actor::new(
                events.clone(),
                tokio.handle().clone(),
                Arc::clone(&cloud),
                self_tx,
                ended_tx,
                make_runtime,
            );
            actor.connect(Box::new(RecordingPort(Arc::clone(&written))), analog_pins_json(), 7);
            Self { actor, events, written, starts, cloud, brokers, tokio }
        }

        fn flow(&mut self, panic_on_start: bool) -> Result<FlowReply, oneshot::error::TryRecvError> {
            let p = node("p", "Panicker", serde_json::json!({ "panicOnStart": panic_on_start }));
            self.send_flow(vec![p, sensor_a0()])
        }

        fn send_flow(&mut self, nodes: Vec<FlowNode>) -> Result<FlowReply, oneshot::error::TryRecvError> {
            let (reply, mut rx) = oneshot::channel();
            assert!(self.actor.step(ActorMsg::FlowUpdate { flow: FlowUpdate { nodes, edges: vec![] }, reply }));
            rx.try_recv().map(|reply| reply.map(|_reconciled| ()))
        }

        /// The topics broker `b` holds for the flow, once the performer has
        /// applied everything the actor handed it.
        fn subscriptions(&self) -> Vec<String> {
            self.tokio.block_on(self.cloud.settled());
            self.brokers.subscriptions("b")
        }

        fn status(&mut self) -> RuntimeStatus {
            let (reply, mut rx) = oneshot::channel();
            assert!(self.actor.step(ActorMsg::Status { reply }));
            rx.try_recv().unwrap()
        }

        fn call(&mut self, method: &str) {
            let msg = ActorMsg::Call { id: "p".into(), method: method.into(), value: ComponentValue::default() };
            assert!(self.actor.step(msg), "a panic never stops the actor");
        }

        fn take_written(&self) -> Vec<u8> {
            std::mem::take(&mut *self.written.lock().unwrap())
        }
    }

    /// A flow update's reply, without the reconcile it carries.
    type FlowReply = Result<(), String>;

    fn sensor_a0() -> FlowNode {
        node(
            "pot",
            "Sensor",
            serde_json::json!({ "instance": "Sensor", "pin": "A0", "type": "analog", "threshold": 1 }),
        )
    }

    /// 20 pins; 14–19 are analog channels 0–5.
    fn analog_pins_json() -> String {
        let pins: Vec<serde_json::Value> = (0..20)
            .map(|p| {
                let channel = if p >= 14 { p - 14 } else { -1 };
                serde_json::json!({ "pin": p, "supportedModes": [], "analogChannel": channel })
            })
            .collect();
        serde_json::to_string(&pins).unwrap()
    }

    /// `REPORT_ANALOG` on channel 0: only a runtime whose pin table says pin 14
    /// is analog sends it for the Sensor on A0.
    const REPORT_A0: [u8; 2] = [0xC0, 1];

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn report_a0_needs_the_seeded_pin_table() {
        // The control for the re-seed assertions below: an unseeded runtime
        // does not enable analog reporting for A0.
        let mut rt = FlowRuntime::new();
        let effects = rt.update_flow(FlowUpdate { nodes: vec![sensor_a0()], edges: vec![] });
        assert!(!contains(&effects.outbound_bytes, &REPORT_A0), "{:02X?}", effects.outbound_bytes);
    }

    #[test]
    fn a_panicking_turn_respawns_a_seeded_runtime_and_reapplies_the_flow() {
        let mut rig = Rig::connected();
        rig.flow(false).expect("replied").expect("the flow applied");
        assert_eq!(rig.starts.get(), 1);
        assert!(contains(&rig.take_written(), &REPORT_A0), "the connect seeded the pins");
        let epoch = rig.actor.epoch;

        rig.call("boom");

        // Reported, once, without the panic message.
        let crashes = rig.events.crashes();
        assert_eq!(crashes.len(), 1);
        let crash = &crashes[0];
        assert_eq!(crash["op"], "dispatch");
        assert_eq!(crash["recovered"], true);
        assert_eq!(crash["crashes"], 1);
        assert_eq!(crash["fingerprint"].as_str().unwrap().len(), 8);
        assert!(crash["location"].as_str().unwrap().starts_with("src-tauri/src/runtime/host.rs:"), "{crash}");
        assert!(!crash.to_string().contains("panicked in dispatch"), "the message stays local: {crash}");

        // A fresh runtime, seeded from the live session, running the flow again.
        assert!(!rig.actor.halted);
        assert!(rig.actor.epoch > epoch, "the runtime was rebuilt");
        assert_eq!(rig.starts.get(), 2, "the flow was re-applied");
        assert!(rig.actor.session.is_some(), "the board session survives");
        let written = rig.take_written();
        let safe = safe_state_for(&analog_pins_json());
        assert!(written.starts_with(&safe), "the safe state goes out first: {written:02X?}");
        assert!(contains(&written[safe.len()..], &REPORT_A0), "then the re-seeded pins are re-inited");

        // And it keeps working.
        rig.call("fine");
        assert_eq!(rig.events.crashes().len(), 1);
    }

    #[test]
    fn a_crash_loop_halts_until_restart() {
        let mut rig = Rig::connected();
        rig.flow(false).expect("replied").expect("the flow applied");

        rig.call("boom");
        rig.call("boom");
        assert!(!rig.actor.halted, "two panics in the window still respawn");
        rig.call("boom");

        let recovered: Vec<_> = rig.events.crashes().iter().map(|c| c["recovered"].clone()).collect();
        assert_eq!(recovered, vec![true, true, false]);
        assert!(rig.actor.halted, "the third panic in the window halts");
        let starts = rig.starts.get();
        assert_eq!(starts, 3, "halting does not re-apply the flow");
        let written = rig.take_written();
        let safe = safe_state_for(&analog_pins_json());
        assert!(written.ends_with(&safe), "a halt leaves the board in its safe state: {written:02X?}");

        // Observable: a reloaded webview asks, and learns which crash halted it.
        let status = rig.status();
        assert!(status.halted);
        let crash = status.crash.expect("the halting crash");
        assert!(!crash.recovered);
        assert_eq!(crash.crashes, 3);

        // Halted: flow turns are dropped, and a flow update is kept for the
        // restart but answered as what it is — not running.
        rig.call("boom");
        assert_eq!(rig.events.crashes().len(), 3, "nothing ran, nothing panicked");
        assert_eq!(rig.flow(false), Ok(Err(HALTED.to_string())), "a halted actor does not ack a flow");
        assert_eq!(rig.starts.get(), starts);
        assert!(rig.take_written().is_empty(), "a halted runtime drives nothing");

        // The user restarts: fresh runtime, seeded, flow re-applied.
        assert!(rig.actor.step(ActorMsg::Restart));
        assert!(!rig.actor.halted);
        assert_eq!(rig.status(), RuntimeStatus { halted: false, crash: None });
        assert_eq!(rig.starts.get(), starts + 1);
        assert!(contains(&rig.take_written(), &REPORT_A0));
        rig.call("boom");
        assert_eq!(rig.events.crashes().last().unwrap()["recovered"], true, "the restart reset the guard");
    }

    #[test]
    fn a_panic_lowers_what_the_flow_drove_on_the_sim_board() {
        use microflow_core::firmata::sim::{BoardLayout, SimBoard};
        let mut rig = Rig::connected();
        let (reply, _rx) = oneshot::channel();
        let flow = FlowUpdate {
            nodes: vec![
                node("p", "Panicker", serde_json::json!({})),
                node("led", "Led", serde_json::json!({ "instance": "Led", "pin": 13 })),
            ],
            edges: vec![],
        };
        assert!(rig.actor.step(ActorMsg::FlowUpdate { flow, reply }));
        rig.actor.step(ActorMsg::Call { id: "led".into(), method: "true".into(), value: ComponentValue::Bool(true) });

        let mut board = SimBoard::new(BoardLayout::uno());
        board.receive(&rig.take_written());
        assert!(board.pin(13).is_high(), "the flow drove the LED");

        rig.call("boom");
        // The safe state goes out before anything the respawned runtime writes,
        // and on its own it lowers the LED. (The re-applied flow's init writes
        // the LED pin LOW too, so the whole stream would not prove this.)
        let written = rig.take_written();
        let safe = safe_state_for(&analog_pins_json());
        assert!(written.starts_with(&safe), "the safe state goes out first: {written:02X?}");
        board.receive(&safe);
        assert!(!board.pin(13).is_high(), "the safe state left the LED off");
        board.receive(&written[safe.len()..]);
        assert!(!board.pin(13).is_high(), "and the respawned flow does not drive it again");
    }

    #[test]
    fn app_exit_waits_for_the_actor_to_leave_the_board_safe() {
        // The exit handler sends `Shutdown`, then waits on `ActorStopped`:
        // by the time the wait returns, the session has dropped and written the
        // safe state — so an LED the flow left on is off on the sim board.
        use microflow_core::firmata::sim::{BoardLayout, SimBoard};
        let written = Arc::new(Mutex::new(Vec::new()));
        let port = Arc::clone(&written);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let stopped = spawn_actor(rx, move || {
            let mut rig = Rig::connected_to(port);
            let (reply, _rx) = oneshot::channel();
            let flow = FlowUpdate {
                nodes: vec![node("led", "Led", serde_json::json!({ "instance": "Led", "pin": 13 }))],
                edges: vec![],
            };
            rig.actor.step(ActorMsg::FlowUpdate { flow, reply });
            rig.actor.step(ActorMsg::Call { id: "led".into(), method: "true".into(), value: ComponentValue::Bool(true) });
            rig.actor
        });

        tx.send(ActorMsg::Shutdown).unwrap();
        assert!(stopped.wait(SHUTDOWN_GRACE), "the actor stopped within the grace period");

        let written = written.lock().unwrap().clone();
        assert!(written.ends_with(&safe_state_for(&analog_pins_json())), "{written:02X?}");
        let mut board = SimBoard::new(BoardLayout::uno());
        board.receive(&written);
        assert!(!board.pin(13).is_high(), "the LED the flow drove is off after exit");
    }

    #[test]
    fn a_respawn_reconciles_subscriptions_the_panicked_update_never_reached() {
        let mut rig = Rig::connected();
        rig.flow(false).expect("replied").expect("the flow applied");
        assert_eq!(rig.subscriptions(), Vec::<String>::new(), "no subscriber yet");

        // The update adds an MQTT subscriber and panics part-way: the runtime
        // it was building is thrown away before its wirings reach the
        // `CloudPerformer`.
        let nodes = vec![
            node("p", "Panicker", serde_json::json!({ "panicOnce": true })),
            node("m", "Mqtt", serde_json::json!({ "direction": "subscribe", "brokerId": "b", "topic": "t" })),
        ];
        assert!(rig.send_flow(nodes).is_err(), "the panicked update dropped its reply");

        // The respawn built the whole flow fine, and its subscriber is
        // subscribed on the broker.
        assert_eq!(rig.events.crashes().len(), 1);
        assert!(!rig.actor.halted);
        assert_eq!(rig.subscriptions(), vec!["t".to_string()]);
    }

    #[test]
    fn a_halt_lets_go_of_the_flows_subscriptions_and_says_studio_left() {
        // Nothing runs the flow while the actor is halted: whoever waits on
        // its topics — the design-tool plugins, told Studio is there — is told
        // it is not, without asking the runtime that panicked for anything.
        let mut rig = Rig::connected();
        let design = node("fig", "Figma", serde_json::json!({ "brokerId": "b", "uniqueId": "u1" }));
        rig.send_flow(vec![node("p", "Panicker", serde_json::json!({})), design]).expect("replied").expect("applied");
        assert!(!rig.subscriptions().is_empty(), "the design node's topics are subscribed");
        let status = |rig: &Rig| {
            let published = rig.brokers.published();
            let last = published.iter().rev().find(|publish| publish.topic == "microflow/u1/app/status");
            last.map(|publish| String::from_utf8_lossy(&publish.payload).to_string())
        };
        assert_eq!(status(&rig).as_deref(), Some("connected"));

        // A respawn runs the flow again: Studio never left.
        rig.call("boom");
        rig.subscriptions();
        assert_eq!(status(&rig).as_deref(), Some("connected"));
        assert!(!rig.brokers.published().iter().any(|publish| publish.payload == b"disconnected"));

        rig.call("boom");
        rig.call("boom");
        assert!(rig.actor.halted);
        assert_eq!(rig.subscriptions(), Vec::<String>::new(), "a halted runtime holds no topic");
        assert_eq!(status(&rig).as_deref(), Some("disconnected"));

        // The restart runs the flow again, and Studio is back.
        assert!(rig.actor.step(ActorMsg::Restart));
        assert!(!rig.subscriptions().is_empty());
        assert_eq!(status(&rig).as_deref(), Some("connected"));
    }

    #[test]
    fn a_flow_update_resolves_with_its_subscriptions_in_place() {
        // The whole path `flow_update` takes: the command's `apply_flow`, the
        // actor on its own thread, the `CloudPerformer`'s task on the Tokio
        // runtime — and a recording broker pool at the end of it, where every
        // subscribe takes a round trip.
        let tokio = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_time().build().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (cloud, brokers) = CloudPerformer::on_recording_pool(tx.clone(), tokio.handle().clone());
        let (handle, self_tx) = (tokio.handle().clone(), tx.clone());
        let stopped = spawn_actor(rx, move || {
            let (ended_tx, _ended_rx) = std::sync::mpsc::channel();
            Actor::new(RecordingEvents::default(), handle, cloud, self_tx, ended_tx, Box::new(FlowRuntime::new))
        });

        let subscriber =
            node("m", "Mqtt", serde_json::json!({ "direction": "subscribe", "brokerId": "b", "topic": "t" }));
        let flow = FlowUpdate { nodes: vec![subscriber], edges: vec![] };

        // The broker sits on the subscribe. The actor has applied the flow
        // and replied by the time the subscribe is on the wire — and the
        // update is still not through, however long it is given.
        brokers.hold_subscribes();
        let actor = tx.clone();
        let mut update =
            tokio.spawn(async move { crate::runtime::commands::apply_flow(&actor, flow).await });
        let resolved_early = tokio.block_on(async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            while brokers.subscribes_held() == 0 {
                assert!(tokio::time::Instant::now() < deadline, "the subscribe never reached the broker");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            tokio::time::timeout(Duration::from_millis(200), &mut update).await.is_ok()
        });
        assert!(!resolved_early, "the update resolved while its subscribe was still on the wire");

        // Released, it resolves — with the subscription in place, nothing
        // more to wait for.
        brokers.release_subscribes();
        tokio.block_on(update).expect("the update ran").expect("the flow applied");
        assert_eq!(brokers.subscriptions("b"), vec!["t".to_string()]);

        tx.send(ActorMsg::Shutdown).unwrap();
        assert!(stopped.wait(SHUTDOWN_GRACE), "the actor stopped within the grace period");
    }

    #[test]
    fn a_flow_that_panics_on_apply_halts_instead_of_looping() {
        // The respawn re-applies the very flow that panicked: each re-apply is
        // one more crash, so the guard ends it rather than spinning forever.
        let mut rig = Rig::connected();
        assert!(rig.flow(true).is_err(), "the panicked turn dropped its reply");

        let crashes = rig.events.crashes();
        let ops: Vec<&str> = crashes.iter().map(|c| c["op"].as_str().unwrap()).collect();
        assert_eq!(ops, vec!["flowUpdate", "respawn", "respawn"]);
        assert_eq!(crashes.last().unwrap()["recovered"], false);
        assert!(rig.actor.halted);
    }

    #[test]
    fn a_timer_from_a_thrown_away_runtime_does_not_wake_the_new_one() {
        let mut rig = Rig::connected();
        rig.flow(false).expect("replied").expect("the flow applied");
        let wake = |epoch| ActorMsg::Wake { id: 1, epoch, node_id: "p".into(), method: "_boom".into() };

        rig.actor.step(wake(rig.actor.epoch - 1));
        assert!(rig.events.crashes().is_empty(), "a stale wakeup is dropped");

        rig.actor.step(wake(rig.actor.epoch));
        assert_eq!(rig.events.crashes().len(), 1, "a current one is delivered");
    }

    // --- Host input: the actor hands it over, core picks the nodes ----------

    #[test]
    fn a_key_is_one_turn_however_many_nodes_listen_on_it() {
        let mut rig = Rig::connected();
        let hotkey = |id: &str| node(id, "Hotkey", serde_json::json!({ "accelerator": "x" }));
        rig.send_flow(vec![hotkey("hk-b"), hotkey("hk-a")]).expect("replied").expect("the flow applied");
        let before = rig.events.named("component-events").len();

        assert!(rig.actor.step(ActorMsg::Key { accelerator: "X".into(), pressed: true }));

        let batches = rig.events.named("component-events");
        assert_eq!(batches.len(), before + 1, "the whole key is one IPC batch");
        let sources: Vec<&str> = batches[before]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["source"].as_str().unwrap())
            .collect();
        assert_eq!(sources, ["hk-a", "hk-a", "hk-a", "hk-b", "hk-b", "hk-b"]);
    }

    #[test]
    fn a_midi_message_is_one_turn_however_many_nodes_listen_to_its_port() {
        let mut rig = Rig::connected();
        let midi_in = |id: &str, device: &str| {
            node(id, "Midi", serde_json::json!({ "direction": "in", "deviceName": device }))
        };
        // Applied to the runtime directly, not as an `ActorMsg::FlowUpdate`:
        // that reconciles the `MidiManager`, which would probe this machine's
        // MIDI devices. The message handler under test needs only the runtime.
        rig.actor.rt.update_flow(FlowUpdate {
            nodes: vec![midi_in("m-pad", "launchpad"), midi_in("m-all", ""), midi_in("m-keys", "keystation")],
            edges: vec![],
        });
        let before = rig.events.named("component-events").len();

        let message = ActorMsg::MidiMessage { port_name: "Launchpad Mini".into(), bytes: vec![0x90, 60, 100] };
        assert!(rig.actor.step(message));

        let batches = rig.events.named("component-events");
        assert_eq!(batches.len(), before + 1, "the whole message is one IPC batch");
        let sources: Vec<&str> = batches[before]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["source"].as_str().unwrap())
            .collect();
        assert_eq!(sources, ["m-all", "m-all", "m-all", "m-pad", "m-pad", "m-pad"]);

        // A port no node listens to is a turn with nothing to send.
        rig.actor.rt.update_flow(FlowUpdate { nodes: vec![midi_in("m-keys", "keystation")], edges: vec![] });
        let message = ActorMsg::MidiMessage { port_name: "Launchpad Mini".into(), bytes: vec![0x90, 60, 100] };
        assert!(rig.actor.step(message));
        assert_eq!(rig.events.named("component-events").len(), before + 1);
    }
}
