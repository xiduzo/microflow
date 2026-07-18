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
//! applies: write `outbound_bytes` to the port, `emit("component-event", …)` per
//! event, arm Tokio timers for `wakeups` (firing `ActorMsg::Wake`), abort them on
//! `cancellations`. On `Connect` the runtime is rebuilt fresh and the last flow
//! re-applied, so a (re)connected board gets clean pin-mode/reporting init — the
//! same model the browser reactor uses (a fresh runtime per connection).
//!
//! [`Effects`]: microflow_core::runtime::Effects

use crate::runtime::services::{LlmError, LlmRegistry, LlmRequest, MqttPublisher};
use microflow_core::runtime::cloud;
use microflow_core::flow::FlowUpdate;
use microflow_core::runtime::{
    CloudRequest, CloudRequestKind, ComponentBase, ComponentEvent, ComponentValue, Effects,
    EffectsSink, FlowRuntime, SubscriberWiring, Wakeup, WakeupId,
};
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// shape) and take ownership of the open port for raw read/write.
    Connect {
        port: Box<dyn serialport::SerialPort>,
        pins_json: String,
    },
    /// The board disconnected: drop the port, keep the flow state.
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
/// sender can live on `AppState` + the hardware `BoardLink`) and the `connected`
/// flag the hardware monitor reads (the actor clears it on a serial read error,
/// driving implicit-disconnect detection). The `!Send` `FlowRuntime` is built
/// inside the thread, so nothing unsendable crosses the spawn boundary.
pub fn run_actor(
    rx: UnboundedReceiver<ActorMsg>,
    self_tx: UnboundedSender<ActorMsg>,
    connected: Arc<AtomicBool>,
    app: AppHandle,
    rt_handle: Handle,
    mqtt_publisher: Arc<dyn MqttPublisher>,
    llm_registry: Arc<LlmRegistry>,
) {
    std::thread::Builder::new()
        .name("microflow-runtime".into())
        .spawn(move || {
            let actor = Actor::new(app, rt_handle, mqtt_publisher, llm_registry, self_tx, connected);
            actor.run(rx);
            log::info!("[actor] runtime thread stopped");
        })
        .expect("spawn microflow-runtime thread");
}

/// The hardware monitor + detection's seam to the runtime actor, replacing the
/// old `Arc<BoardHandle>`. `connect_board` / `disconnect` send `ActorMsg`s; the
/// `connected` flag is shared with the actor (which also clears it on a serial
/// error) so the monitor's implicit-disconnect detection still fires.
#[derive(Clone)]
pub struct BoardLink {
    actor: UnboundedSender<ActorMsg>,
    connected: Arc<AtomicBool>,
}

impl BoardLink {
    #[must_use]
    pub fn new(actor: UnboundedSender<ActorMsg>, connected: Arc<AtomicBool>) -> Self {
        Self { actor, connected }
    }

    /// Hand the freshly-detected board (open port + `pins_json`) to the actor.
    pub fn connect_board(&self, port: Box<dyn serialport::SerialPort>, pins_json: String) {
        self.connected.store(true, Ordering::Release);
        let _ = self.actor.send(ActorMsg::Connect { port, pins_json });
    }

    /// Tell the actor the board went away.
    pub fn disconnect(&self) {
        self.connected.store(false, Ordering::Release);
        let _ = self.actor.send(ActorMsg::Disconnect);
    }

    #[must_use]
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }
}

/// Owns the `!Send` `FlowRuntime` + the serial port; lives entirely on one thread.
struct Actor {
    rt: FlowRuntime,
    /// Open serial port while a board is connected; `None` otherwise.
    port: Option<Box<dyn serialport::SerialPort>>,
    /// Last flow, re-applied on (re)connect for clean board init.
    last_flow: Option<FlowUpdate>,
    app: AppHandle,
    rt_handle: Handle,
    self_tx: UnboundedSender<ActorMsg>,
    connected: Arc<AtomicBool>,
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
}

impl Actor {
    fn new(
        app: AppHandle,
        rt_handle: Handle,
        mqtt_publisher: Arc<dyn MqttPublisher>,
        llm_registry: Arc<LlmRegistry>,
        self_tx: UnboundedSender<ActorMsg>,
        connected: Arc<AtomicBool>,
    ) -> Self {
        let cloud = CloudPerformer::new(
            mqtt_publisher,
            llm_registry,
            rt_handle.clone(),
            self_tx.clone(),
        );
        // Cloud nodes are sans-IO and auto-registered by core (the `cloud`
        // feature); the actor only supplies the `CloudPerformer` that performs
        // their recorded requests.
        Self {
            rt: FlowRuntime::new(),
            port: None,
            last_flow: None,
            app,
            rt_handle,
            self_tx,
            connected,
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
            // Drain every queued message first.
            loop {
                match rx.try_recv() {
                    Ok(msg) => {
                        if !self.handle(msg) {
                            return;
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }

            // Connected: interleave a short serial read with message draining.
            // Disconnected: block until the next message (no busy spin).
            if self.port.is_some() {
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
            ActorMsg::Connect { port, pins_json } => {
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
                self.port = Some(port);
                self.connected.store(true, Ordering::Release);
                log::info!("[actor] board connected");

                if let Some(flow) = self.last_flow.clone() {
                    self.set_now();
                    let effects = self.rt.update_flow(flow);
                    self.apply(effects);
                }
            }
            ActorMsg::Disconnect => {
                self.port = None;
                self.connected.store(false, Ordering::Release);
                log::info!("[actor] board disconnected");
            }
            ActorMsg::FlowUpdate { flow, reply } => {
                self.last_flow = Some(flow.clone());
                self.set_now();
                let effects = self.rt.update_flow(flow);
                self.apply(effects);
                let _ = reply.send(self.rt.collect_subscriber_wirings());
                let listeners = self.rt.collect_midi_listeners();
                self.midi.reconcile(&listeners, &self.self_tx);
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
                // Fan out against the runtime's own listener list (always fresh)
                // — every matching in-node receives the raw message; parsing
                // lives in core's `Midi::receive_raw_message`.
                self.set_now();
                let listeners = self.rt.collect_midi_listeners();
                for listener in listeners {
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
        let result = match self.port.as_mut() {
            Some(port) => port.read(&mut buf),
            None => return,
        };
        match result {
            Ok(n) if n > 0 => {
                self.set_now();
                let effects = self.rt.feed_bytes(&buf[..n]);
                self.apply(effects);
            }
            Ok(_) => {}
            Err(e) if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {}
            Err(e) => {
                log::warn!("[actor] serial read error: {e}; dropping board");
                self.port = None;
                self.connected.store(false, Ordering::Release);
            }
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
        if let Some(port) = self.port.as_mut() {
            if let Err(e) = port.write_all(bytes).and_then(|()| port.flush()) {
                log::warn!("[actor] serial write error: {e}; dropping board");
                self.port = None;
                self.connected.store(false, Ordering::Release);
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
        self.cloud.perform(request);
    }

    fn dispatch_event(&mut self, event: &ComponentEvent) {
        let _ = self.app.emit("component-event", event);
    }
}

/// Performs cloud `Effects` for the desktop host (ADR-0009): the network I/O that
/// used to be spawned *inside* the cloud components, relocated behind one small
/// `perform(&CloudRequest)` interface. Holds the live MQTT/LLM services, the
/// Tokio handle to spawn on, the channel LLM results re-enter through
/// (`ActorMsg::Inject` → `FlowRuntime::inject_event`), and the per-node in-flight
/// LLM task table (latest-wins cancellation). Unlike the `Actor` it lives on, it
/// needs no Tauri `AppHandle`, so it is unit-testable directly.
struct CloudPerformer {
    mqtt_publisher: Arc<dyn MqttPublisher>,
    llm_registry: Arc<LlmRegistry>,
    rt_handle: Handle,
    /// Where LLM results re-enter the runtime (`ActorMsg::Inject`).
    tx: UnboundedSender<ActorMsg>,
    /// In-flight LLM generation tasks keyed by issuing node id, so a fresh
    /// `LlmGenerate` for the same node cancels its predecessor. A late result
    /// from an aborted/removed node is harmless — its edges are gone, so
    /// `inject_event` routes nowhere.
    llm_tasks: HashMap<Arc<str>, tokio::task::AbortHandle>,
}

impl CloudPerformer {
    fn new(
        mqtt_publisher: Arc<dyn MqttPublisher>,
        llm_registry: Arc<LlmRegistry>,
        rt_handle: Handle,
        tx: UnboundedSender<ActorMsg>,
    ) -> Self {
        Self { mqtt_publisher, llm_registry, rt_handle, tx, llm_tasks: HashMap::new() }
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
            CloudRequestKind::LlmGenerate { provider_id, model, system, prompt } => {
                // Latest-wins: a new generation for this node cancels the prior
                // in-flight one (the abort the node used to hold itself).
                if let Some(prev) = self.llm_tasks.remove(&request.source) {
                    prev.abort();
                }
                let registry = Arc::clone(&self.llm_registry);
                let tx = self.tx.clone();
                let source = Arc::clone(&request.source);
                let provider_id = provider_id.clone();
                let req = LlmRequest {
                    model: model.clone(),
                    system: system.clone(),
                    prompt: prompt.clone(),
                };
                let join = self.rt_handle.spawn(async move {
                    // Result handles are sourced from `Llm`'s own consts so the
                    // host injects on exactly the handles the node declares in
                    // `emits()`. `thinking=true` is emitted synchronously by the
                    // node's dispatch; only the resolution re-enters here.
                    let send = |handle: &str, value: ComponentValue| {
                        let _ = tx.send(ActorMsg::Inject {
                            source: Arc::clone(&source),
                            handle: handle.to_string(),
                            value,
                        });
                    };
                    let Some(provider) = registry.get(&provider_id).await else {
                        send(cloud::llm::Llm::E_THINKING, ComponentValue::Bool(false));
                        send(
                            cloud::llm::Llm::E_ERROR,
                            ComponentValue::String(format!(
                                "LLM provider '{provider_id}' not configured"
                            )),
                        );
                        return;
                    };
                    match provider.generate(req).await {
                        Ok(response) => {
                            send(cloud::llm::Llm::E_THINKING, ComponentValue::Bool(false));
                            send(ComponentBase::VALUE_HANDLE, ComponentValue::String(response.text));
                            send(cloud::llm::Llm::E_DONE, ComponentValue::Bool(true));
                        }
                        Err(LlmError::Cancelled) => {}
                        Err(e) => {
                            send(cloud::llm::Llm::E_THINKING, ComponentValue::Bool(false));
                            send(cloud::llm::Llm::E_ERROR, ComponentValue::String(e.to_string()));
                        }
                    }
                });
                self.llm_tasks.insert(Arc::clone(&request.source), join.abort_handle());
            }
            // Intercepted by `Actor::perform_cloud` (the actor owns the `midir`
            // connections); a request reaching here has no performer.
            CloudRequestKind::MidiSend { .. } => {
                log::warn!("[cloud] MidiSend reached the CloudPerformer — handled by the actor");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::services::{
        LlmProvider, RecordedPublish, RecordingLlmProvider, RecordingMqttPublisher,
    };
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

    /// Poll the actor channel for the first `Inject` on `handle` (the path an LLM
    /// result re-enters by), or `None` on timeout.
    async fn wait_for_inject(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<ActorMsg>,
        handle: &str,
        timeout: Duration,
    ) -> Option<ComponentValue> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match rx.try_recv() {
                Ok(ActorMsg::Inject { handle: h, value, .. }) if h == handle => return Some(value),
                Ok(_) => {}
                Err(_) => {
                    if tokio::time::Instant::now() >= deadline {
                        return None;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        }
    }

    #[tokio::test]
    async fn perform_cloud_mqtt_publish_reaches_publisher() {
        // The relocated IO regression net: a `MqttPublish` request drives the
        // live publisher (the body that used to live in the Mqtt component).
        let publisher = Arc::new(RecordingMqttPublisher::new());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let mut performer = CloudPerformer::new(
            publisher.clone() as Arc<dyn MqttPublisher>,
            Arc::new(LlmRegistry::new()),
            tokio::runtime::Handle::current(),
            tx,
        );

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
    async fn perform_cloud_llm_generate_injects_result() {
        // The relocated LLM IO: a `LlmGenerate` request resolves the provider and
        // feeds the response back via `ActorMsg::Inject` on the `value` handle.
        let registry = Arc::new(LlmRegistry::new());
        let recorder = Arc::new(RecordingLlmProvider::new());
        recorder.script_ok("hi back");
        registry
            .insert("p".into(), recorder.clone() as Arc<dyn LlmProvider>)
            .await;

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut performer = CloudPerformer::new(
            Arc::new(RecordingMqttPublisher::new()) as Arc<dyn MqttPublisher>,
            Arc::clone(&registry),
            tokio::runtime::Handle::current(),
            tx,
        );

        performer.perform(&req(
            "llm",
            CloudRequestKind::LlmGenerate {
                provider_id: "p".into(),
                model: "test-model".into(),
                system: None,
                prompt: "hello".into(),
            },
        ));

        let value = wait_for_inject(&mut rx, "value", Duration::from_secs(2)).await;
        assert_eq!(value, Some(ComponentValue::String("hi back".into())));

        let calls = recorder.recorded();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].model, "test-model");
        assert_eq!(calls[0].prompt, "hello");
    }

    #[tokio::test]
    async fn perform_cloud_llm_missing_provider_injects_error() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut performer = CloudPerformer::new(
            Arc::new(RecordingMqttPublisher::new()) as Arc<dyn MqttPublisher>,
            Arc::new(LlmRegistry::new()), // empty registry
            tokio::runtime::Handle::current(),
            tx,
        );

        performer.perform(&req(
            "llm",
            CloudRequestKind::LlmGenerate {
                provider_id: "missing".into(),
                model: "m".into(),
                system: None,
                prompt: "hi".into(),
            },
        ));

        match wait_for_inject(&mut rx, "error", Duration::from_secs(2)).await {
            Some(ComponentValue::String(msg)) => assert!(msg.contains("missing")),
            other => panic!("expected error string, got {other:?}"),
        }
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
            other @ (CloudRequestKind::LlmGenerate { .. } | CloudRequestKind::MidiSend { .. }) => {
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
