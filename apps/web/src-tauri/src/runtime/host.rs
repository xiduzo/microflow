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
use crate::runtime::services::MqttPublisher;
use crate::runtime::supervisor::{self, CrashGuard, Fault, Verdict};
use microflow_core::flow::FlowUpdate;
use microflow_core::runtime::subscriptions::MidiListener;
use microflow_core::runtime::{
    CloudRequest, CloudRequestKind, ComponentEvent, ComponentValue, Effects,
    EffectsSink, FlowRuntime, NodeDiagnostic, SubscriberWiring, Wakeup, WakeupId,
};
use serde::Serialize;
use std::any::Any;
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
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
    /// A flow update (`flow_update` command). Replies with the active subscriber
    /// wirings so the command can (un)subscribe MQTT.
    FlowUpdate {
        flow: FlowUpdate,
        reply: oneshot::Sender<Vec<(String, SubscriberWiring)>>,
    },
    /// An external component call (`component_call` command).
    Call {
        id: String,
        method: String,
        value: ComponentValue,
    },
    /// A hotkey press/release (`key_event`), matched against registered hotkey
    /// listeners. `pressed` distinguishes key-down (`true`) from key-up (`false`).
    Key { accelerator: String, pressed: bool },
    /// An inbound MQTT / Figma broker payload routed to a subscribe component.
    Deliver {
        id: String,
        topic: String,
        payload: Vec<u8>,
    },
    /// A raw MIDI message from an open `midir` input. The actor fans it out to
    /// every `Midi` in-node whose device filter matches `port_name` (via
    /// `FlowRuntime::deliver_message`, mirroring the browser host).
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

/// Spawn the actor thread. The caller owns the channel (so the `Send + Sync`
/// sender can live on `AppState` + the hardware [`ActorLink`]) and the
/// `session_ended` sender: the actor reports a serial I/O failure on it as a
/// fact, and the hardware board link — the one owner of connection state —
/// decides what it means. The `!Send` `FlowRuntime` is built inside the thread,
/// so nothing unsendable crosses the spawn boundary.
pub fn run_actor(
    rx: UnboundedReceiver<ActorMsg>,
    self_tx: UnboundedSender<ActorMsg>,
    session_ended: Sender<SessionId>,
    app: AppHandle,
    rt_handle: Handle,
    mqtt_publisher: Arc<dyn MqttPublisher>,
) {
    supervisor::install_panic_hook();
    std::thread::Builder::new()
        .name("microflow-runtime".into())
        .spawn(move || {
            let actor = Actor::new(
                app,
                rt_handle,
                mqtt_publisher,
                self_tx,
                session_ended,
                Box::new(FlowRuntime::new),
            );
            actor.run(rx);
            log::info!("[actor] runtime thread stopped");
        })
        .expect("spawn microflow-runtime thread");
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
pub struct BoardSession {
    id: SessionId,
    port: Box<dyn SerialIo>,
    ended: Sender<SessionId>,
}

impl BoardSession {
    #[must_use]
    pub fn new(id: SessionId, port: Box<dyn SerialIo>, ended: Sender<SessionId>) -> Self {
        Self { id, port, ended }
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

    fn end(&self, op: &str, error: &std::io::Error) -> SessionEnded {
        log::warn!("[actor] serial {op} error on session {}: {error}; dropping board", self.id);
        let _ = self.ended.send(self.id);
        SessionEnded
    }
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
    /// The subscriber wirings the last `FlowUpdate` replied with — what the
    /// `flow_update` command's MQTT subscriptions are reconciled against.
    wirings: Vec<(String, SubscriberWiring)>,
    /// The crash-loop guard.
    guard: CrashGuard,
    /// The guard tripped: no runtime drives the board until `Restart`.
    halted: bool,
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
    /// Performs cloud `Effects` (ADR-0009): holds the MQTT/LLM services and the
    /// in-flight LLM task table. `EffectsSink::perform_cloud` delegates here.
    cloud: CloudPerformer,
    /// Open `midir` connections; inputs reconciled per flow update, outputs
    /// opened lazily per `MidiSend`. Thread-confined like the runtime.
    midi: crate::runtime::midi::MidiManager,
    /// The flow's MIDI in-node listeners, cached because inbound MIDI (CC
    /// sweeps, aftertouch) arrives up to ~1kHz and the list only changes when the
    /// flow does. Rebuilt from `FlowRuntime::collect_midi_listeners` in exactly
    /// the one place the flow changes (`ActorMsg::FlowUpdate`), alongside
    /// `MidiManager::reconcile`. `Rc` so a fan-out can hold it while the turn
    /// mutates the actor, without copying the list per message.
    midi_listeners: Rc<[MidiListener]>,
}

impl<E: HostEvents> Actor<E> {
    fn new(
        events: E,
        rt_handle: Handle,
        mqtt_publisher: Arc<dyn MqttPublisher>,
        self_tx: UnboundedSender<ActorMsg>,
        session_ended: Sender<SessionId>,
        make_runtime: RuntimeFactory,
    ) -> Self {
        let cloud = CloudPerformer::new(mqtt_publisher, rt_handle.clone());
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
            wirings: Vec::new(),
            guard: CrashGuard::default(),
            halted: false,
            events,
            rt_handle,
            self_tx,
            session_ended,
            start: Instant::now(),
            timers: HashMap::new(),
            cloud,
            midi: crate::runtime::midi::MidiManager::new(),
            midi_listeners: Rc::from([] as [MidiListener; 0]),
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
            self.events.emit(
                "runtime-crashed",
                fault.event(verdict == Verdict::Respawn, self.guard.recent()),
            );
            // The panicked runtime's state is indeterminate (ADR-0017 D3): it
            // never drives the board again, and neither do its timers.
            self.rebuild_runtime(false);
            self.safe_state();
            if verdict == Verdict::Halt {
                log::error!("[actor] {} panics within the crash window; runtime halted", self.guard.recent());
                self.halted = true;
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
        self.rebuild_runtime(true);
        self.apply_last_flow();
        // Subscriptions. MIDI inputs live on the actor: rebuild the listener
        // cache from the new runtime and reconcile. MQTT subscriptions live on
        // `AppState`, keyed by node id, and are a function of the flow alone —
        // the same flow yields the same wirings, so they stay valid. Say so
        // loudly if that ever stops being true.
        let wirings = self.rt.collect_subscriber_wirings();
        if wirings != self.wirings {
            log::warn!("[actor] respawned runtime wires subscribers differently; MQTT re-reconciles on the next flow_update");
            self.wirings = wirings;
        }
        self.midi_listeners = self.rt.collect_midi_listeners().into();
        self.midi.reconcile(&self.midi_listeners, &self.self_tx);
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

    /// Put the board in a safe state before a new runtime (or none) drives it.
    fn safe_state(&mut self) {
        // TODO(track J): write core's safe-state encoder here —
        // `microflow_core::firmata::encode_safe_state(pin_count)` over the
        // session's pin table, through `self.write_bytes`. Until it lands the
        // respawn's re-applied flow re-inits every pin mode, and a halt leaves
        // outputs as the panicked runtime drove them.
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
        self.session = Some(BoardSession::new(session, port, self.session_ended.clone()));
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
                self.session = None;
                log::info!("[actor] board disconnected");
            }
            ActorMsg::FlowUpdate { flow, reply } if self.halted => {
                // Kept for the restart; the subscriptions stay as they are.
                self.last_flow = Some(flow);
                let _ = reply.send(self.wirings.clone());
            }
            ActorMsg::FlowUpdate { flow, reply } => {
                self.last_flow = Some(flow.clone());
                self.set_now();
                let effects = self.rt.update_flow(flow);
                self.apply(effects);
                self.wirings = self.rt.collect_subscriber_wirings();
                let _ = reply.send(self.wirings.clone());
                // The flow changed: this is the only place the listener cache
                // can go stale, so it is the only place it is rebuilt.
                self.midi_listeners = self.rt.collect_midi_listeners().into();
                self.midi.reconcile(&self.midi_listeners, &self.self_tx);
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
                // Fan out against the cached listener list — every matching
                // in-node receives the raw message; parsing lives in core's
                // `Midi::receive_raw_message`. The `Rc` clone keeps the list
                // readable while the turn mutates the actor.
                self.set_now();
                let listeners = Rc::clone(&self.midi_listeners);
                for listener in listeners.iter() {
                    if crate::runtime::midi::device_matches(&port_name, &listener.device_name) {
                        let effects = self.rt.deliver_message(&listener.node_id, &port_name, &bytes);
                        self.apply(effects);
                    }
                }
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
    /// [`CloudPerformer`], which owns the MQTT/LLM services + the in-flight LLM
    /// task table. The ordering (cloud before UI events) is fixed by
    /// `Effects::apply`; this just supplies the primitive.
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

/// Performs cloud `Effects` for the desktop host (ADR-0009): the network I/O that
/// used to be spawned *inside* the cloud components, relocated behind one small
/// `perform(&CloudRequest)` interface.
///
/// Since ADR-0021 that is MQTT only — LLM generation moved to the webview, where
/// one `TanStack` AI transport serves both hosts. Unlike the `Actor` it lives on,
/// it needs no Tauri `AppHandle`, so it is unit-testable directly.
struct CloudPerformer {
    mqtt_publisher: Arc<dyn MqttPublisher>,
    rt_handle: Handle,
}

impl CloudPerformer {
    fn new(mqtt_publisher: Arc<dyn MqttPublisher>, rt_handle: Handle) -> Self {
        Self { mqtt_publisher, rt_handle }
    }

    /// Perform one cloud request. The `reqwest`/`rumqttc` bodies are the same as
    /// the old in-component spawns; only their home changed.
    fn perform(&mut self, request: &CloudRequest) {
        match &request.kind {
            CloudRequestKind::MqttPublish { broker_id, topic, payload, retain } => {
                let publisher = Arc::clone(&self.mqtt_publisher);
                let source = Arc::clone(&request.source);
                let broker_id = broker_id.clone();
                let topic = topic.clone();
                let payload = payload.clone();
                let retain = *retain;
                self.rt_handle.spawn(async move {
                    if let Err(e) = publisher.publish(&broker_id, &topic, &payload, retain).await {
                        log::error!(
                            "[cloud] {source} mqtt publish failed (broker={broker_id} topic={topic}): {e}"
                        );
                    }
                });
            }
            // Intercepted by `Actor::perform_cloud`: MIDI on the actor's own
            // `midir` connections, audio and LLM forwarded to the webview
            // (ADR-0021). A request reaching here has no performer.
            CloudRequestKind::MidiSend { .. }
            | CloudRequestKind::AudioPlay { .. }
            | CloudRequestKind::AudioStop
            | CloudRequestKind::LlmGenerate { .. } => {
                log::warn!(
                    "[cloud] host-peripheral request reached the CloudPerformer — handled by the actor"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::services::{RecordedPublish, RecordingMqttPublisher};
    use microflow_core::flow::{FlowEdge, FlowNode, Position};
    use std::time::Duration;

    fn node(id: &str, instance: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some(instance.to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn req(source: &str, kind: CloudRequestKind) -> CloudRequest {
        CloudRequest { source: Arc::from(source), kind }
    }

    async fn wait_for_publishes(
        recorder: &RecordingMqttPublisher,
        min: usize,
        timeout: Duration,
    ) -> Vec<RecordedPublish> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let snap = recorder.recorded();
            if snap.len() >= min || tokio::time::Instant::now() >= deadline {
                return snap;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// A port whose reads replay a script and whose writes succeed or fail.
    struct ScriptedPort {
        reads: std::collections::VecDeque<std::io::Result<Vec<u8>>>,
        write_error: Option<ErrorKind>,
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
            match self.write_error {
                Some(kind) => Err(kind.into()),
                None => Ok(buf.len()),
            }
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
        let (mut s, ended) = session(ScriptedPort {
            reads: [Err(ErrorKind::TimedOut.into()), Ok(vec![0xF9, 2, 5])].into(),
            write_error: None,
        });
        let mut buf = [0u8; 8];
        assert_eq!(s.read(&mut buf).unwrap(), 0);
        assert_eq!(s.read(&mut buf).unwrap(), 3);
        assert!(s.write(&[0x90, 0, 0]).is_ok());
        assert!(ended.try_recv().is_err(), "nothing ended");
    }

    #[test]
    fn session_read_error_reports_its_id() {
        let (mut s, ended) = session(ScriptedPort {
            reads: [Err(ErrorKind::BrokenPipe.into())].into(),
            write_error: None,
        });
        assert!(s.read(&mut [0u8; 8]).is_err());
        assert_eq!(ended.try_iter().collect::<Vec<_>>(), vec![7]);
    }

    #[test]
    fn session_write_error_reports_its_id() {
        // A write failure mid-session used to clear a shared flag the monitor
        // only noticed if the port was tagged `has_firmata`; now it is a fact
        // the board link receives by session id.
        let (mut s, ended) = session(ScriptedPort {
            reads: std::collections::VecDeque::new(),
            write_error: Some(ErrorKind::BrokenPipe),
        });
        assert!(s.write(&[0x90, 0, 0]).is_err());
        assert_eq!(ended.try_iter().collect::<Vec<_>>(), vec![7]);
    }

    #[tokio::test]
    async fn perform_cloud_mqtt_publish_reaches_publisher() {
        // The relocated IO regression net: a `MqttPublish` request drives the
        // live publisher (the body that used to live in the Mqtt component).
        let publisher = Arc::new(RecordingMqttPublisher::new());
        let mut performer =
            CloudPerformer::new(publisher.clone() as Arc<dyn MqttPublisher>, tokio::runtime::Handle::current());

        performer.perform(&req(
            "m",
            CloudRequestKind::MqttPublish {
                broker_id: "broker-1".into(),
                topic: "sensors/light".into(),
                payload: b"42".to_vec(),
                retain: true,
            },
        ));

        let sent = wait_for_publishes(&publisher, 1, Duration::from_secs(1)).await;
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].broker_id, "broker-1");
        assert_eq!(sent[0].topic, "sensors/light");
        assert_eq!(sent[0].payload, b"42");
        assert!(sent[0].retain);
    }

    #[tokio::test]
    async fn perform_cloud_ignores_llm_generate() {
        // Since ADR-0021 an `LlmGenerate` is intercepted by `Actor::perform_cloud`
        // and forwarded to the webview, which owns the only LLM transport. If it
        // ever reaches the `CloudPerformer` it must do nothing rather than fall
        // through to a publish — the same contract MidiSend and audio hold.
        let publisher = Arc::new(RecordingMqttPublisher::new());
        let mut performer = CloudPerformer::new(
            publisher.clone() as Arc<dyn MqttPublisher>,
            tokio::runtime::Handle::current(),
        );

        performer.perform(&req(
            "llm",
            CloudRequestKind::LlmGenerate {
                provider_id: "p".into(),
                model: "m".into(),
                system: None,
                prompt: "hi".into(),
            },
        ));

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(publisher.recorded().is_empty(), "LLM must not reach the publisher");
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

    #[test]
    fn midi_flow_reports_listener_sends_and_receives() {
        // End-to-end through the runtime the actor drives: an in-node surfaces
        // as a listener, an out-node's `send` records a MidiSend, and a
        // delivered raw message emits on the in-node's handles.
        let mut rt = FlowRuntime::new();
        rt.update_flow(FlowUpdate {
            nodes: vec![
                node("m-in", "Midi", serde_json::json!({ "direction": "in", "deviceName": "pad" })),
                node(
                    "m-out",
                    "Midi",
                    serde_json::json!({ "direction": "out", "mode": "cc", "control": 7 }),
                ),
            ],
            edges: Vec::<FlowEdge>::new(),
        });

        let listeners = rt.collect_midi_listeners();
        assert_eq!(listeners.len(), 1, "only the in-node listens");
        assert_eq!(listeners[0].node_id, "m-in");
        assert_eq!(listeners[0].device_name, "pad");

        let effects = rt.dispatch("m-out", "send", ComponentValue::Number(64.0));
        assert_eq!(effects.cloud_requests.len(), 1);
        match &effects.cloud_requests[0].kind {
            CloudRequestKind::MidiSend { bytes, .. } => assert_eq!(bytes, &vec![0xB0, 7, 64]),
            other => panic!("expected MidiSend, got {other:?}"),
        }

        // A note-on for the in-node (default note mode) emits its handles.
        let effects = rt.deliver_message("m-in", "Launchpad", &[0x90, 60, 100]);
        let handles: Vec<&str> =
            effects.component_events.iter().map(|e| e.source_handle.as_ref()).collect();
        assert_eq!(handles, vec!["note", "velocity", "on"]);
    }

    // --- Supervision: a panicking turn respawns the runtime -----------------

    use microflow_core::runtime::{Component, ComponentBase, RuntimeContext, RuntimeError};
    use std::cell::{Cell, RefCell};
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
        fn crashes(&self) -> Vec<serde_json::Value> {
            self.0.borrow().iter().filter(|(e, _)| e == "runtime-crashed").map(|(_, p)| p.clone()).collect()
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
    /// strips the `_`), and on start when `data.panicOnStart`. Counts its
    /// starts — one per flow apply.
    struct Panicker {
        base: ComponentBase,
        panic_on_start: bool,
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
            Ok(())
        }
    }

    struct Rig {
        actor: Actor<RecordingEvents>,
        events: RecordingEvents,
        written: Arc<Mutex<Vec<u8>>>,
        starts: Rc<Cell<u32>>,
        _tokio: tokio::runtime::Runtime,
    }

    impl Rig {
        /// An actor whose runtimes know `Panicker`, connected as session 7 to a
        /// 20-pin board whose pins 14–19 are analog (A0 = pin 14).
        fn connected() -> Self {
            supervisor::install_panic_hook();
            let tokio = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
            let starts = Rc::new(Cell::new(0));
            let factory_starts = Rc::clone(&starts);
            let make_runtime: RuntimeFactory = Box::new(move || {
                let mut rt = FlowRuntime::new();
                let starts = Rc::clone(&factory_starts);
                rt.register_test_factory(
                    "Panicker",
                    Box::new(move |id, data| {
                        Ok(Box::new(Panicker {
                            base: ComponentBase::new(id, ComponentValue::default()),
                            panic_on_start: data
                                .get("panicOnStart")
                                .and_then(serde_json::Value::as_bool)
                                .unwrap_or(false),
                            starts: Rc::clone(&starts),
                        }))
                    }),
                );
                rt
            });
            let events = RecordingEvents::default();
            let (self_tx, _self_rx) = tokio::sync::mpsc::unbounded_channel();
            let (ended_tx, _ended_rx) = std::sync::mpsc::channel();
            let mut actor = Actor::new(
                events.clone(),
                tokio.handle().clone(),
                Arc::new(RecordingMqttPublisher::new()),
                self_tx,
                ended_tx,
                make_runtime,
            );
            let written = Arc::new(Mutex::new(Vec::new()));
            actor.connect(Box::new(RecordingPort(Arc::clone(&written))), pins_json(), 7);
            Self { actor, events, written, starts, _tokio: tokio }
        }

        fn flow(
            &mut self,
            panic_on_start: bool,
        ) -> Result<Vec<(String, SubscriberWiring)>, oneshot::error::TryRecvError> {
            let (reply, mut rx) = oneshot::channel();
            let flow = FlowUpdate {
                nodes: vec![node("p", "Panicker", serde_json::json!({ "panicOnStart": panic_on_start })), sensor_a0()],
                edges: vec![],
            };
            assert!(self.actor.step(ActorMsg::FlowUpdate { flow, reply }));
            rx.try_recv()
        }

        fn call(&mut self, method: &str) {
            let msg = ActorMsg::Call { id: "p".into(), method: method.into(), value: ComponentValue::default() };
            assert!(self.actor.step(msg), "a panic never stops the actor");
        }

        fn take_written(&self) -> Vec<u8> {
            std::mem::take(&mut *self.written.lock().unwrap())
        }
    }

    fn sensor_a0() -> FlowNode {
        node(
            "pot",
            "Sensor",
            serde_json::json!({ "instance": "Sensor", "pin": "A0", "type": "analog", "threshold": 1 }),
        )
    }

    fn pins_json() -> String {
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
        rig.flow(false).expect("the flow applied");
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
        assert!(contains(&rig.take_written(), &REPORT_A0), "the pin table was re-seeded");
        assert_eq!(rig.actor.wirings, rig.actor.rt.collect_subscriber_wirings(), "subscriptions unchanged");

        // And it keeps working.
        rig.call("fine");
        assert_eq!(rig.events.crashes().len(), 1);
    }

    #[test]
    fn a_crash_loop_halts_until_restart() {
        let mut rig = Rig::connected();
        rig.flow(false).expect("the flow applied");

        rig.call("boom");
        rig.call("boom");
        assert!(!rig.actor.halted, "two panics in the window still respawn");
        rig.call("boom");

        let recovered: Vec<_> = rig.events.crashes().iter().map(|c| c["recovered"].clone()).collect();
        assert_eq!(recovered, vec![true, true, false]);
        assert!(rig.actor.halted, "the third panic in the window halts");
        let starts = rig.starts.get();
        assert_eq!(starts, 3, "halting does not re-apply the flow");
        rig.take_written();

        // Halted: flow turns are dropped, and a flow update is kept for the
        // restart while the subscriptions stay as they were.
        rig.call("boom");
        assert_eq!(rig.events.crashes().len(), 3, "nothing ran, nothing panicked");
        let wirings = rig.flow(false).expect("a halted actor still replies");
        assert_eq!(wirings, rig.actor.wirings);
        assert_eq!(rig.starts.get(), starts);
        assert!(rig.take_written().is_empty(), "a halted runtime drives nothing");

        // The user restarts: fresh runtime, seeded, flow re-applied.
        assert!(rig.actor.step(ActorMsg::Restart));
        assert!(!rig.actor.halted);
        assert_eq!(rig.starts.get(), starts + 1);
        assert!(contains(&rig.take_written(), &REPORT_A0));
        rig.call("boom");
        assert_eq!(rig.events.crashes().last().unwrap()["recovered"], true, "the restart reset the guard");
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
        rig.flow(false).expect("the flow applied");
        let wake = |epoch| ActorMsg::Wake { id: 1, epoch, node_id: "p".into(), method: "_boom".into() };

        rig.actor.step(wake(rig.actor.epoch - 1));
        assert!(rig.events.crashes().is_empty(), "a stale wakeup is dropped");

        rig.actor.step(wake(rig.actor.epoch));
        assert_eq!(rig.events.crashes().len(), 1, "a current one is delivered");
    }
}
