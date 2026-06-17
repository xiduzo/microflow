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
pub mod pin_mode;
pub mod registry;
pub mod router;
pub mod serde_utils;
pub mod value;
pub mod wiring;

// Component node categories. `cloud` (external/) lands behind the feature gate.
pub mod control;
pub mod generator;
pub mod input;
pub mod output;
pub mod transformation;

pub use board::{BoardWriter, BufferBoardWriter};
pub use component::{Component, ComponentBase, ComponentBuilder, EventSink, HardwareComponent};
pub use context::{Effects, RuntimeContext, ScheduleRequests, Wakeup, WakeupId};
pub use error::{HardwareError, RuntimeError};
pub use registry::ComponentRegistry;
pub use router::{ComponentLookup, DispatchCall, EdgeTarget, FlowRouter};
pub use value::{ComponentEvent, ComponentValue, PinConfig};
pub use wiring::{ListenerWiring, SubscriberWiring};

#[cfg(feature = "cloud")]
pub use error::MqttError;

use crate::firmata::FirmataClient;
use crate::flow::{FlowEdge, FlowNode, FlowUpdate};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

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
    i2c_listeners: HashMap<u8, Vec<Arc<str>>>,
    /// Hotkey accelerator (lowercased) → listening component ids.
    key_listeners: HashMap<String, Vec<Arc<str>>>,
    /// Monotonic id source for wakeups handed to the host.
    next_wakeup_id: WakeupId,
    /// Outstanding wakeups keyed by `(node_id, method)` so a re-schedule or
    /// cancel can target the right host timer.
    outstanding: HashMap<(String, String), WakeupId>,
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
        }
    }

    /// Advance the host clock. Timer nodes read this via `RuntimeContext::now_ms`.
    pub fn set_now(&mut self, ms: f64) {
        self.now_ms = ms;
    }

    /// Seed the codec's pin table from the connection handshake's discovered
    /// capabilities (`[{ "pin", "analogChannel" }]`, the `FirmataSession.pinsJson`
    /// shape). The browser's detection session consumes the capability response
    /// before the runtime attaches, so without this the runtime's pin table is
    /// empty and inbound digital/analog messages have nowhere to land. Only the
    /// pin count + analog flag matter to the runtime (change detection + analog
    /// channel math); modes are not used.
    ///
    /// # Errors
    /// Returns the parse error if `pins_json` is not the expected array shape.
    pub fn seed_pins(&mut self, pins_json: &str) -> Result<(), serde_json::Error> {
        #[derive(serde::Deserialize)]
        struct PinInfo {
            pin: usize,
            #[serde(rename = "analogChannel")]
            analog_channel: i32,
        }
        let infos: Vec<PinInfo> = serde_json::from_str(pins_json)?;
        let len = infos.iter().map(|p| p.pin + 1).max().unwrap_or(0);
        let mut pins = vec![crate::firmata::Pin::default(); len];
        for info in infos {
            if let Some(pin) = pins.get_mut(info.pin) {
                pin.analog = info.analog_channel >= 0;
            }
        }
        self.client.pins = pins;
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

        // 2. Destroy removed / replaced.
        for id in &removed {
            self.remove_component(id);
            self.node_data.remove(id);
        }

        // 3. Build added / replaced.
        for node in &to_add {
            let instance = node_instance(node);
            match self.registry.create(&node.id, instance, &node.data) {
                Ok(component) => {
                    self.add_component(&node.id, component);
                    self.node_data.insert(node.id.clone(), node.data.clone());
                }
                Err(RuntimeError::ComponentNotFound(_)) => {
                    log::warn!("skipping unknown component {} ({instance})", node.id);
                }
                Err(e) => log::warn!("failed to build component {}: {e}", node.id),
            }
        }

        // 4. Recompute the wiring tables from every active component.
        let mut pin_listeners: HashMap<u8, Vec<Arc<str>>> = HashMap::new();
        let mut i2c_listeners: HashMap<u8, Vec<Arc<str>>> = HashMap::new();
        let mut key_listeners: HashMap<String, Vec<Arc<str>>> = HashMap::new();
        let mut report: HashMap<u8, bool> = HashMap::new();
        for (id, component) in &self.components {
            for wiring in component.listener_wiring() {
                match wiring {
                    ListenerWiring::DigitalPin { pin } => {
                        pin_listeners.entry(pin).or_default().push(Arc::from(id.as_str()));
                        report.insert(pin, false);
                    }
                    ListenerWiring::AnalogPin { pin, .. } => {
                        pin_listeners.entry(pin).or_default().push(Arc::from(id.as_str()));
                        report.insert(pin, true);
                    }
                    ListenerWiring::I2cAddress { address } => {
                        i2c_listeners.entry(address).or_default().push(Arc::from(id.as_str()));
                    }
                    // Hotkeys are delivered by the host (keyboard) via
                    // `dispatch_key_event`, not the board.
                    ListenerWiring::HotKey { accelerator } => {
                        key_listeners.entry(accelerator).or_default().push(Arc::from(id.as_str()));
                    }
                }
            }
        }

        // 5. Reconcile reporting against the wire. Analog reporting is keyed per
        //    channel (one per analog pin); digital reporting is per 8-pin PORT —
        //    `REPORT_DIGITAL(port)` covers pins `port*8 ..= port*8 + 7`. Digital
        //    must therefore be reconciled at PORT granularity: a port stays
        //    enabled while *any* listened pin maps to it. Reconciling digital per
        //    pin disabled the whole port when one sibling pin vanished, silently
        //    killing the other inputs on it (observed as a button going dead after
        //    its pin was moved within port 0). Bytes accumulate into `out`.
        {
            let mut writer = BufferBoardWriter::new(&mut self.client, &mut out);

            // Analog: independent per channel — enable newly-needed, disable gone.
            for (&pin, &is_analog) in &report {
                if is_analog && !self.report_set.contains_key(&pin) {
                    // A failure here (pin not flagged analog in the seeded table)
                    // means the board will never stream this pin — surface it; a
                    // silent drop here cost a full debugging session.
                    if let Err(e) = writer.enable_analog_reporting(pin) {
                        log::warn!("enable analog reporting failed for pin {pin}: {e}");
                    }
                }
            }
            for (&pin, &is_analog) in &self.report_set {
                if is_analog && !report.contains_key(&pin) {
                    let _ = writer.disable_analog_reporting(pin);
                }
            }

            // Digital: per port — a port is needed while any digital pin maps to it.
            let digital_ports = |set: &HashMap<u8, bool>| -> HashSet<u8> {
                set.iter()
                    .filter(|(_, &is_analog)| !is_analog)
                    .map(|(&pin, _)| pin / 8)
                    .collect()
            };
            let needed_ports = digital_ports(&report);
            let prev_ports = digital_ports(&self.report_set);
            for &port in needed_ports.difference(&prev_ports) {
                // `enable_digital_reporting` keys off `pin / 8`; the port's first
                // pin (`port * 8`) selects exactly that port.
                if let Err(e) = writer.enable_digital_reporting(port * 8) {
                    log::warn!("enable digital reporting failed for port {port}: {e}");
                }
            }
            for &port in prev_ports.difference(&needed_ports) {
                let _ = writer.disable_digital_reporting(port * 8);
            }
        }

        self.active_pins = report.keys().copied().collect();
        self.pin_values.retain(|pin, _| report.contains_key(pin));
        self.pin_listeners = pin_listeners;
        self.i2c_listeners = i2c_listeners;
        self.key_listeners = key_listeners;
        self.report_set = report;

        // 6. Initialize newly-built hardware (pin modes + initial output state).
        let added_ids: Vec<String> = to_add.iter().map(|n| n.id.clone()).collect();
        for id in &added_ids {
            let mut writer = BufferBoardWriter::new(&mut self.client, &mut out);
            let mut ctx = RuntimeContext::new(&mut writer, self.now_ms, id.as_str(), &mut reqs);
            if let Some(component) = self.components.get_mut(id) {
                if let Some(hw) = component.as_hardware_mut() {
                    if let Err(e) = hw.initialize(&mut ctx) {
                        log::warn!("initialize {id} failed: {e}");
                    }
                }
                if let Err(e) = component.on_start(&mut ctx) {
                    log::warn!("on_start {id} failed: {e}");
                }
            }
        }

        // 7. Rebuild edges, then drain any init-time emissions.
        self.router.set_edges(edges);
        self.finish(out, reqs)
    }

    /// Feed raw inbound serial bytes: decode via the codec, diff the pin table,
    /// resolve listeners, stamp the live sequence, and drain the cascade.
    pub fn feed_bytes(&mut self, bytes: &[u8]) -> Effects {
        self.client.feed(bytes);
        self.detect_pin_changes();
        self.drain_i2c_replies();
        self.finish(Vec::new(), ScheduleRequests::default())
    }

    /// A host timer fired: deliver `method` to `node_id` as an internal event
    /// (e.g. `_tick`). The outstanding entry is cleared first so the node may
    /// re-schedule from within its handler.
    pub fn wake(&mut self, node_id: &str, method: &str) -> Effects {
        self.outstanding.remove(&(node_id.to_string(), method.to_string()));
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
        self.process_event(event, &mut out, &mut reqs);
        self.finish(out, reqs)
    }

    /// Inject an external call at a component's input (the `component_call`
    /// equivalent): dispatch directly, then drain the cascade.
    pub fn dispatch(&mut self, id: &str, method: &str, value: ComponentValue) -> Effects {
        let mut out = Vec::new();
        let mut reqs = ScheduleRequests::default();
        self.dispatch_to(id, method, value, &mut out, &mut reqs);
        self.finish(out, reqs)
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

    /// Register a component as a listener for an I2C address's replies.
    pub fn register_i2c_listener(&mut self, address: u8, component_id: &str) {
        self.i2c_listeners
            .entry(address)
            .or_default()
            .push(Arc::from(component_id));
    }

    /// Set the current flow sequence (used by the desktop host + tests to drive
    /// stale-gating directly).
    pub fn set_sequence(&mut self, sequence: u64) {
        self.current_sequence = sequence;
    }

    /// Register an externally-built component factory (host-provided nodes — the
    /// desktop injects its cloud nodes this way, keeping their async/network
    /// impls and dependencies out of core). See
    /// [`ComponentRegistry::register_factory`].
    pub fn register_node(&mut self, name: &str, factory: registry::Factory) {
        self.registry.register_factory(name, factory);
    }

    /// Deliver an inbound external message (MQTT / Figma broker payload) to a
    /// subscribe component by id; it updates + emits, then the cascade drains.
    pub fn deliver_message(&mut self, component_id: &str, topic: &str, payload: &[u8]) -> Effects {
        if let Some(component) = self.components.get_mut(component_id) {
            component.receive_raw_message(topic, payload);
        }
        self.finish(Vec::new(), ScheduleRequests::default())
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
        self.finish(Vec::new(), ScheduleRequests::default())
    }

    /// Deliver a hotkey press to every component listening on `accelerator`
    /// (matched lowercased), then drain the cascade.
    pub fn dispatch_key_event(&mut self, accelerator: &str) -> Effects {
        let ids = self
            .key_listeners
            .get(&accelerator.to_lowercase())
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::new();
        let mut reqs = ScheduleRequests::default();
        for id in ids {
            self.dispatch_to(id.as_ref(), "key_event", ComponentValue::Bool(true), &mut out, &mut reqs);
        }
        self.finish(out, reqs)
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

    // --- Inbound decode ------------------------------------------------------

    /// Diff the codec's pin table against the last-seen values and push a
    /// seq-stamped `_pin_change` event per listening component. Ported from the
    /// desktop `BoardConnection::detect_and_emit_changes`.
    fn detect_pin_changes(&mut self) {
        let scan_all = self.active_pins.is_empty();
        let indices: Vec<usize> = if scan_all {
            (0..self.client.pins.len()).collect()
        } else {
            self.active_pins.iter().map(|&p| p as usize).collect()
        };

        let mut changes: Vec<(u8, u16, bool)> = Vec::new();
        for index in indices {
            let Some(pin) = self.client.pins.get(index) else { continue };
            let pin_num = index as u8;
            let current = pin.value as u16;
            let is_analog = pin.analog;

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
                    source_handle: Arc::from("_pin_change"),
                    value: value.clone(),
                    edge_id: None,
                    sequence: self.current_sequence,
                });
            }
        }
    }

    /// Drain decoded I2C replies into seq-stamped `_i2c_reply` events.
    fn drain_i2c_replies(&mut self) {
        if self.client.i2c_data.is_empty() {
            return;
        }
        let replies: Vec<_> = self.client.i2c_data.drain(..).collect();
        for reply in replies {
            let address = reply.address as u8;
            let Some(listeners) = self.i2c_listeners.get(&address) else { continue };
            let data: Vec<ComponentValue> = reply
                .data
                .iter()
                .map(|&b| ComponentValue::Number(f64::from(b)))
                .collect();
            for component_id in listeners {
                self.sink.borrow_mut().push_back(ComponentEvent {
                    source: Arc::clone(component_id),
                    source_handle: Arc::from("_i2c_reply"),
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
    fn finish(&mut self, mut out: Vec<u8>, mut reqs: ScheduleRequests) -> Effects {
        let mut events = Vec::new();
        loop {
            // Pop in its own scope so a component is free to push during dispatch.
            let next = self.sink.borrow_mut().pop_front();
            let Some(event) = next else { break };
            // Internal/hardware events (`_`-prefixed) are runtime plumbing the
            // UI never renders — keep them out of `component_events`.
            if !event.source_handle.starts_with('_') {
                events.push(event.clone());
            }
            self.process_event(event, &mut out, &mut reqs);
        }
        let (wakeups, cancellations) = self.resolve_schedule(reqs);
        Effects { outbound_bytes: out, component_events: events, wakeups, cancellations }
    }

    /// Gate stale events, branch internal/hardware callbacks, echo `set_value`
    /// on the source, route, and dispatch. Ported from the desktop
    /// `FlowExecutor::process_event`.
    fn process_event(&mut self, event: ComponentEvent, out: &mut Vec<u8>, reqs: &mut ScheduleRequests) {
        // Stale-event gate. sequence == 0 means "unsequenced" (component logic,
        // never stale). Only drop events carrying a non-zero sequence older than
        // the current flow version (leftover board events from an old flow).
        if event.sequence > 0 && event.sequence < self.current_sequence {
            return;
        }

        // Internal-event branch (underscore-prefixed handle): hardware callbacks
        // (`_pin_change`/`_i2c_reply`) → typed methods, other `_method` →
        // `dispatch_internal`. Never flows through the router (source == target).
        if event.source_handle.starts_with('_') {
            self.dispatch_internal_event(&event, out, reqs);
            return;
        }

        // Echo `set_value` on the source so a subsequent snapshot delivery
        // (aggregating target) reads the just-emitted value, not stale state.
        if let Some(component) = self.components.get_mut(event.source.as_ref()) {
            component.set_value(event.value.clone());
        }

        let plan = {
            let lookup = ComponentMapLookup { components: &self.components };
            self.router.route(&event, &lookup)
        };
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
        if let Some(component) = self.components.get_mut(id) {
            let mut writer = BufferBoardWriter::new(&mut self.client, out);
            let mut ctx = RuntimeContext::new(&mut writer, self.now_ms, id, reqs);
            if let Err(e) = component.dispatch(method, value, &mut ctx) {
                log::warn!("dispatch {id}.{method} failed: {e}");
            }
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
        if let Some(component) = self.components.get_mut(id.as_ref()) {
            let mut writer = BufferBoardWriter::new(&mut self.client, out);
            let mut ctx = RuntimeContext::new(&mut writer, self.now_ms, id.as_ref(), reqs);
            let result = match handle.as_ref() {
                "_pin_change" => component
                    .as_hardware_mut()
                    .map_or(Ok(()), |hw| hw.on_pin_change(event.value.clone(), &mut ctx)),
                "_i2c_reply" => component
                    .as_hardware_mut()
                    .map_or(Ok(()), |hw| hw.on_i2c_reply(event.value.clone(), &mut ctx)),
                other => component.dispatch_internal(&other[1..], event.value.clone(), &mut ctx),
            };
            if let Err(e) = result {
                log::warn!("internal {id}.{handle} failed: {e}");
            }
        }
    }

    /// Resolve a turn's [`ScheduleRequests`] into host-facing wakeups and the
    /// ids of any timers that are no longer wanted. A re-schedule of an
    /// outstanding `(node, method)` cancels the prior timer first.
    fn resolve_schedule(&mut self, reqs: ScheduleRequests) -> (Vec<Wakeup>, Vec<WakeupId>) {
        let mut wakeups = Vec::new();
        let mut cancellations = Vec::new();
        for (node, method) in reqs.cancels {
            if let Some(id) = self.outstanding.remove(&(node, method)) {
                cancellations.push(id);
            }
        }
        for (node, method, delay_ms) in reqs.schedules {
            if let Some(old) = self.outstanding.remove(&(node.clone(), method.clone())) {
                cancellations.push(old);
            }
            let id = self.next_wakeup_id;
            self.next_wakeup_id += 1;
            self.outstanding.insert((node.clone(), method.clone()), id);
            wakeups.push(Wakeup { id, node_id: node, method, delay_ms });
        }
        (wakeups, cancellations)
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
            source_handle: Arc::from("_pin_change"),
            value: ComponentValue::Bool(true),
            edge_id: None,
            sequence: 3,
        });
        let effects = rt.finish(Vec::new(), ScheduleRequests::default());
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
            source_handle: Arc::from("_pin_change"),
            value: ComponentValue::Number(500.0),
            edge_id: None,
            sequence: rt.current_sequence,
        });
        let effects = rt.finish(Vec::new(), ScheduleRequests::default());

        let led_on = FirmataClient::new().encode_digital_write(13, true);
        assert!(contains(&effects.outbound_bytes, &led_on), "sensor>0 should light the led via the gate");
    }

    /// The full hardware-faithful analog loop on an Uno-shaped board: seed the
    /// exact pin-table JSON the desktop detection / web session hand over
    /// (`analogChannel >= 0` marks A0..A5 = pins 14..19), apply a flow holding a
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
                    "analogChannel": if p >= 14 { p } else { -1 },
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

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
    }

    impl FlowRuntime {
        /// Test helper: give the codec `n` plain digital pins so inbound digital
        /// messages have a pin table to land in.
        fn seed_digital_pins(&mut self, n: usize) {
            self.client.pins = (0..n)
                .map(|_| crate::firmata::Pin { analog: false, value: 0, ..Default::default() })
                .collect();
        }

        /// Test helper: mark a seeded pin as analog so analog reporting encodes.
        fn mark_pin_analog(&mut self, pin: usize) {
            if let Some(p) = self.client.pins.get_mut(pin) {
                p.analog = true;
            }
        }
    }
}
