//! The live flow runtime — a synchronous, sans-IO node-graph interpreter shared
//! by the desktop app and (via `microflow-runtime-wasm`) the browser.
//!
//! One inbound stimulus (`feed_bytes`, `update_flow`, `wake`, `dispatch`) drives
//! the executor: it gate-checks staleness, branches hardware/internal callbacks,
//! echoes `set_value` on the source, routes via [`FlowRouter`], and dispatches.
//! Components emit into a shared [`EventSink`] queue that the runtime drains to
//! completion synchronously (replacing the desktop's channel + pump thread).
//! Every turn returns one [`Effects`]: Firmata bytes to write, UI events, and
//! timer wakeups/cancellations for the host to apply. No threads, no serial
//! port, no clock live here — those belong to the host.
//!
//! Stage 2 wires the executor, the emit drain, and the inbound decode. Component
//! nodes and the full incremental `update_flow` diff land in Stage 3.

pub mod board;
pub mod component;
pub mod context;
pub mod error;
mod health;
mod pin_check;
pub mod pin_mode;
pub mod reconcile;
pub mod registry;
pub mod router;
mod session;
pub mod subscriptions;
pub mod turn_budget;
pub mod value;
pub mod wiring;

// The component nodes themselves live in `crate::nodes::<node>::runtime`
// (ADR-0026). `cloud` holds the test support shared by the cloud nodes, behind
// the same gate as their runtimes — they are sans-IO (they emit `CloudRequest`s
// the host performs), so the gate keeps them out of codegen-only consumers, not
// out of any host: both the desktop bin and the browser wasm build enable
// `cloud` (ADR-0009).
#[cfg(feature = "cloud")]
pub mod cloud;

// Pin string-or-number serde helpers moved to the ungated `config::serde_utils`
// (so shared configs can use them without the `runtime` feature); re-exported
// here so existing `crate::runtime::serde_utils` references keep resolving.
pub use crate::config::serde_utils;
pub use board::{analog_write_like_arduino, BoardWriter, BufferBoardWriter, I2cBus, ANALOG_WRITE_ON_THRESHOLD};
pub use component::{
    Component, ComponentBase, ComponentBuilder, EventSink, HardwareComponent,
};
pub use reconcile::{plan_board, BoardPlan, DesiredBoard};
pub use context::{
    CloudRequest, CloudRequestKind, DiagnosticLevel, DiagnosticOrigin, Effects, EffectsSink, NodeDiagnostic,
    RuntimeContext, ScheduleRequests, Wakeup, WakeupId,
};
pub use error::{HardwareError, RuntimeError};
pub use registry::ComponentRegistry;
pub use router::{ComponentLookup, DispatchCall, EdgeTarget, FlowRouter};
pub use subscriptions::{
    bridge_uid, figma_announce_actions, reconcile_desired, DesiredSub, FigmaPublish, SubKind,
};
pub use turn_budget::TURN_BUDGET;
pub use value::{ComponentEvent, ComponentValue, PinConfig};
pub use wiring::{BoardWiring, I2cContinuousRead, ListenerWiring, SubscriberWiring};

#[cfg(feature = "cloud")]
pub use error::MqttError;

use crate::firmata::FirmataClient;
use crate::flow::{FlowEdge, FlowNode, FlowUpdate};
use health::NodeHealth;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Reserved runtime handle names — the `source_handle`s the executor treats as
/// plumbing rather than edge **Port**s. All are [`INTERNAL_PREFIX`]-prefixed
/// (see `CONTEXT.md` § Internal Event / Hardware Callback), so
/// [`FlowRuntime::process_event`] can branch them off the Port path in one
/// check; the two hardware-callback names additionally route to typed
/// [`HardwareComponent`] methods rather than the generic `dispatch_internal`
/// catch-all. Naming them here keeps the reserved set discoverable in one place
/// instead of as bare string literals at each emit and match site.
///
/// A third hardware handle, `"stepper_reply"`, is reserved for stepper sysex
/// replies but has **no emission path yet** (see [`crate::nodes::stepper::runtime`] and
/// `CONTEXT.md` § Hardware Callback); it is intentionally not named as a const
/// here until that wiring lands, so an unused const can't masquerade as a live
/// route.
mod reserved_handles {
    /// Marks a `source_handle` as runtime plumbing (Internal Event or Hardware
    /// Callback), never an edge Port. Stripped before `dispatch_internal`.
    pub(crate) const INTERNAL_PREFIX: char = '_';
    /// Board digital/analog pin change → [`super::HardwareComponent::on_pin_change`].
    pub(crate) const PIN_CHANGE: &str = "_pin_change";
    /// Board I2C reply → [`super::HardwareComponent::on_i2c_reply`].
    pub(crate) const I2C_REPLY: &str = "_i2c_reply";

    use std::sync::{Arc, OnceLock};

    /// The two hardware-callback handles are stamped on every inbound pin change
    /// and I2C reply — the highest-frequency events in the system. Interning them
    /// once turns each stamp into a refcount bump instead of an `Arc<str>`
    /// allocation plus string copy per event per listener.
    static PIN_CHANGE_ARC: OnceLock<Arc<str>> = OnceLock::new();
    static I2C_REPLY_ARC: OnceLock<Arc<str>> = OnceLock::new();

    pub(crate) fn pin_change_arc() -> Arc<str> {
        Arc::clone(PIN_CHANGE_ARC.get_or_init(|| Arc::from(PIN_CHANGE)))
    }

    pub(crate) fn i2c_reply_arc() -> Arc<str> {
        Arc::clone(I2C_REPLY_ARC.get_or_init(|| Arc::from(I2C_REPLY)))
    }
}

/// Adapter that lets [`FlowRouter`] read the runtime's component map without
/// seeing its shape. Lives for the scope of one `route` call.
struct ComponentMapLookup<'a> {
    components: &'a HashMap<String, Box<dyn Component>>,
}

impl ComponentLookup for ComponentMapLookup<'_> {
    fn aggregates(&self, id: &str) -> bool {
        self.components.get(id).is_some_and(|c| c.aggregates_inputs())
    }

    fn value_of(&self, id: &str) -> Option<ComponentValue> {
        self.components.get(id).map(|c| c.value())
    }
}

/// The synchronous, single-threaded flow runtime.
pub struct FlowRuntime {
    /// Sans-IO Firmata codec: encodes outbound ops, decodes inbound bytes, and
    /// holds the pin table (seeded from the detection handshake).
    client: FirmataClient,
    /// Edge fanout planner.
    router: FlowRouter,
    /// Catalog factory: builds components from instance name + node data.
    registry: ComponentRegistry,
    /// Live component instances keyed by node id.
    components: HashMap<String, Box<dyn Component>>,
    /// Last-seen node `data` JSON per id, for the incremental update diff.
    node_data: HashMap<String, serde_json::Value>,
    /// Pins currently reporting, with their analog/digital kind. The
    /// reconciliation target diffed on each `update_flow`.
    report_set: HashMap<u8, bool>,
    /// Shared emit queue every component pushes into; drained per turn.
    sink: EventSink,
    /// Flow version, bumped on every `update_flow`; stamps inbound events so
    /// leftover events from a previous flow are gated out as stale.
    current_sequence: u64,
    /// Host clock (ms), refreshed by `set_now` / each entry point.
    now_ms: f64,
    /// Last-observed value per pin, for inbound change detection.
    pin_values: HashMap<u8, u16>,
    /// Pins with at least one listener — the inbound scan set. Empty ⇒ scan all.
    active_pins: HashSet<u8>,
    /// Pin → listening component ids (the inbound `_pin_change` routing table).
    pin_listeners: HashMap<u8, Vec<Arc<str>>>,
    /// I2C address → listening component ids.
    i2c_listeners: HashMap<u8, Vec<(u8, Arc<str>)>>,
    /// Hotkey accelerator (lowercased) → listening component ids.
    key_listeners: HashMap<String, Vec<Arc<str>>>,
    /// Monotonic id source for wakeups handed to the host.
    next_wakeup_id: WakeupId,
    /// Outstanding wakeups keyed by node id, then method, so a re-schedule or
    /// cancel can target the right host timer. Nested (rather than a
    /// `(String, String)` tuple key) so the hot `wake` path can look an entry up
    /// from `&str`s without allocating the two `String`s a tuple key would need.
    outstanding: HashMap<String, HashMap<String, WakeupId>>,
    /// Scratch buffer reused by `detect_pin_changes` so the per-chunk inbound
    /// scan does not allocate a fresh index vector on every serial read.
    pin_scan_scratch: Vec<usize>,
    /// Dispatch errors seen during the current turn, rolled into the `flow tick`
    /// wide event and reset to 0 at the end of every `finish`.
    tick_errors: u32,
    /// Monotonic per-turn id, stamped on every `flow tick` event and its nested
    /// per-event traces so a turn's records correlate in a flat log/sink.
    run_seq: u64,
    /// Last `STRING_DATA` diagnostic logged, to dedupe a per-poll failure
    /// (e.g. a non-ACKing I2C device) into a single line until it changes.
    last_firmata_string: Option<String>,
    /// What the runtime knows is wrong with each node (build, start, rejected
    /// input, runaway loop) — flushed into `Effects::node_diagnostics` per turn.
    health: NodeHealth,
    /// Nodes paused by the turn budget: their Port emits are not routed, which
    /// breaks the loop that blew the budget. Released by a flow update that
    /// reshapes the loop (see `release_paused`).
    paused: HashSet<Arc<str>>,
    /// The edges among `paused` when they were paused — the loop's shape.
    paused_edges: Vec<[String; 4]>,
}

impl FlowRuntime {
    #[must_use]
    pub fn new() -> Self {
        Self {
            client: FirmataClient::new(),
            router: FlowRouter::new(),
            registry: ComponentRegistry::new(),
            components: HashMap::new(),
            node_data: HashMap::new(),
            report_set: HashMap::new(),
            sink: EventSink::default(),
            current_sequence: 0,
            now_ms: 0.0,
            pin_values: HashMap::new(),
            active_pins: HashSet::new(),
            pin_listeners: HashMap::new(),
            i2c_listeners: HashMap::new(),
            key_listeners: HashMap::new(),
            next_wakeup_id: 1,
            outstanding: HashMap::new(),
            pin_scan_scratch: Vec::new(),
            tick_errors: 0,
            run_seq: 0,
            last_firmata_string: None,
            health: NodeHealth::default(),
            paused: HashSet::new(),
            paused_edges: Vec::new(),
        }
    }

    /// Advance the host clock. Timer nodes read this via `RuntimeContext::now_ms`.
    pub fn set_now(&mut self, ms: f64) {
        self.now_ms = ms;
    }

    /// Seed the board's pin profile from the connection handshake
    /// ([`PinInfo`](crate::firmata::PinInfo)`[]`, the `FirmataSession.pinsJson`
    /// shape both hosts project from their detection codec). The browser's
    /// detection session consumes the capability response before the runtime
    /// attaches, so without this the runtime would not know the board's pins:
    /// inbound messages would have nowhere to land, `A<n>` labels and analog
    /// channels would assume an Uno, and no pin could be judged.
    ///
    /// # Errors
    /// Returns the parse error if `pins_json` is not the expected array shape.
    pub fn seed_pins(&mut self, pins_json: &str) -> Result<(), serde_json::Error> {
        let infos: Vec<crate::firmata::PinInfo> = serde_json::from_str(pins_json)?;
        self.client.set_profile(crate::firmata::PinProfile::from_pin_infos(&infos));
        Ok(())
    }

    // --- Host entry points (each returns the turn's Effects) -----------------

    /// Rebuild the flow from an update: bump the sequence (so leftover events
    /// gate out as stale), incrementally diff nodes by id + `data`, build/destroy
    /// components, reconcile Firmata reporting from the new wiring (emitting
    /// enable/disable bytes), initialize newly-built hardware (pin modes), and
    /// rebuild edges. Returns the setup `Effects`.
    pub fn update_flow(&mut self, update: FlowUpdate) -> Effects {
        let FlowUpdate { nodes, edges } = update;
        self.current_sequence += 1;
        let mut out = Vec::new();
        let mut reqs = ScheduleRequests::default();

        // 1. Diff: removed = present but gone; to_add = new or data-changed.
        let new_ids: HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
        let edges = drop_dangling_edges(edges, &new_ids);
        let mut removed: Vec<String> = self
            .components
            .keys()
            .filter(|id| !new_ids.contains(id.as_str()))
            .cloned()
            .collect();
        let mut to_add: Vec<&FlowNode> = Vec::new();
        for node in &nodes {
            let unchanged = self.node_data.get(&node.id).is_some_and(|d| d == &node.data);
            if !unchanged {
                if self.components.contains_key(&node.id) {
                    removed.push(node.id.clone());
                }
                to_add.push(node);
            }
        }

        // 2. Destroy removed / replaced. A paused loop is released first when
        //    this update reshapes it; a fan-out warning is re-judged by the
        //    next turn that runs long, so every update clears it.
        self.release_paused(&new_ids, &to_add, &edges);
        self.health.clear_overloads();
        for id in &removed {
            self.remove_component(id);
            self.node_data.remove(id);
        }
        // Nodes that left the flow lose any badge the runtime put on them —
        // including ones that never built, which `removed` cannot see.
        self.health.retain(|id| new_ids.contains(id));

        // 3. Build added / replaced. A node that fails to build is not running,
        //    so the failure goes on its badge, not only into the log. It never
        //    enters `node_data`, so every later update retries the build.
        for node in &to_add {
            let instance = node_instance(node);
            self.health.rebuilt(&node.id);
            match self.registry.create(&node.id, instance, &node.data) {
                Ok(mut component) => {
                    if let Some(hw) = component.as_hardware_mut() {
                        hw.bind_pins(&self.client.profile);
                    }
                    self.add_component(&node.id, component);
                    self.node_data.insert(node.id.clone(), node.data.clone());
                }
                Err(e) => {
                    tracing::warn!(node = %node.id, instance, error = %e, "failed to build component");
                    self.health.build_failed(&node.id, build_failure_message(instance, &e));
                }
            }
        }

        // 3b. Judge every running node's pins against the board — every node,
        //     not just the rebuilt ones, since a newly wired edge can change
        //     what a pin must do (a Led's `value` port drives PWM).
        for node in nodes.iter().filter(|n| self.components.contains_key(&n.id)) {
            let fault = pin_check::problem(node, &edges, &self.client.profile);
            self.health.pin_fault(&node.id, fault);
        }

        // 4. Recompute the wiring tables + the desired board config from every
        //    active component, in one walk. The listener tables are runtime
        //    routing state; the board-wide votes (sampling interval, I2C
        //    read-delay, continuous reads) become the `DesiredBoard` the central
        //    reconcile planner reconciles.
        let (tables, desired) = reconcile::gather_wiring(
            self.components
                .iter()
                .map(|(id, c)| (id.as_str(), c.listener_wiring(), c.board_wiring())),
        );

        // 5. Plan the board reconcile as a pure value — the reporting diff (analog
        //    per channel, digital per 8-pin PORT), the bus config + sampling
        //    interval, and the I2C drain/arm counts. Every protocol quirk lives in
        //    `reconcile::plan_board`, not here. Snapshot the previous per-address
        //    query counts BEFORE overwriting the routing tables so the drain is exact.
        let prev_i2c_counts: HashMap<u8, usize> =
            self.i2c_listeners.iter().map(|(&addr, ids)| (addr, ids.len())).collect();
        let plan = reconcile::plan_board(&self.report_set, &prev_i2c_counts, &desired);

        // 5a. Setup phase — emit BEFORE per-node initialize so reporting is off,
        //     and the bus config and sampling interval are live, before any
        //     device's power-on writes. Reporting is switched on in the arm phase. (Sent every update_flow: a cheap sysex, and the
        //     runtime is rebuilt fresh on each board (re)connect, so this is also
        //     how the rate is restored after a replug.)
        plan.encode_setup(&mut BufferBoardWriter::new(&mut self.client, &mut out));

        // Commit the new routing state (the plan already captured what it needs
        // from the previous `report_set` / `i2c_listeners` above).
        self.active_pins = desired.report.keys().copied().collect();
        self.pin_values.retain(|pin, _| desired.report.contains_key(pin));
        self.pin_listeners = tables.pin_listeners;
        self.i2c_listeners = tables.i2c_listeners;
        self.key_listeners = tables.key_listeners;
        self.report_set = desired.report;

        // 6. Initialize newly-built hardware (pin modes + initial output state).
        let added_ids: Vec<String> = to_add.iter().map(|n| n.id.clone()).collect();
        for id in &added_ids {
            self.start_node(id, &mut out, &mut reqs);
        }

        // 6b. Arm phase — emit AFTER per-node initialize so each device is
        //     configured (its `device_init_writes`) before its continuous read
        //     starts. The plan drains every previously-armed query, then starts the
        //     desired set; see `reconcile::plan_board` for why the drain count per
        //     address must be exact (StandardFirmata clears the lone remaining query
        //     regardless of address, so an extra stop would drop a sibling device).
        plan.encode_arm(&mut BufferBoardWriter::new(&mut self.client, &mut out));

        // 7. Rebuild edges, then drain any init-time emissions. A rejected input
        //    that no edge feeds any more stops being reported — removing the
        //    bad edge is how the user fixes it.
        self.health.retain_inputs(|node, method| {
            method.starts_with(reserved_handles::INTERNAL_PREFIX)
                || edges.iter().any(|e| e.target == node && e.target_handle == method)
        });
        self.router.set_edges(edges);
        self.finish("update_flow", out, reqs)
    }

    /// `initialize` (hardware) then `on_start` one freshly built node, putting a
    /// failure on its badge.
    fn start_node(&mut self, id: &str, out: &mut Vec<u8>, reqs: &mut ScheduleRequests) {
        let mut writer = BufferBoardWriter::new(&mut self.client, out);
        let mut ctx = RuntimeContext::new(&mut writer, self.now_ms, id, reqs);
        if let Some(component) = self.components.get_mut(id) {
            if let Some(hw) = component.as_hardware_mut() {
                if let Err(e) = hw.initialize(&mut ctx) {
                    tracing::warn!(node = %id, error = %e, "initialize failed");
                    self.health.start_failed(id, format!("Could not set up on the board: {e}"));
                }
            }
            if let Err(e) = component.on_start(&mut ctx) {
                tracing::warn!(node = %id, error = %e, "on_start failed");
                self.health.start_failed(id, format!("Failed to start: {e}"));
            }
        }
    }

    /// Feed raw inbound serial bytes: decode via the codec, diff the pin table,
    /// resolve listeners, stamp the live sequence, and drain the cascade. A
    /// firmware announcement on the live session means the board rebooted, and
    /// the flow is re-applied to it in this turn (see `session`).
    pub fn feed_bytes(&mut self, bytes: &[u8]) -> Effects {
        let parsed = self.client.feed(bytes);
        let mut out = Vec::new();
        let mut reqs = ScheduleRequests::default();
        let dropped = self.client.take_dropped_bytes();
        if dropped > 0 {
            log::warn!("firmata stream: dropped {dropped} bytes of a frame that never completed");
        }
        if Self::is_reannounce(&parsed) {
            self.board_reannounced(&mut out, &mut reqs);
        }
        self.detect_pin_changes();
        self.drain_i2c_replies();
        self.drain_firmata_strings();
        self.finish("feed_bytes", out, reqs)
    }

    /// Surface the board's `STRING_DATA` diagnostics (e.g. "I2C: Too few bytes
    /// received" when a device never ACKs). These were silently dropped before;
    /// logging them turns an invisible bus failure into an actionable line.
    /// Deduped against the last message so a per-poll failure doesn't spam.
    fn drain_firmata_strings(&mut self) {
        for s in self.client.strings.drain(..) {
            if self.last_firmata_string.as_deref() != Some(s.as_str()) {
                log::warn!("firmata board says: {s}");
                self.last_firmata_string = Some(s);
            }
        }
    }

    /// A host timer fired: deliver `method` to `node_id` as an internal event
    /// (e.g. `_tick`). The outstanding entry is cleared first so the node may
    /// re-schedule from within its handler.
    pub fn wake(&mut self, node_id: &str, method: &str) -> Effects {
        Self::take_outstanding(&mut self.outstanding, node_id, method);
        let value = self
            .components
            .get(node_id)
            .map_or_else(ComponentValue::default, |c| c.value());
        let event = ComponentEvent {
            source: Arc::from(node_id),
            source_handle: Arc::from(method),
            value,
            edge_id: None,
            sequence: self.current_sequence,
        };
        let mut out = Vec::new();
        let mut reqs = ScheduleRequests::default();
        self.process_event(&event, &mut out, &mut reqs);
        self.finish("wake", out, reqs)
    }

    /// Inject an external call at a component's input (the `component_call`
    /// equivalent): dispatch directly, then drain the cascade.
    pub fn dispatch(&mut self, id: &str, method: &str, value: ComponentValue) -> Effects {
        let mut out = Vec::new();
        let mut reqs = ScheduleRequests::default();
        self.dispatch_to(id, method, value, &mut out, &mut reqs);
        self.finish("dispatch", out, reqs)
    }

    // --- Graph mutation helpers (used by the Stage-3 registry + by tests) ----

    /// Insert (or replace) a component instance and wire it to the emit queue.
    pub fn add_component(&mut self, id: &str, mut component: Box<dyn Component>) {
        component.set_sink(self.sink.clone());
        self.components.insert(id.to_string(), component);
    }

    /// Remove a component, running its `destroy` hook.
    pub fn remove_component(&mut self, id: &str) {
        if let Some(mut component) = self.components.remove(id) {
            component.destroy();
        }
    }

    /// Replace the edge set.
    pub fn set_edges(&mut self, edges: Vec<FlowEdge>) {
        self.router.set_edges(edges);
    }

    /// Register a component as a listener for a digital/analog pin's changes.
    pub fn register_pin_listener(&mut self, pin: u8, component_id: &str) {
        self.active_pins.insert(pin);
        self.pin_listeners
            .entry(pin)
            .or_default()
            .push(Arc::from(component_id));
    }

    /// Register a component as a listener for an I2C address's replies on a
    /// specific `register` (replies are demuxed by register in `drain_i2c_replies`).
    pub fn register_i2c_listener(&mut self, address: u8, register: u8, component_id: &str) {
        self.i2c_listeners
            .entry(address)
            .or_default()
            .push((register, Arc::from(component_id)));
    }

    /// Set the current flow sequence (used by the desktop host + tests to drive
    /// stale-gating directly).
    pub fn set_sequence(&mut self, sequence: u64) {
        self.current_sequence = sequence;
    }

    /// Deliver an inbound external message (MQTT / Figma broker payload) to a
    /// subscribe component by id; it updates + emits, then the cascade drains.
    pub fn deliver_message(&mut self, component_id: &str, topic: &str, payload: &[u8]) -> Effects {
        if let Some(component) = self.components.get_mut(component_id) {
            component.receive_raw_message(topic, payload);
        }
        self.finish("deliver", Vec::new(), ScheduleRequests::default())
    }

    /// Fold an asynchronous cloud-node result back into the runtime as if the
    /// node had emitted `value` on `source_handle`. Cloud nodes do network I/O on
    /// a spawned task whose result cannot touch the `!Send` emit queue directly;
    /// the host receives `(source, handle, value)` over the node's `CloudEmitter`
    /// and calls this on the runtime's owner thread. Stamped `sequence: 0`
    /// (component logic, never stale), exactly like a synchronous emit — the
    /// event is surfaced to the UI and the downstream cascade drains.
    pub fn inject_event(
        &mut self,
        source: &str,
        source_handle: &str,
        value: ComponentValue,
    ) -> Effects {
        self.sink.borrow_mut().push_back(ComponentEvent {
            source: Arc::from(source),
            source_handle: Arc::from(source_handle),
            value,
            edge_id: None,
            sequence: 0,
        });
        self.finish("inject", Vec::new(), ScheduleRequests::default())
    }

    /// Deliver a hotkey press (`pressed = true`) or release (`pressed = false`)
    /// to every component listening on `accelerator` (matched lowercased), then
    /// drain the cascade.
    pub fn dispatch_key_event(&mut self, accelerator: &str, pressed: bool) -> Effects {
        let ids = self
            .key_listeners
            .get(&accelerator.to_lowercase())
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::new();
        let mut reqs = ScheduleRequests::default();
        for id in ids {
            self.dispatch_to(id.as_ref(), "key_event", ComponentValue::Bool(pressed), &mut out, &mut reqs);
        }
        self.finish("key", out, reqs)
    }

    /// Every active component's subscriber wiring paired with its id — the host
    /// uses this to (un)subscribe brokers as the flow changes.
    #[must_use]
    pub fn collect_subscriber_wirings(&self) -> Vec<(String, SubscriberWiring)> {
        let mut out = Vec::new();
        for (id, component) in &self.components {
            for wiring in component.subscriber_wiring() {
                out.push((id.clone(), wiring));
            }
        }
        out
    }

    /// Every active MIDI listener: `(node id, device-name filter)`. Unlike MQTT
    /// there is no one-owner-per-topic reconcile — the host opens the union of
    /// matching devices and routes every message to every matching listener via
    /// [`deliver_message`](Self::deliver_message) (`topic` = the host port name,
    /// `payload` = the raw `[status, data1, data2]`). Sorted by node id so an
    /// unchanged flow yields an identical list (zero host churn).
    #[must_use]
    pub fn collect_midi_listeners(&self) -> Vec<crate::runtime::subscriptions::MidiListener> {
        let mut out: Vec<_> = self
            .components
            .iter()
            .filter_map(|(id, component)| {
                component.midi_wiring().map(|device_name| {
                    crate::runtime::subscriptions::MidiListener {
                        node_id: id.clone(),
                        device_name,
                    }
                })
            })
            .collect();
        out.sort_by(|a, b| a.node_id.cmp(&b.node_id));
        out
    }

    // --- Inbound decode ------------------------------------------------------

    /// Diff the codec's pin table against the last-seen values and push a
    /// seq-stamped `_pin_change` event per listening component. Ported from the
    /// desktop `BoardConnection::detect_and_emit_changes`.
    fn detect_pin_changes(&mut self) {
        // Reuse the scan buffer across calls — `feed_bytes` runs it once per
        // inbound serial chunk, so a fresh `Vec` here was an allocation per read.
        let mut indices = std::mem::take(&mut self.pin_scan_scratch);
        indices.clear();
        if self.active_pins.is_empty() {
            indices.extend(0..self.client.pins.len());
        } else {
            indices.extend(self.active_pins.iter().map(|&p| p as usize));
        }

        let mut changes: Vec<(u8, u16, bool)> = Vec::new();
        for &index in &indices {
            let Some(pin) = self.client.pins.get(index) else { continue };
            let pin_num = index as u8;
            let current = pin.value as u16;
            let is_analog = self.client.profile.analog_channel(pin_num).is_some();

            let last = self.pin_values.get(&pin_num).copied();
            if last == Some(current) {
                continue;
            }
            let should_emit = if is_analog {
                match last {
                    Some(prev) => (i32::from(current) - i32::from(prev)).unsigned_abs() as u16 >= 1,
                    None => true,
                }
            } else {
                true
            };
            if should_emit {
                self.pin_values.insert(pin_num, current);
                changes.push((pin_num, current, is_analog));
            }
        }

        for (pin, value, is_analog) in changes {
            let Some(listeners) = self.pin_listeners.get(&pin) else { continue };
            let value = if is_analog {
                ComponentValue::Number(f64::from(value))
            } else {
                ComponentValue::Bool(value > 0)
            };
            for component_id in listeners {
                self.sink.borrow_mut().push_back(ComponentEvent {
                    source: Arc::clone(component_id),
                    source_handle: reserved_handles::pin_change_arc(),
                    value: value.clone(),
                    edge_id: None,
                    sequence: self.current_sequence,
                });
            }
        }

        self.pin_scan_scratch = indices;
    }

    /// Drain decoded I2C replies into seq-stamped `_i2c_reply` events.
    fn drain_i2c_replies(&mut self) {
        if self.client.i2c_data.is_empty() {
            return;
        }
        let replies = std::mem::take(&mut self.client.i2c_data);
        for reply in replies {
            let address = reply.address as u8;
            let register = reply.register as u8;
            let Some(listeners) = self.i2c_listeners.get(&address) else { continue };
            let data: Vec<ComponentValue> = reply
                .data
                .iter()
                .map(|&b| ComponentValue::Number(f64::from(b)))
                .collect();
            // Demux by register: the reply frame carries the register the board
            // re-wrote for this continuous read, so a node only receives replies
            // for the register it streams — two nodes on one address reading
            // different registers (MPU6050 accel 0x3B + gyro 0x43, SHT2x temp 0xF3
            // + humidity 0xF5) no longer clobber each other's value. Fallback: if
            // NO listener on this address matches the register, deliver to all of
            // them, so a device whose reply register is unexpected still updates
            // rather than going silent (never narrower than the old address-only
            // routing).
            let register_matched = listeners.iter().any(|(reg, _)| *reg == register);
            for (reg, component_id) in listeners {
                if register_matched && *reg != register {
                    continue;
                }
                self.sink.borrow_mut().push_back(ComponentEvent {
                    source: Arc::clone(component_id),
                    source_handle: reserved_handles::i2c_reply_arc(),
                    value: ComponentValue::Array(data.clone()),
                    edge_id: None,
                    sequence: self.current_sequence,
                });
            }
        }
    }

    // --- The executor + drain ------------------------------------------------

    /// Drain the emit queue to completion, accumulating side effects, then
    /// resolve the turn's scheduling requests into concrete wakeups.
    fn finish(&mut self, stimulus: &'static str, mut out: Vec<u8>, mut reqs: ScheduleRequests) -> Effects {
        // One `flow_tick` span per turn; the per-event `trace!`s below nest under
        // it, and the host subscriber (desktop fmt / browser `tracing-web`) times
        // the drain. No clock lives here — `now_ms` is host-fed and `Instant` is
        // absent on wasm — so duration is left to the subscriber's timestamps.
        self.run_seq += 1;
        let run_id = self.run_seq;
        let span = tracing::debug_span!("flow_tick", run_id, stimulus, seq = self.current_sequence);
        let _enter = span.enter();
        let mut events = Vec::new();
        let mut drained = 0u32;
        // Emitters seen in the last `TRACE_TAIL` events before the budget — only
        // filled once a turn is already close to running away.
        let mut tail: HashSet<Arc<str>> = HashSet::new();
        loop {
            // Pop in its own scope so a component is free to push during dispatch.
            let next = self.sink.borrow_mut().pop_front();
            let Some(event) = next else { break };
            drained += 1;
            if drained > TURN_BUDGET - turn_budget::TRACE_TAIL {
                if drained > TURN_BUDGET {
                    self.stop_runaway_turn(&tail, &event.source);
                    break;
                }
                tail.insert(Arc::clone(&event.source));
            }
            // Highest-cardinality flow signal: which node emitted on which handle,
            // and whether it's UI-visible or internal plumbing. TRACE so it's
            // opt-in and silent by default.
            tracing::trace!(
                run_id,
                source = %event.source,
                handle = %event.source_handle,
                seq = event.sequence,
                internal = event.source_handle.starts_with(reserved_handles::INTERNAL_PREFIX),
                "drain",
            );
            self.process_event(&event, &mut out, &mut reqs);
            // Internal/hardware events (`_`-prefixed) are runtime plumbing the
            // UI never renders — keep them out of `component_events`. Moved in
            // after dispatch (the cascade it triggers is drained on later
            // iterations, so the order is unchanged) to keep this handoff a
            // move rather than a deep clone of the event.
            if !event.source_handle.starts_with(reserved_handles::INTERNAL_PREFIX) {
                events.push(event);
            }
        }
        // Cloud requests a node asked for this turn (ADR-0009), resolved into the
        // host-facing `Effects` shape. `source` (node id) is the correlation key
        // for any result that re-enters via `inject_event`.
        let cloud_requests: Vec<CloudRequest> = reqs
            .cloud_requests
            .drain(..)
            .map(|(source, kind)| CloudRequest { source: Arc::from(source.as_str()), kind })
            .collect();
        // What nodes reported about themselves, then the runtime's own badge
        // transitions. Each carries its origin, so the order does not matter:
        // neither origin's clear can touch the other's diagnostic.
        let mut node_diagnostics = std::mem::take(&mut reqs.diagnostics);
        self.health.flush(&mut node_diagnostics);
        let (wakeups, cancellations) = self.resolve_schedule(reqs);
        // One wide event per turn that *did something* — drained an event, wrote
        // bytes, (re)armed a timer, issued a cloud call, or hit a dispatch error.
        // Truly-idle turns (pin scans with no change) stay silent to bound volume.
        // The single line is self-explaining: what triggered the turn, what it
        // produced, what failed.
        let errors = self.tick_errors;
        self.tick_errors = 0;
        let produced = drained > 0
            || !out.is_empty()
            || !wakeups.is_empty()
            || !cancellations.is_empty()
            || !cloud_requests.is_empty()
            || !node_diagnostics.is_empty()
            || errors > 0;
        if produced {
            tracing::debug!(
                run_id,
                stimulus,
                drained,
                component_events = events.len(),
                outbound_bytes = out.len(),
                wakeups = wakeups.len(),
                cancellations = cancellations.len(),
                errors,
                "flow tick",
            );
        }
        Effects {
            outbound_bytes: out,
            component_events: events,
            wakeups,
            cancellations,
            cloud_requests,
            node_diagnostics,
        }
    }

    /// The turn drained [`TURN_BUDGET`] events: drop the rest of the queue (the
    /// runtime stays alive and the turn's effects so far still apply), then
    /// decide why it ran long. `tail` holds the emitters of the last events.
    ///
    /// - If they sit on a cycle of the flow's edges, every node of that cycle
    ///   is paused, so the next stimulus cannot spin again.
    /// - If not, the flow is acyclic and merely fans out too much: nothing is
    ///   paused — pausing would silently cut a wire that is not a loop — and
    ///   the node whose event found the budget spent carries a warning until
    ///   the next flow update.
    fn stop_runaway_turn(&mut self, tail: &HashSet<Arc<str>>, last: &Arc<str>) {
        let dropped = {
            let mut queue = self.sink.borrow_mut();
            let n = queue.len() + 1;
            queue.clear();
            n
        };
        let members = turn_budget::loop_members(tail, self.router.edges());
        if members.is_empty() {
            tracing::warn!(
                run_id = self.run_seq,
                budget = TURN_BUDGET,
                dropped,
                node = %last,
                "turn budget spent without a loop; turn ended",
            );
            self.health.overloaded(
                last,
                Some(format!(
                    "Too many events in one step (more than {TURN_BUDGET}): the flow fans out \
                     too much from here, so the rest of that step was dropped."
                )),
            );
            return;
        }
        tracing::warn!(
            run_id = self.run_seq,
            budget = TURN_BUDGET,
            dropped,
            nodes = ?members,
            "turn budget spent; pausing runaway loop",
        );
        let message = format!(
            "Paused: this node is in a loop that never settles (more than {TURN_BUDGET} \
             events in one step). Change the loop to resume it."
        );
        for id in members {
            self.health.runaway(&id, Some(message.clone()));
            self.paused.insert(id);
        }
        self.paused_edges = turn_budget::edges_touching(&self.paused, self.router.edges());
    }

    /// Release every paused node when a flow update reshapes their loop: a
    /// paused node is removed or rebuilt (its behaviour may have changed), or an
    /// edge touching one of them is added, removed or re-pointed. Otherwise the
    /// loop is exactly as runaway as it was, and releasing it would only spend
    /// another full budget on the next stimulus. A released loop that still
    /// runs away is caught and paused again by the next turn.
    fn release_paused(&mut self, new_ids: &HashSet<&str>, to_add: &[&FlowNode], edges: &[FlowEdge]) {
        if self.paused.is_empty() {
            return;
        }
        let reshaped = self.paused.iter().any(|id| !new_ids.contains(id.as_ref()))
            || to_add.iter().any(|n| self.paused.contains(n.id.as_str()))
            || turn_budget::edges_touching(&self.paused, edges) != self.paused_edges;
        if !reshaped {
            return;
        }
        for id in self.paused.drain() {
            self.health.runaway(&id, None);
        }
        self.paused_edges.clear();
    }

    /// Gate stale events, branch internal/hardware callbacks, echo `set_value`
    /// on the source, route, and dispatch. Ported from the desktop
    /// `FlowExecutor::process_event`.
    fn process_event(&mut self, event: &ComponentEvent, out: &mut Vec<u8>, reqs: &mut ScheduleRequests) {
        // Stale-event gate. sequence == 0 means "unsequenced" (component logic,
        // never stale). Only drop events carrying a non-zero sequence older than
        // the current flow version (leftover board events from an old flow).
        if event.sequence > 0 && event.sequence < self.current_sequence {
            tracing::trace!(
                run_id = self.run_seq,
                source = %event.source,
                handle = %event.source_handle,
                seq = event.sequence,
                current = self.current_sequence,
                "stale event dropped",
            );
            return;
        }

        // Internal-event branch (underscore-prefixed handle): hardware callbacks
        // (`_pin_change`/`_i2c_reply`) → typed methods, other `_method` →
        // `dispatch_internal`. Never flows through the router (source == target).
        if event.source_handle.starts_with(reserved_handles::INTERNAL_PREFIX) {
            self.dispatch_internal_event(event, out, reqs);
            return;
        }

        // A node paused by the turn budget still runs and still shows its value,
        // but its Port emits go nowhere — that is what keeps its loop broken.
        if !self.paused.is_empty() && self.paused.contains(event.source.as_ref()) {
            return;
        }

        // Echo `set_value` on the source so a subsequent snapshot delivery
        // (aggregating target) reads the just-emitted value, not stale state.
        // Skipped when it would be a no-op, which is the common case: the
        // emitter that set this value already stored it.
        if let Some(component) = self.components.get_mut(event.source.as_ref()) {
            if component.base().value != event.value {
                component.set_value(event.value.clone());
            }
        }

        let plan = {
            let lookup = ComponentMapLookup { components: &self.components };
            self.router.route(event, &lookup)
        };
        tracing::trace!(
            run_id = self.run_seq,
            source = %event.source,
            handle = %event.source_handle,
            targets = plan.len(),
            "routed",
        );
        for call in plan {
            self.dispatch_to(call.target_id.as_ref(), call.target_handle.as_ref(), call.args, out, reqs);
        }
    }

    /// Dispatch one edge-input call to a component, building its per-call
    /// [`RuntimeContext`] (board writer over the codec + this turn's buffer).
    fn dispatch_to(
        &mut self,
        id: &str,
        method: &str,
        value: ComponentValue,
        out: &mut Vec<u8>,
        reqs: &mut ScheduleRequests,
    ) {
        let mut errored = None;
        if let Some(component) = self.components.get_mut(id) {
            let mut writer = BufferBoardWriter::new(&mut self.client, out);
            let mut ctx = RuntimeContext::new(&mut writer, self.now_ms, id, reqs);
            match component.dispatch(method, value, &mut ctx) {
                Ok(()) => self.health.input_accepted(id, method),
                Err(e) => errored = Some(e),
            }
        }
        // Counted into the turn's `flow tick` wide event and emitted on the tracing
        // pipeline so it nests under the `flow_tick` span — the browser has no
        // `log` subscriber, so the old `log::warn!` here was invisible there. The
        // node's badge says which input it rejected until that input succeeds.
        if let Some(e) = errored {
            tracing::warn!(node = id, method, error = %e, "dispatch failed");
            self.tick_errors += 1;
            self.health.input_rejected(id, method, format!("Input \"{method}\" failed: {e}"));
        }
    }

    /// Deliver an internal/hardware event to its (self-)target component.
    fn dispatch_internal_event(
        &mut self,
        event: &ComponentEvent,
        out: &mut Vec<u8>,
        reqs: &mut ScheduleRequests,
    ) {
        let id = Arc::clone(&event.source);
        let handle = Arc::clone(&event.source_handle);
        let mut errored = None;
        if let Some(component) = self.components.get_mut(id.as_ref()) {
            let mut writer = BufferBoardWriter::new(&mut self.client, out);
            let mut ctx = RuntimeContext::new(&mut writer, self.now_ms, id.as_ref(), reqs);
            let result = match handle.as_ref() {
                reserved_handles::PIN_CHANGE => component
                    .as_hardware_mut()
                    .map_or(Ok(()), |hw| hw.on_pin_change(event.value.clone(), &mut ctx)),
                reserved_handles::I2C_REPLY => {
                    // Unmarshal the `Array` transport to raw bytes ONCE here so
                    // every I2C driver's `on_i2c_reply` receives a slice rather
                    // than re-unwrapping `ComponentValue` itself (the old clone).
                    let bytes = event.value.as_byte_vec();
                    component
                        .as_hardware_mut()
                        .map_or(Ok(()), |hw| hw.on_i2c_reply(&bytes, &mut ctx))
                }
                other => component.dispatch_internal(&other[1..], event.value.clone(), &mut ctx),
            };
            match result {
                Ok(()) => self.health.input_accepted(id.as_ref(), handle.as_ref()),
                Err(e) => errored = Some(e),
            }
        }
        if let Some(e) = errored {
            tracing::warn!(node = %id, handle = %handle, error = %e, "internal dispatch failed");
            self.tick_errors += 1;
            let what = match handle.as_ref() {
                reserved_handles::PIN_CHANGE => "Reading its pin".to_string(),
                reserved_handles::I2C_REPLY => "Reading its I2C device".to_string(),
                other => format!("Internal step \"{}\"", &other[1..]),
            };
            self.health.input_rejected(id.as_ref(), handle.as_ref(), format!("{what} failed: {e}"));
        }
    }

    /// Resolve a turn's [`ScheduleRequests`] into host-facing wakeups and the
    /// ids of any timers that are no longer wanted. A re-schedule of an
    /// outstanding `(node, method)` cancels the prior timer first.
    fn resolve_schedule(&mut self, reqs: ScheduleRequests) -> (Vec<Wakeup>, Vec<WakeupId>) {
        let mut wakeups = Vec::new();
        let mut cancellations = Vec::new();
        for (node, method) in reqs.cancels {
            if let Some(id) = Self::take_outstanding(&mut self.outstanding, &node, &method) {
                cancellations.push(id);
            }
        }
        for (node, method, delay_ms) in reqs.schedules {
            let id = self.next_wakeup_id;
            self.next_wakeup_id += 1;
            // One `insert` does the read-and-replace: the previous timer for this
            // `(node, method)`, if any, is the value it hands back — no separate
            // `remove` and no second pair of key clones on the hot timer path.
            let previous = self
                .outstanding
                .entry(node.clone())
                .or_default()
                .insert(method.clone(), id);
            if let Some(old) = previous {
                cancellations.push(old);
            }
            wakeups.push(Wakeup { id, node_id: node, method, delay_ms });
        }
        (wakeups, cancellations)
    }

    /// Remove one outstanding timer, pruning the node's sub-map when it empties.
    /// Takes the map rather than `&mut self` so callers keep their other borrows.
    fn take_outstanding(
        outstanding: &mut HashMap<String, HashMap<String, WakeupId>>,
        node_id: &str,
        method: &str,
    ) -> Option<WakeupId> {
        let methods = outstanding.get_mut(node_id)?;
        let id = methods.remove(method);
        if methods.is_empty() {
            outstanding.remove(node_id);
        }
        id
    }
}

impl Default for FlowRuntime {
    fn default() -> Self {
        Self::new()
    }
}

/// The catalog instance name for a node: `data.instance` if present, else the
/// node's `type`, else empty (unknown — skipped by the registry).
fn node_instance(node: &FlowNode) -> &str {
    node.data
        .get("instance")
        .and_then(serde_json::Value::as_str)
        .or(node.node_type.as_deref())
        .unwrap_or("")
}

/// Drop edges whose source or target is not a node of this update. A shared
/// document can hold them (a node deleted while a collaborator wired it, or a
/// flow persisted by an older client); the editor cannot draw or delete them,
/// so they are not the user's to fix and get no badge. At runtime they are inert
/// — they never fire and an aggregating input skips them — so dropping them here
/// only keeps them out of the router and out of loop detection. Handles are not
/// checked: a node may take open ports its `ports()` does not list (Function's
/// template variables).
fn drop_dangling_edges(edges: Vec<FlowEdge>, nodes: &HashSet<&str>) -> Vec<FlowEdge> {
    let before = edges.len();
    let kept: Vec<FlowEdge> = edges
        .into_iter()
        .filter(|e| nodes.contains(e.source.as_str()) && nodes.contains(e.target.as_str()))
        .collect();
    if kept.len() != before {
        tracing::warn!(dropped = before - kept.len(), "dropped edges to nodes not in the flow");
    }
    kept
}

/// The badge text for a node the registry could not build. The node is not
/// running at all, so the message says so first, then why.
fn build_failure_message(instance: &str, error: &RuntimeError) -> String {
    match error {
        RuntimeError::ComponentNotFound(_) if instance.is_empty() => {
            "Not running: this node has no type".to_string()
        }
        RuntimeError::ComponentNotFound(_) => {
            format!("Not running: \"{instance}\" is not a node type this runtime knows")
        }
        RuntimeError::ConfigDeserialize { source, .. } => {
            format!("Not running: its settings could not be read ({source})")
        }
        other => format!("Not running: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::component::ComponentBase;
    use std::borrow::Cow;

    // --- Tiny hand-built components (the registry that builds real nodes from
    // JSON lands in Stage 3; these exercise the executor/drain/board/inbound). --

    /// Software passthrough: `dispatch("value", v)` emits `value = v`.
    struct Passthrough {
        base: ComponentBase,
    }
    impl Component for Passthrough {
        fn base(&self) -> &ComponentBase { &self.base }
        fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
        fn component_type(&self) -> &'static str { "Passthrough" }
        fn dispatch(&mut self, _m: &str, args: ComponentValue, _c: &mut RuntimeContext) -> Result<(), RuntimeError> {
            self.base.set_value(args);
            Ok(())
        }
    }

    /// Output: `dispatch("value", bool)` drives a digital pin.
    struct TestLed {
        base: ComponentBase,
        pin: u8,
    }
    impl Component for TestLed {
        fn base(&self) -> &ComponentBase { &self.base }
        fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
        fn component_type(&self) -> &'static str { "TestLed" }
        fn dispatch(&mut self, _m: &str, args: ComponentValue, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
            ctx.board().digital_write(self.pin, args.is_truthy())?;
            Ok(())
        }
    }

    /// Input: `on_pin_change` emits the bool on the `value` handle.
    struct TestSwitch {
        base: ComponentBase,
    }
    impl Component for TestSwitch {
        fn base(&self) -> &ComponentBase { &self.base }
        fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
        fn component_type(&self) -> &'static str { "TestSwitch" }
        fn dispatch(&mut self, _m: &str, _a: ComponentValue, _c: &mut RuntimeContext) -> Result<(), RuntimeError> { Ok(()) }
        fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> { Some(self) }
    }
    impl HardwareComponent for TestSwitch {
        fn initialize(&mut self, _ctx: &mut RuntimeContext) -> Result<(), RuntimeError> { Ok(()) }
        fn on_pin_change(&mut self, value: ComponentValue, _c: &mut RuntimeContext) -> Result<(), RuntimeError> {
            self.base.emit_with_value("value", Cow::Owned(value));
            Ok(())
        }
    }

    /// Aggregating sink: records the args it last received into a shared cell
    /// the test can inspect (no downcasting needed).
    type Slot = std::rc::Rc<std::cell::RefCell<Option<ComponentValue>>>;
    struct Recorder {
        base: ComponentBase,
        last: Slot,
    }
    impl Component for Recorder {
        fn base(&self) -> &ComponentBase { &self.base }
        fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
        fn component_type(&self) -> &'static str { "Recorder" }
        fn aggregates_inputs(&self) -> bool { true }
        fn dispatch(&mut self, _m: &str, args: ComponentValue, _c: &mut RuntimeContext) -> Result<(), RuntimeError> {
            *self.last.borrow_mut() = Some(args);
            Ok(())
        }
    }

    fn base(id: &str) -> ComponentBase {
        ComponentBase::new(id.to_string(), ComponentValue::default())
    }

    fn edge(source: &str, source_handle: &str, target: &str, target_handle: &str) -> FlowEdge {
        FlowEdge {
            id: None,
            source: source.to_string(),
            source_handle: source_handle.to_string(),
            target: target.to_string(),
            target_handle: target_handle.to_string(),
        }
    }

    #[test]
    fn external_dispatch_cascades_to_outbound_bytes() {
        let mut rt = FlowRuntime::new();
        rt.add_component("src", Box::new(Passthrough { base: base("src") }));
        rt.add_component("led", Box::new(TestLed { base: base("led"), pin: 13 }));
        rt.set_edges(vec![edge("src", "value", "led", "value")]);

        let effects = rt.dispatch("src", "value", ComponentValue::Bool(true));

        // led pin 13 driven high — the Firmata digital-write bytes are present.
        let expected = FirmataClient::new().encode_digital_write(13, true);
        assert_eq!(effects.outbound_bytes, expected, "led should have been driven high");
        // The src `value` event is surfaced to the UI; `_`-events are not.
        assert!(effects.component_events.iter().any(|e| e.source.as_ref() == "src"
            && e.source_handle.as_ref() == "value"
            && e.value == ComponentValue::Bool(true)));
    }

    #[test]
    #[tracing_test::traced_test]
    fn flow_turn_emits_the_flow_tick_wide_event() {
        // The `flow tick` wide event must fire for any turn that does work, so a
        // future refactor can't silently drop the runtime's telemetry (cf. the
        // emit-handle silent-routing class). Mirrors the cascade test above.
        let mut rt = FlowRuntime::new();
        rt.add_component("src", Box::new(Passthrough { base: base("src") }));
        rt.add_component("led", Box::new(TestLed { base: base("led"), pin: 13 }));
        rt.set_edges(vec![edge("src", "value", "led", "value")]);

        rt.dispatch("src", "value", ComponentValue::Bool(true));

        // The wide event fired, stamped with the stimulus that triggered the turn.
        assert!(logs_contain("flow tick"));
        assert!(logs_contain("dispatch"));
    }

    #[test]
    fn inject_event_routes_like_an_emit() {
        // An async cloud result (the `CloudEmitter` → host → `inject_event` path)
        // must route to downstream edges and surface to the UI just like a
        // synchronous emit from the node.
        let mut rt = FlowRuntime::new();
        rt.add_component("llm", Box::new(Passthrough { base: base("llm") }));
        rt.add_component("led", Box::new(TestLed { base: base("led"), pin: 13 }));
        rt.set_edges(vec![edge("llm", "value", "led", "value")]);

        let effects = rt.inject_event("llm", "value", ComponentValue::Bool(true));

        let expected = FirmataClient::new().encode_digital_write(13, true);
        assert_eq!(effects.outbound_bytes, expected, "downstream led should be driven high");
        assert!(effects.component_events.iter().any(|e| e.source.as_ref() == "llm"
            && e.source_handle.as_ref() == "value"
            && e.value == ComponentValue::Bool(true)));
    }

    #[test]
    fn snapshot_delivers_array_of_inputs() {
        // Drive two emitters into one aggregating recorder; the recorder must
        // receive an Array snapshot of both inputs (router's aggregate path).
        let slot: Slot = std::rc::Rc::new(std::cell::RefCell::new(None));
        let mut rt = FlowRuntime::new();
        rt.add_component("a", Box::new(Passthrough { base: base("a") }));
        rt.add_component("b", Box::new(Passthrough { base: base("b") }));
        rt.add_component("calc", Box::new(Recorder { base: base("calc"), last: slot.clone() }));
        rt.set_edges(vec![
            edge("a", "value", "calc", "value"),
            edge("b", "value", "calc", "value"),
        ]);

        // Seed b's stored value, then drive a — the snapshot must see both.
        rt.dispatch("b", "value", ComponentValue::Number(50.0));
        rt.dispatch("a", "value", ComponentValue::Number(100.0));

        let got = slot.borrow().clone().expect("calc received a value");
        match got {
            ComponentValue::Array(items) => {
                assert!(items.contains(&ComponentValue::Number(100.0)));
                assert!(items.contains(&ComponentValue::Number(50.0)));
            }
            other => panic!("expected snapshot Array, got {other:?}"),
        }
    }

    #[test]
    fn feed_bytes_routes_pin_change_to_listener_and_drives_output() {
        let mut rt = FlowRuntime::new();
        // 8 digital pins so the codec has somewhere to record port-0 writes.
        rt.seed_digital_pins(8);
        rt.add_component("sw", Box::new(TestSwitch { base: base("sw") }));
        rt.add_component("led", Box::new(TestLed { base: base("led"), pin: 13 }));
        rt.register_pin_listener(2, "sw");
        rt.set_edges(vec![edge("sw", "value", "led", "value")]);
        rt.set_sequence(1);

        // Firmata digital port-0 message: pin 2 high (0x90, mask=0b100, 0x00).
        let effects = rt.feed_bytes(&[0x90, 0x04, 0x00]);

        let expected = FirmataClient::new().encode_digital_write(13, true);
        assert_eq!(effects.outbound_bytes, expected, "pin-2 high should light the led");
    }

    #[test]
    fn stale_pin_event_is_dropped() {
        let mut rt = FlowRuntime::new();
        rt.add_component("led", Box::new(TestLed { base: base("led"), pin: 13 }));
        rt.add_component("sw", Box::new(TestSwitch { base: base("sw") }));
        rt.set_edges(vec![edge("sw", "value", "led", "value")]);
        rt.set_sequence(5);

        // A leftover board event from flow version 3 (< current 5) must be gated.
        rt.sink.borrow_mut().push_back(ComponentEvent {
            source: Arc::from("sw"),
            source_handle: Arc::from(reserved_handles::PIN_CHANGE),
            value: ComponentValue::Bool(true),
            edge_id: None,
            sequence: 3,
        });
        let effects = rt.finish("test", Vec::new(), ScheduleRequests::default());
        assert!(effects.outbound_bytes.is_empty(), "stale event must not reach the led");
    }

    fn node(id: &str, instance: &str, data: serde_json::Value) -> FlowNode {
        crate::flow::FlowNode {
            id: id.to_string(),
            node_type: Some(instance.to_string()),
            data,
            position: crate::flow::Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn update_flow_wires_real_nodes_and_cascades() {
        use serde_json::json;
        let mut rt = FlowRuntime::new();
        rt.seed_digital_pins(20);
        rt.mark_pin_analog(2);

        // Sensor(pin 2, analog) -> Gate(and) -> Led(pin 13). Gate "true" lights it.
        let update = FlowUpdate {
            nodes: vec![
                node("sensor", "Sensor", json!({ "instance": "Sensor", "pin": "2", "type": "analog", "threshold": 1 })),
                node("gate", "Gate", json!({ "instance": "Gate", "gate": "and" })),
                node("led", "Led", json!({ "instance": "Led", "pin": 13 })),
            ],
            edges: vec![
                edge("sensor", "value", "gate", "value"),
                edge("gate", "true", "led", "true"),
            ],
        };

        // Setup must enable analog reporting for pin 2 and init the led (pin mode).
        let setup = rt.update_flow(update);
        let enable_analog = FirmataClient::new().encode_report_analog(0, true);
        assert!(
            contains(&setup.outbound_bytes, &enable_analog),
            "update_flow should enable analog reporting for the sensor pin"
        );

        // Drive a sensor reading; the gate passes and the led turns on.
        rt.sink.borrow_mut().push_back(ComponentEvent {
            source: Arc::from("sensor"),
            source_handle: Arc::from(reserved_handles::PIN_CHANGE),
            value: ComponentValue::Number(500.0),
            edge_id: None,
            sequence: rt.current_sequence,
        });
        let effects = rt.finish("test", Vec::new(), ScheduleRequests::default());

        let led_on = FirmataClient::new().encode_digital_write(13, true);
        assert!(contains(&effects.outbound_bytes, &led_on), "sensor>0 should light the led via the gate");
    }

    /// Regression: adding a second I2C device must NOT drop the first. Each node
    /// used to arm its own continuous read in `initialize` behind a preceding
    /// `stop_reading`, but `StandardFirmata` clears the lone remaining query
    /// regardless of address — so the second node's stop wiped the first and only
    /// the latest sensor streamed. Arming is now centralized (drain-all then
    /// arm-all per `update_flow`); both reads must be present after the second flow.
    #[test]
    fn adding_second_i2c_device_keeps_the_first_armed() {
        use serde_json::json;
        let mut rt = FlowRuntime::new();
        rt.seed_digital_pins(20);

        let sht = node(
            "sht",
            "I2cDevice",
            json!({ "device": "custom", "address": 64, "register": 0, "readLength": 2 }),
        );
        let tcs = node(
            "tcs",
            "I2cDevice",
            json!({ "device": "custom", "address": 41, "register": 180, "readLength": 8 }),
        );

        // First flow: only the SHT (0x40) is armed.
        let first = rt.update_flow(FlowUpdate { nodes: vec![sht.clone()], edges: vec![] });
        let client = FirmataClient::new();
        let read_sht = client.encode_i2c_read_continuous(0x40, 0x00, 2);
        assert!(
            contains(&first.outbound_bytes, &read_sht),
            "first flow must arm the SHT continuous read, got: {:02X?}",
            first.outbound_bytes
        );

        // Second flow ADDS the TCS (0x29). Both reads must now be armed — the SHT
        // must be RE-ARMED, not silently dropped by the TCS's stop.
        let second = rt.update_flow(FlowUpdate { nodes: vec![sht, tcs], edges: vec![] });
        let read_tcs = client.encode_i2c_read_continuous(0x29, 0xB4, 8);
        assert!(
            contains(&second.outbound_bytes, &read_tcs),
            "second flow must arm the TCS continuous read, got: {:02X?}",
            second.outbound_bytes
        );
        assert!(
            contains(&second.outbound_bytes, &read_sht),
            "second flow must RE-ARM the SHT — the bug dropped it when the TCS registered; got: {:02X?}",
            second.outbound_bytes
        );
    }

    #[test]
    fn same_address_replies_demux_by_register() {
        use crate::firmata::{END_SYSEX, I2C_REPLY, START_SYSEX};
        use serde_json::json;
        let mut rt = FlowRuntime::new();
        rt.seed_digital_pins(20);

        // MPU6050 accel + gyro: one chip at 0x68, two nodes on different registers
        // (0x3B / 0x43). Raw output so each reply surfaces as a distinctive array.
        let accel = node(
            "accel",
            "I2cDevice",
            json!({ "device": "mpu6050_accel", "address": 0x68, "register": 0x3B, "readLength": 6, "output": "raw" }),
        );
        let gyro = node(
            "gyro",
            "I2cDevice",
            json!({ "device": "mpu6050_gyro", "address": 0x68, "register": 0x43, "readLength": 6, "output": "raw" }),
        );
        rt.update_flow(FlowUpdate { nodes: vec![accel, gyro], edges: vec![] });

        // Build a board I2C_REPLY sysex frame (7-bit lsb/msb pairs) for one register.
        let reply = |reg: u8, data: [u8; 6]| {
            let mut f = vec![START_SYSEX, I2C_REPLY, 0x68, 0, reg & 0x7F, reg >> 7];
            for b in data {
                f.push(b & 0x7F);
                f.push(b >> 7);
            }
            f.push(END_SYSEX);
            f
        };

        // A reply for register 0x3B must reach ONLY the accel node. Before the
        // register demux, the address-only routing handed every 0x68 reply to both
        // nodes, so the gyro node's value flipped to accel data every cycle.
        let accel_reply = rt.feed_bytes(&reply(0x3B, [1, 2, 3, 4, 5, 6]));
        assert!(
            accel_reply.component_events.iter().any(|e| &*e.source == "accel"),
            "accel node must receive its own 0x3B reply, got: {:?}",
            accel_reply.component_events
        );
        assert!(
            !accel_reply.component_events.iter().any(|e| &*e.source == "gyro"),
            "gyro node must NOT receive the accel (0x3B) reply",
        );

        // Mirror: a 0x43 reply reaches only the gyro node.
        let gyro_reply = rt.feed_bytes(&reply(0x43, [7, 8, 9, 10, 11, 12]));
        assert!(
            gyro_reply.component_events.iter().any(|e| &*e.source == "gyro"),
            "gyro node must receive its own 0x43 reply, got: {:?}",
            gyro_reply.component_events
        );
        assert!(
            !gyro_reply.component_events.iter().any(|e| &*e.source == "accel"),
            "accel node must NOT receive the gyro (0x43) reply",
        );
    }

    #[test]
    fn short_i2c_reply_raises_then_clears_node_diagnostic() {
        use crate::firmata::{END_SYSEX, I2C_REPLY, START_SYSEX};
        use serde_json::json;
        let mut rt = FlowRuntime::new();
        rt.seed_digital_pins(20);

        // A TCS-shaped node: reads 8 bytes from reg 0xB4 at 0x29.
        let dev = node(
            "tcs",
            "I2cDevice",
            json!({ "device": "tcs34725", "address": 0x29, "register": 0xB4, "readLength": 8, "output": "raw" }),
        );
        rt.update_flow(FlowUpdate { nodes: vec![dev], edges: vec![] });

        let reply = |data: &[u8]| {
            // reg 0xB4 = 0x34 | (0x01 << 7)
            let mut f = vec![START_SYSEX, I2C_REPLY, 0x29, 0, 0x34, 0x01];
            for &b in data {
                f.push(b & 0x7F);
                f.push(b >> 7);
            }
            f.push(END_SYSEX);
            f
        };

        // A full 8-byte reply: value updates, no diagnostic.
        let ok = rt.feed_bytes(&reply(&[1, 2, 3, 4, 5, 6, 7, 8]));
        assert!(ok.node_diagnostics.is_empty(), "healthy read must not diagnose");
        assert!(ok.component_events.iter().any(|e| &*e.source == "tcs"));

        // An EMPTY reply (the board's NACK: `F0 77 29 00 34 01 F7`) must raise an
        // error diagnostic on the node and NOT emit a (garbage) value event.
        let nack = rt.feed_bytes(&reply(&[]));
        assert_eq!(nack.node_diagnostics.len(), 1, "NACK must diagnose once");
        let d = &nack.node_diagnostics[0];
        assert_eq!(&d.node, "tcs");
        assert!(matches!(d.level, DiagnosticLevel::Error));
        assert!(d.message.is_some(), "raise carries a message");
        assert!(
            !nack.component_events.iter().any(|e| &*e.source == "tcs"),
            "a short read must keep the last good value, not emit"
        );

        // A second NACK must NOT re-diagnose (transition-only, no spam).
        let nack2 = rt.feed_bytes(&reply(&[]));
        assert!(nack2.node_diagnostics.is_empty(), "repeat NACK must not spam");

        // Recovery: a full reply clears the diagnostic (message None).
        let recovered = rt.feed_bytes(&reply(&[8, 7, 6, 5, 4, 3, 2, 1]));
        assert_eq!(recovered.node_diagnostics.len(), 1, "recovery clears once");
        assert!(recovered.node_diagnostics[0].message.is_none(), "clear has no message");
    }

    /// The full hardware-faithful analog loop on an Uno-shaped board: seed the
    /// exact pin-table JSON the desktop detection / web session hand over
    /// (`analogChannel` 0..5 on A0..A5 = pins 14..19), apply a flow holding a
    /// Sensor on `"A0"`, and assert both wire directions — `REPORT_ANALOG` must
    /// target channel 0 (not pin/channel 14), and a raw `0xE0` frame must
    /// surface as the sensor's value event.
    #[test]
    fn uno_sensor_on_a0_end_to_end_over_the_wire() {
        use serde_json::json;
        let mut rt = FlowRuntime::new();

        let pins: Vec<serde_json::Value> = (0i64..20)
            .map(|p| {
                json!({
                    "pin": p,
                    "supportedModes": [],
                    "analogChannel": if p >= 14 { p - 14 } else { -1 },
                })
            })
            .collect();
        rt.seed_pins(&serde_json::to_string(&pins).unwrap()).unwrap();

        let update = FlowUpdate {
            nodes: vec![node(
                "pot",
                "Sensor",
                json!({ "instance": "Sensor", "pin": "A0", "type": "analog", "threshold": 1 }),
            )],
            edges: vec![],
        };
        let setup = rt.update_flow(update);

        let mode_analog = FirmataClient::new().encode_set_pin_mode(14, pin_mode::ANALOG);
        assert!(
            contains(&setup.outbound_bytes, &mode_analog),
            "setup must set pin 14 (A0) to ANALOG mode, got: {:02X?}",
            setup.outbound_bytes
        );
        let report_a0 = FirmataClient::new().encode_report_analog(0, true);
        assert!(
            contains(&setup.outbound_bytes, &report_a0),
            "setup must enable REPORT_ANALOG on channel 0, got: {:02X?}",
            setup.outbound_bytes
        );
        let wrong_channel = FirmataClient::new().encode_report_analog(14, true);
        assert!(
            !contains(&setup.outbound_bytes, &wrong_channel),
            "REPORT_ANALOG must target the channel (0), never the pin (14)"
        );

        // Inbound: a real ANALOG_MESSAGE frame, channel 0 carrying 612.
        let value = 612u16;
        let frame = [0xE0, (value & 0x7F) as u8, (value >> 7) as u8];
        let effects = rt.feed_bytes(&frame);
        assert!(
            effects
                .component_events
                .iter()
                .any(|e| &*e.source == "pot" && e.value == ComponentValue::Number(f64::from(value))),
            "analog frame must surface as the sensor's value event, got: {:?}",
            effects.component_events
        );
    }

    #[test]
    fn update_flow_diff_keeps_unchanged_nodes() {
        use serde_json::json;
        let mut rt = FlowRuntime::new();
        rt.seed_digital_pins(20);
        let led = node("led", "Led", json!({ "instance": "Led", "pin": 13 }));
        let mk = || FlowUpdate { nodes: vec![led.clone()], edges: vec![] };

        rt.update_flow(mk());
        // Re-applying the identical flow rebuilds nothing — no setup bytes the
        // second time (the led isn't re-initialized).
        let second = rt.update_flow(mk());
        assert!(second.outbound_bytes.is_empty(), "unchanged node must not re-initialize");
    }

    /// Regression: digital reporting is per 8-pin PORT, so removing one input
    /// must not disable a port a sibling input still needs. Two buttons on port 0
    /// (pins 2 + 3); dropping pin 3 must NOT emit `REPORT_DIGITAL(port 0, off)`,
    /// or the pin-2 button goes dead — the live "button on pin 2/3 does nothing"
    /// regression after a pin was moved within the same port.
    #[test]
    fn digital_reporting_is_reconciled_per_port_not_per_pin() {
        use serde_json::json;
        let mut rt = FlowRuntime::new();
        rt.seed_digital_pins(20);

        let btn = |id: &str, pin: i64| node(id, "Button", json!({ "instance": "Button", "pin": pin }));

        // Two buttons sharing port 0.
        rt.update_flow(FlowUpdate { nodes: vec![btn("b2", 2), btn("b3", 3)], edges: vec![] });

        // Drop the pin-3 button; pin 2 still listens on port 0.
        let after_drop = rt.update_flow(FlowUpdate { nodes: vec![btn("b2", 2)], edges: vec![] });
        let disable_port0 = FirmataClient::new().encode_report_digital(0, false);
        assert!(
            !contains(&after_drop.outbound_bytes, &disable_port0),
            "removing a sibling pin must not disable a port another pin still needs, got: {:02X?}",
            after_drop.outbound_bytes
        );

        // Sanity: once the last pin on the port goes away, the port IS disabled.
        let after_clear = rt.update_flow(FlowUpdate { nodes: vec![], edges: vec![] });
        assert!(
            contains(&after_clear.outbound_bytes, &disable_port0),
            "the port must be disabled once no pin needs it, got: {:02X?}",
            after_clear.outbound_bytes
        );
    }

    // --- Turn budget -----------------------------------------------------------

    /// Run `test` on a worker thread with a deadline, so a turn that never ends
    /// fails the test instead of hanging the suite. (The runtime is `!Send`, so
    /// the whole test body runs on the worker.)
    fn within_deadline(test: impl FnOnce() + Send + 'static) {
        use std::sync::mpsc::RecvTimeoutError;
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            test();
            let _ = tx.send(());
        });
        match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(()) => {}
            Err(RecvTimeoutError::Timeout) => panic!("the turn never ended: the runtime is still spinning"),
            Err(RecvTimeoutError::Disconnected) => {
                if let Err(panic) = worker.join() {
                    std::panic::resume_unwind(panic);
                }
            }
        }
    }

    /// Two real Gates wired `a.true → b.value`, `b.true → a.value`. A Gate's
    /// `true` Emit always fires, so each dispatch re-triggers the other: before
    /// the turn budget this turn never ended.
    fn gate_ring() -> FlowUpdate {
        use serde_json::json;
        FlowUpdate {
            nodes: vec![
                node("a", "Gate", json!({ "gate": "or" })),
                node("b", "Gate", json!({ "gate": "or" })),
                node("led", "Led", json!({ "pin": 13 })),
            ],
            edges: vec![
                edge("a", "true", "b", "value"),
                edge("b", "true", "a", "value"),
                // Hangs off the loop; must not be blamed for it.
                edge("b", "value", "led", "true"),
            ],
        }
    }

    fn badge<'a>(effects: &'a Effects, node: &str) -> Option<&'a NodeDiagnostic> {
        effects.node_diagnostics.iter().rev().find(|d| d.node == node)
    }

    #[test]
    fn a_runaway_loop_ends_the_turn_and_pauses_the_loop() {
        within_deadline(|| {
            let mut rt = FlowRuntime::new();
            rt.seed_digital_pins(20);
            rt.update_flow(gate_ring());

            let effects = rt.dispatch("a", "value", ComponentValue::Bool(true));

            // The turn returned (within the deadline), and the work it did
            // before the budget still applies: the LED hanging off the loop was
            // driven and its event surfaced.
            let led_on = FirmataClient::new().encode_digital_write(13, true);
            assert!(contains(&effects.outbound_bytes, &led_on), "the LED off the loop must be driven");
            assert!(effects.component_events.iter().any(|e| &*e.source == "b" && &*e.source_handle == "value"));
            // And the loop is attributed.
            for id in ["a", "b"] {
                let d = badge(&effects, id).unwrap_or_else(|| panic!("{id} must carry a badge"));
                assert!(matches!(d.level, DiagnosticLevel::Error));
                assert!(d.message.as_deref().is_some_and(|m| m.contains("loop")), "{d:?}");
            }
            assert!(badge(&effects, "led").is_none(), "a node fed by the loop is not part of it");

            // The runtime is alive, and the paused loop no longer spins: the
            // next stimulus is one short turn with no new diagnostics.
            let again = rt.dispatch("a", "value", ComponentValue::Bool(true));
            assert!(again.component_events.len() < 10, "paused loop re-spun: {}", again.component_events.len());
            assert!(again.node_diagnostics.is_empty());
            let led = rt.dispatch("led", "value", ComponentValue::Bool(true));
            assert!(!led.outbound_bytes.is_empty(), "the rest of the flow keeps running");
        });
    }

    #[test]
    fn a_paused_loop_resumes_only_when_the_loop_changes() {
        within_deadline(|| {
            let mut rt = FlowRuntime::new();
            rt.seed_digital_pins(20);
            rt.update_flow(gate_ring());
            rt.dispatch("a", "value", ComponentValue::Bool(true));

            // An update that leaves the loop as it was (a node dragged, say)
            // keeps it paused: no clear, and no second runaway turn.
            let same = rt.update_flow(gate_ring());
            assert!(same.node_diagnostics.is_empty(), "{:?}", same.node_diagnostics);
            let poke = rt.dispatch("a", "value", ComponentValue::Bool(true));
            assert!(poke.component_events.len() < 10);

            // Cutting the loop releases both nodes and clears their badges.
            let mut cut = gate_ring();
            cut.edges.retain(|e| !(e.source == "b" && e.source_handle == "true"));
            let released = rt.update_flow(cut);
            for id in ["a", "b"] {
                let d = badge(&released, id).unwrap_or_else(|| panic!("{id} must be cleared"));
                assert!(d.message.is_none(), "{d:?}");
            }
            // And the now-acyclic flow routes again.
            let routed = rt.dispatch("a", "value", ComponentValue::Bool(true));
            assert!(routed.component_events.iter().any(|e| &*e.source == "b"), "b must hear a again");
        });
    }

    #[test]
    fn a_long_acyclic_chain_stays_under_the_budget() {
        // 2 000 Gates in a line: 2 events each (`value` + `true`), far deeper
        // than any real flow, still well inside the budget.
        use serde_json::json;
        within_deadline(|| {
            let n = 2_000;
            let id = |i: usize| format!("g{i}");
            let mut rt = FlowRuntime::new();
            rt.update_flow(FlowUpdate {
                nodes: (0..n).map(|i| node(&id(i), "Gate", json!({ "gate": "or" }))).collect(),
                edges: (1..n).map(|i| edge(&id(i - 1), "true", &id(i), "value")).collect(),
            });
            let effects = rt.dispatch("g0", "value", ComponentValue::Bool(true));
            assert!(effects.node_diagnostics.is_empty(), "nothing in a chain is a loop");
            let last = id(n - 1);
            assert!(effects.component_events.iter().any(|e| *e.source == *last && &*e.source_handle == "true"));
        });
    }

    /// 14 Gate diamonds in a row (43 nodes, no cycle): `t{i}` feeds `l{i}` and
    /// `r{i}`, both feed `t{i+1}`. Each Gate fires `true` once per input it
    /// receives, so events double per level and blow the budget.
    fn diamond_chain(levels: usize) -> FlowUpdate {
        use serde_json::json;
        let gate = |id: String| node(&id, "Gate", json!({ "gate": "or" }));
        let mut nodes = vec![gate("t0".into())];
        let mut edges = Vec::new();
        for i in 0..levels {
            let (t, l, r, next) = (format!("t{i}"), format!("l{i}"), format!("r{i}"), format!("t{}", i + 1));
            nodes.extend([gate(l.clone()), gate(r.clone()), gate(next.clone())]);
            edges.extend([
                edge(&t, "true", &l, "value"),
                edge(&t, "true", &r, "value"),
                edge(&l, "true", &next, "value"),
                edge(&r, "true", &next, "value"),
            ]);
        }
        FlowUpdate { nodes, edges }
    }

    #[test]
    fn a_turn_that_runs_long_without_a_loop_warns_and_pauses_nothing() {
        within_deadline(|| {
            let mut rt = FlowRuntime::new();
            rt.update_flow(diamond_chain(14));

            let effects = rt.dispatch("t0", "value", ComponentValue::Bool(true));
            assert!(rt.paused.is_empty(), "an acyclic flow must never be paused as a loop");
            let warned: Vec<_> = effects.node_diagnostics.iter().filter(|d| d.message.is_some()).collect();
            assert_eq!(warned.len(), 1, "{:?}", effects.node_diagnostics);
            assert!(matches!(warned[0].level, DiagnosticLevel::Warning));
            assert!(warned[0].message.as_deref().is_some_and(|m| m.contains("fans out")), "{warned:?}");
            assert!(!warned[0].message.as_deref().is_some_and(|m| m.contains("loop")));

            // Nothing is cut: the first level still routes on the next stimulus.
            let again = rt.dispatch("t0", "value", ComponentValue::Bool(true));
            assert!(again.component_events.iter().any(|e| &*e.source == "l0"));

            // The next flow update clears the warning.
            let updated = rt.update_flow(diamond_chain(14));
            let node = &warned[0].node;
            assert!(badge(&updated, node).is_some_and(|d| d.message.is_none()), "{:?}", updated.node_diagnostics);
        });
    }

    #[test]
    fn a_ring_longer_than_the_trace_tail_is_paused_whole_and_released_by_any_cut() {
        use serde_json::json;
        within_deadline(|| {
            let n = 300;
            let id = |i: usize| format!("g{i}");
            let ring = |cut: Option<usize>| FlowUpdate {
                nodes: (0..n).map(|i| node(&id(i), "Gate", json!({ "gate": "or" }))).collect(),
                edges: (0..n)
                    .filter(|&i| Some(i) != cut)
                    .map(|i| edge(&id(i), "true", &id((i + 1) % n), "value"))
                    .collect(),
            };
            let mut rt = FlowRuntime::new();
            rt.update_flow(ring(None));

            let tripped = rt.dispatch("g0", "value", ComponentValue::Bool(true));
            assert_eq!(rt.paused.len(), n, "the whole ring is the loop, not only the traced tail");
            assert_eq!(tripped.node_diagnostics.iter().filter(|d| d.message.is_some()).count(), n);

            // Cut far from where the budget ran out: every node is released.
            let released = rt.update_flow(ring(Some(250)));
            assert!(rt.paused.is_empty());
            assert_eq!(released.node_diagnostics.iter().filter(|d| d.message.is_none()).count(), n);

            // And the now-open chain runs to its end without tripping.
            let routed = rt.dispatch("g0", "value", ComponentValue::Bool(true));
            assert!(routed.node_diagnostics.is_empty());
            assert!(routed.component_events.iter().any(|e| &*e.source == "g250"));
        });
    }

    // --- Node health ---------------------------------------------------------

    #[test]
    fn a_node_whose_config_does_not_deserialize_carries_a_badge_until_fixed() {
        use serde_json::json;
        let mut rt = FlowRuntime::new();
        let broken = rt.update_flow(FlowUpdate {
            nodes: vec![node("g", "Gate", json!({ "gate": "maybe" }))],
            edges: vec![],
        });
        let d = badge(&broken, "g").expect("a node that did not build must say so");
        assert!(matches!(d.level, DiagnosticLevel::Error));
        assert!(d.message.as_deref().is_some_and(|m| m.starts_with("Not running")), "{d:?}");

        // Re-sent unchanged (every update retries the build): no repeat badge.
        let retry = rt.update_flow(FlowUpdate {
            nodes: vec![node("g", "Gate", json!({ "gate": "maybe" }))],
            edges: vec![],
        });
        assert!(retry.node_diagnostics.is_empty());

        let fixed = rt.update_flow(FlowUpdate {
            nodes: vec![node("g", "Gate", json!({ "gate": "and" }))],
            edges: vec![],
        });
        assert!(badge(&fixed, "g").is_some_and(|d| d.message.is_none()), "building clears the badge");
    }

    #[test]
    fn an_unknown_node_type_carries_a_badge_cleared_when_it_leaves_the_flow() {
        use serde_json::json;
        let mut rt = FlowRuntime::new();
        let unknown = rt.update_flow(FlowUpdate { nodes: vec![node("x", "Teleporter", json!({}))], edges: vec![] });
        let d = badge(&unknown, "x").expect("an unknown type must be attributed");
        assert!(d.message.as_deref().is_some_and(|m| m.contains("Teleporter")), "{d:?}");

        // It never built, so it is not a component — removal must still clear.
        let gone = rt.update_flow(FlowUpdate { nodes: vec![], edges: vec![] });
        assert!(badge(&gone, "x").is_some_and(|d| d.message.is_none()));
    }

    /// A node whose start fails when `data.fail` is true, and which raises its
    /// own warning on start when `data.own` is true.
    struct FailingStart {
        base: ComponentBase,
        fail: bool,
        own: bool,
    }
    impl Component for FailingStart {
        fn base(&self) -> &ComponentBase { &self.base }
        fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
        fn component_type(&self) -> &'static str { "FailingStart" }
        fn dispatch(&mut self, _m: &str, _a: ComponentValue, _c: &mut RuntimeContext) -> Result<(), RuntimeError> { Ok(()) }
        fn on_start(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
            if self.own {
                ctx.report_diagnostic(DiagnosticLevel::Warning, "own");
            }
            if self.fail { Err(RuntimeError::ComponentError("no".into())) } else { Ok(()) }
        }
    }

    fn runtime_with_failing_start() -> FlowRuntime {
        let mut rt = FlowRuntime::new();
        rt.registry.register_test_factory(
            "FailingStart",
            Box::new(|id, data| {
                let flag = |key: &str| data.get(key).and_then(serde_json::Value::as_bool).unwrap_or(false);
                Ok(Box::new(FailingStart {
                    base: ComponentBase::new(id, ComponentValue::default()),
                    fail: flag("fail"),
                    own: flag("own"),
                }))
            }),
        );
        rt
    }

    #[test]
    fn a_node_whose_start_fails_carries_a_badge_until_it_rebuilds_fine() {
        use serde_json::json;
        let mut rt = runtime_with_failing_start();
        let failed = rt.update_flow(FlowUpdate {
            nodes: vec![node("s", "FailingStart", json!({ "fail": true }))],
            edges: vec![],
        });
        let d = badge(&failed, "s").expect("a failed start must be attributed");
        assert!(d.message.as_deref().is_some_and(|m| m.contains("Failed to start")), "{d:?}");

        let fine = rt.update_flow(FlowUpdate {
            nodes: vec![node("s", "FailingStart", json!({ "fail": false }))],
            edges: vec![],
        });
        assert!(badge(&fine, "s").is_some_and(|d| d.message.is_none()));
    }

    #[test]
    fn a_rejected_input_warns_once_and_clears_when_its_edge_is_removed() {
        use serde_json::json;
        let mut rt = FlowRuntime::new();
        // An edge into a handle the Gate does not have (a dangling handle).
        let flow = |edges| FlowUpdate {
            nodes: vec![
                node("src", "Gate", json!({ "gate": "or" })),
                node("g", "Gate", json!({ "gate": "or" })),
            ],
            edges,
        };
        rt.update_flow(flow(vec![edge("src", "true", "g", "nope")]));

        let first = rt.dispatch("src", "value", ComponentValue::Bool(true));
        let d = badge(&first, "g").expect("a rejected input must be attributed");
        assert!(matches!(d.level, DiagnosticLevel::Warning));
        assert!(d.message.as_deref().is_some_and(|m| m.contains("\"nope\"")), "{d:?}");

        let second = rt.dispatch("src", "value", ComponentValue::Bool(true));
        assert!(second.node_diagnostics.is_empty(), "the same rejection must not spam");

        let fixed = rt.update_flow(flow(vec![edge("src", "true", "g", "value")]));
        assert!(badge(&fixed, "g").is_some_and(|d| d.message.is_none()), "removing the bad edge clears it");
    }

    #[test]
    fn edges_to_nodes_not_in_the_flow_are_dropped() {
        use serde_json::json;
        let mut rt = FlowRuntime::new();
        let effects = rt.update_flow(FlowUpdate {
            nodes: vec![node("a", "Gate", json!({ "gate": "or" }))],
            edges: vec![edge("a", "true", "ghost", "value"), edge("ghost", "true", "a", "value")],
        });
        assert!(rt.router.edges().is_empty(), "dangling edges must not reach the router");
        assert!(effects.node_diagnostics.is_empty(), "the user cannot see or delete them, so no badge");
    }

    #[test]
    fn node_and_runtime_diagnostics_carry_their_origin_and_clear_only_their_own() {
        // The review scenario: an I2C device reports its own NACK error, a bad
        // edge makes the runtime warn about a rejected input on the same node,
        // and deleting the edge clears the runtime's warning. That clear is
        // tagged `Runtime`, so it cannot wipe the node's NACK — which the device
        // will never re-raise while it stays faulted.
        use crate::firmata::{END_SYSEX, I2C_REPLY, START_SYSEX};
        use serde_json::json;
        let mut rt = FlowRuntime::new();
        rt.seed_digital_pins(20);
        let flow = |edges| FlowUpdate {
            nodes: vec![
                node("src", "Gate", json!({ "gate": "or" })),
                node(
                    "tcs",
                    "I2cDevice",
                    json!({ "device": "tcs34725", "address": 0x29, "register": 0xB4, "readLength": 8, "output": "raw" }),
                ),
            ],
            edges,
        };
        rt.update_flow(flow(vec![edge("src", "true", "tcs", "nope")]));

        let nack = rt.feed_bytes(&[START_SYSEX, I2C_REPLY, 0x29, 0, 0x34, 0x01, END_SYSEX]);
        let own = badge(&nack, "tcs").expect("the device reports its NACK");
        assert_eq!(own.origin, DiagnosticOrigin::Node);
        assert!(matches!(own.level, DiagnosticLevel::Error));

        let rejected = rt.dispatch("src", "value", ComponentValue::Bool(true));
        let warn = badge(&rejected, "tcs").expect("the runtime reports the rejected input");
        assert_eq!(warn.origin, DiagnosticOrigin::Runtime);
        assert!(matches!(warn.level, DiagnosticLevel::Warning));

        let fixed = rt.update_flow(flow(vec![]));
        let clears: Vec<_> = fixed.node_diagnostics.iter().filter(|d| d.node == "tcs").collect();
        assert_eq!(clears.len(), 1, "{clears:?}");
        assert!(clears[0].message.is_none());
        assert_eq!(clears[0].origin, DiagnosticOrigin::Runtime, "the runtime clears only its own");
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
    }

    impl FlowRuntime {
        /// Test helper: give the codec `n` plain digital pins so inbound digital
        /// messages have a pin table to land in.
        fn seed_digital_pins(&mut self, n: usize) {
            let caps = vec![crate::firmata::PinCaps::default(); n];
            self.client.set_profile(crate::firmata::PinProfile::new(caps));
        }

        /// Test helper: mark a seeded pin as analog (channels numbered in pin
        /// order) so analog reporting encodes.
        fn mark_pin_analog(&mut self, pin: usize) {
            let mut infos = self.client.profile.pin_infos();
            let Some(info) = infos.get_mut(pin) else { return };
            info.analog_channel = 0;
            let mut channel = 0;
            for info in &mut infos {
                if info.analog_channel >= 0 {
                    info.analog_channel = channel;
                    channel += 1;
                }
            }
            self.client.profile = crate::firmata::PinProfile::from_pin_infos(&infos);
        }
    }
}
