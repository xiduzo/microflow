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
//! [`Effects`]: microflow_core::runtime::Effects

use crate::hardware::SessionId;
use crate::runtime::services::MqttPublisher;
use microflow_core::flow::FlowUpdate;
use microflow_core::runtime::subscriptions::MidiListener;
use microflow_core::runtime::{
    CloudRequest, CloudRequestKind, ComponentEvent, ComponentValue, Effects,
    EffectsSink, FlowRuntime, NodeDiagnostic, SubscriberWiring, Wakeup, WakeupId,
};
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
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
    /// `id` lets the actor drop the fired timer from its table.
    Wake {
        id: WakeupId,
        node_id: String,
        method: String,
    },
    /// Tear the actor down (app exit).
    Shutdown,
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
    std::thread::Builder::new()
        .name("microflow-runtime".into())
        .spawn(move || {
            let actor = Actor::new(app, rt_handle, mqtt_publisher, self_tx, session_ended);
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
///
/// Dropping a healthy session writes the board's **safe state** first
/// ([`microflow_core::firmata::encode_safe_state`], the encoder the browser
/// link uses too), so nothing the flow drove stays driven. Drop is the one
/// place every end passes through: a deliberate disconnect (`ActorMsg::Disconnect`),
/// app exit (`Shutdown` drops the actor), a replacing `Connect`, and an engine
/// fault — a panic on the actor thread unwinds through the actor and drops its
/// session. A session that ended on an I/O failure skips it: the link that
/// failed cannot carry the reset.
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

/// Owns the `!Send` `FlowRuntime` + the serial port; lives entirely on one thread.
struct Actor {
    rt: FlowRuntime,
    /// The board connection while one is live; `None` otherwise.
    session: Option<BoardSession>,
    /// Last flow, re-applied on (re)connect for clean board init.
    last_flow: Option<FlowUpdate>,
    app: AppHandle,
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

impl Actor {
    fn new(
        app: AppHandle,
        rt_handle: Handle,
        mqtt_publisher: Arc<dyn MqttPublisher>,
        self_tx: UnboundedSender<ActorMsg>,
        session_ended: Sender<SessionId>,
    ) -> Self {
        let cloud = CloudPerformer::new(mqtt_publisher, rt_handle.clone());
        // Cloud nodes are sans-IO and auto-registered by core (the `cloud`
        // feature); the actor only supplies the `CloudPerformer` that performs
        // their recorded requests.
        Self {
            rt: FlowRuntime::new(),
            session: None,
            last_flow: None,
            app,
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
                        if !self.handle(msg) {
                            return;
                        }
                        if self.session.is_some() {
                            self.pump_port();
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }

            // Idle: keep reading while connected; block for the next message when
            // disconnected (no busy spin).
            if self.session.is_some() {
                self.pump_port();
            } else {
                match rx.blocking_recv() {
                    Some(msg) => {
                        if !self.handle(msg) {
                            return;
                        }
                    }
                    None => return,
                }
            }
        }
    }

    /// Process one message. Returns `false` on shutdown.
    fn handle(&mut self, msg: ActorMsg) -> bool {
        match msg {
            ActorMsg::Connect { port, pins_json, session } => {
                // Abort timers from the previous runtime instance — the rebuild
                // below mints fresh wakeup ids, so stale timers would double-fire
                // (e.g. an interval ticking twice as fast after a replug).
                for (_, handle) in self.timers.drain() {
                    handle.abort();
                }
                // Fresh runtime → clean pin-mode/reporting init on the new board.
                self.rt = FlowRuntime::new();
                if let Err(e) = self.rt.seed_pins(&pins_json) {
                    log::warn!("[actor] seed_pins failed: {e}");
                }
                // Diagnostic (Bug B): the seeded table decides which pins the
                // runtime will accept analog reporting for (a pin needs
                // `analogChannel >= 0`). Logging the raw JSON distinguishes
                // "analog mapping never parsed" (no pin analog) from "A0 is not
                // pin 14 on this board" (some other pin carries the analog flag).
                log::info!("[actor] seeded pins_json: {pins_json}");
                let mut port = port;
                let _ = port.set_timeout(Duration::from_millis(READ_TIMEOUT_MS));
                // Replacing a live session drops it, which writes its safe state.
                self.session = Some(
                    BoardSession::new(session, Box::new(port), self.session_ended.clone())
                        .with_safe_state(safe_state_for(&pins_json)),
                );
                log::info!("[actor] board connected (session {session})");

                if let Some(flow) = self.last_flow.clone() {
                    self.set_now();
                    let effects = self.rt.update_flow(flow);
                    self.apply(effects);
                }
            }
            ActorMsg::Disconnect => {
                // Dropping the session writes the safe state (see `BoardSession`).
                self.session = None;
                log::info!("[actor] board disconnected");
            }
            ActorMsg::FlowUpdate { flow, reply } => {
                self.last_flow = Some(flow.clone());
                self.set_now();
                let effects = self.rt.update_flow(flow);
                self.apply(effects);
                let _ = reply.send(self.rt.collect_subscriber_wirings());
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
            ActorMsg::Wake { id, node_id, method } => {
                self.timers.remove(&id);
                self.set_now();
                let effects = self.rt.wake(&node_id, &method);
                self.apply(effects);
            }
            ActorMsg::Shutdown => return false,
        }
        true
    }

    /// Read available serial bytes into the codec and apply the resulting turn.
    fn pump_port(&mut self) {
        let mut buf = [0u8; 256];
        let Some(session) = self.session.as_mut() else { return };
        match session.read(&mut buf) {
            Ok(0) => {}
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
impl EffectsSink for Actor {
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
        let node_id = wakeup.node_id.clone();
        let method = wakeup.method.clone();
        let delay_ms = wakeup.delay_ms;
        let join = self.rt_handle.spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let _ = tx.send(ActorMsg::Wake { id, node_id, method });
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
        // node's `src` (see `use-audio-requests.ts`).
        if matches!(request.kind, CloudRequestKind::AudioPlay { .. } | CloudRequestKind::AudioStop) {
            let _ = self.app.emit("audio-request", request);
            return;
        }
        // LLM generation runs in the webview too, for the same reason and with
        // more to gain (ADR-0021): one TanStack AI transport serves both hosts,
        // so streaming, tool calls and provider quirks are implemented once
        // instead of twice-and-parity-tested. The webview resolves the provider
        // from its own store and injects the result back through the
        // `llm_result` command (see `use-llm-requests.ts`).
        //
        // Reaching a laptop-local endpoint from the webview would normally die
        // on CORS; the frontend performs it over `@tauri-apps/plugin-http`,
        // which requests from Rust exactly as this host used to.
        if matches!(request.kind, CloudRequestKind::LlmGenerate { .. }) {
            let _ = self.app.emit("llm-request", request);
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
        let _ = self.app.emit("component-events", events);
    }

    fn report_diagnostic(&mut self, diagnostic: &NodeDiagnostic) {
        let _ = self.app.emit("node-diagnostic", diagnostic);
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
}
