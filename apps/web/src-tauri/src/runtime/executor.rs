//! Flow Executor
//!
//! Drives one flow graph: owns the components and a [`FlowRouter`].
//! `process_event` is the pump — it gates stale events, branches
//! internal/hardware callbacks, echoes `set_value` on the source, asks
//! the router for the `DispatchCall` plan, and invokes each call.
//!
//! Routing logic (edge index, fanout, snapshot delivery for aggregating
//! targets) lives in [`super::router`]. See `CONTEXT.md` § `FlowRouter`
//! and `docs/adr/0002-flow-router-seam.md`.

use super::base::{BoardHandle, Component, ComponentEvent, ComponentValue};
use super::router::{ComponentLookup, FlowRouter};
use super::types::FlowEdge;
use crate::error::RuntimeError;
use std::collections::HashMap;
use std::sync::Arc;

/// Executes flow graphs by managing components and routing events.
///
/// Holds a map of components keyed by ID and a [`FlowRouter`] for fanout.
/// Stale events from previous flow versions are filtered by sequence number.
pub struct FlowExecutor {
    components: HashMap<String, Box<dyn Component>>,
    /// Snapshot of each component's node data at creation time, used for
    /// diff-based flow updates to detect when a node's config changed even
    /// though its component type stayed the same (e.g. Piezo buzz → song).
    node_data: HashMap<String, serde_json::Value>,
    router: FlowRouter,
    /// Current flow sequence for filtering stale events
    current_sequence: u64,
}

/// Adapter that lets [`FlowRouter`] read the executor's component map
/// without seeing its shape. Lives just for the scope of one `route` call.
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

impl FlowExecutor {
    #[must_use]
    pub fn new() -> Self {
        Self {
            components: HashMap::new(),
            node_data: HashMap::new(),
            router: FlowRouter::new(),
            current_sequence: 0,
        }
    }

    /// Set the current flow sequence for stale event filtering
    /// Events with sequence < `current_sequence` will be discarded
    pub fn set_current_sequence(&mut self, sequence: u64) {
        self.current_sequence = sequence;
        log::debug!("FlowExecutor sequence updated to {sequence}");
    }

    /// Get the current flow sequence
    #[allow(dead_code)]
    #[must_use]
    pub fn current_sequence(&self) -> u64 {
        self.current_sequence
    }

    /// Add a component to the executor
    pub fn add_component(&mut self, id: &str, component: Box<dyn Component>, data: serde_json::Value) {
        self.components.insert(id.to_string(), component);
        self.node_data.insert(id.to_string(), data);
    }

    /// Get the stored node data for a component (used for diff comparison)
    #[must_use]
    pub fn get_node_data(&self, id: &str) -> Option<&serde_json::Value> {
        self.node_data.get(id)
    }

    /// Remove a component
    #[allow(dead_code)]
    pub fn remove_component(&mut self, id: &str) -> Option<Box<dyn Component>> {
        self.node_data.remove(id);
        if let Some(mut component) = self.components.remove(id) {
            component.destroy();
            Some(component)
        } else {
            None
        }
    }

    /// Clear all components and edges
    pub fn clear(&mut self) {
        for (_, mut component) in self.components.drain() {
            component.destroy();
        }
        self.node_data.clear();
        self.router.clear();
    }

    /// Replace the edge set for the flow.
    pub fn set_edges(&mut self, edges: Vec<FlowEdge>) {
        self.router.set_edges(edges);
    }

    /// Initialize every hardware-bound component now that the board is connected.
    /// Software components return `None` from `Component::as_hardware_mut` and are
    /// skipped entirely — no dead-weight no-op call.
    pub fn initialize_all(&mut self, board_handle: Arc<BoardHandle>) -> Result<(), RuntimeError> {
        let mut errors = Vec::new();

        for (id, component) in &mut self.components {
            if let Some(hw) = component.as_hardware_mut() {
                if let Err(e) = hw.initialize(board_handle.clone()) {
                    errors.push(format!("{id}: {e}"));
                }
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(RuntimeError::Hardware(crate::error::HardwareError::FirmataCommunication(
                format!("Failed to initialize components: {}", errors.join(", "))
            )))
        }
    }

    /// Process an event from a component and propagate to connected components.
    /// Returns true if the event was processed, false if it was discarded as stale.
    pub fn process_event(&mut self, event: ComponentEvent) -> bool {
        log::trace!("process_event: {} ({}) seq={}", event.source, event.source_handle, event.sequence);

        // Stale-event gate. sequence == 0 means "unsequenced" (emitted by component
        // logic, not the board reader callback). These are never stale — they are
        // produced in direct response to an already-validated event and must always
        // be processed. Only filter events that carry an explicit, non-zero sequence
        // that predates the current flow version (i.e. leftover board-reader events
        // from the old flow).
        if event.sequence > 0 && event.sequence < self.current_sequence {
            log::debug!(
                "Discarding stale event from {} (seq={}, current={})",
                event.source, event.sequence, self.current_sequence
            );
            return false;
        }

        // Internal-event branch (underscore-prefixed source_handle). Two flavors:
        // - **Hardware Callback** (`_pin_change`, `_i2c_reply`) — emitted by the
        //   pin-change / I2C-reply callbacks in `runtime/mod.rs`. Routed to the
        //   typed `HardwareComponent::on_pin_change` / `on_i2c_reply` methods so
        //   hardware impls don't have to string-match these in `dispatch`.
        // - **Internal Event** (e.g. `_auto_stop` from Piezo) — self-routed
        //   method a component schedules for itself. Routed to
        //   `Component::dispatch_internal` so the namespace is separate from
        //   edge-input Ports.
        // Never flows through `FlowRouter` — source == target by construction.
        // See `CONTEXT.md` § Hardware Callback, § Internal Event.
        if event.source_handle.starts_with('_') {
            return self.dispatch_internal_event(event);
        }

        // Echo `set_value` on the source so a subsequent snapshot delivery
        // (aggregating target) reads the just-emitted value instead of stale
        // state. Load-bearing for `FlowRouter::route` when any target on this
        // edge returns `aggregates_inputs() == true`.
        if let Some(component) = self.components.get_mut(event.source.as_ref()) {
            component.set_value(event.value.clone());
        }

        let plan = {
            let lookup = ComponentMapLookup { components: &self.components };
            self.router.route(&event, &lookup)
        };

        log::trace!(
            "Routing event: {} ({}) → {} call(s)",
            event.source, event.source_handle, plan.len()
        );

        for call in plan {
            log::trace!("Routing to {}.{}", call.target_id, call.target_handle);
            if let Some(component) = self.components.get_mut(call.target_id.as_ref()) {
                match component.dispatch(&call.target_handle, call.args) {
                    Ok(()) => log::trace!("✓ {}.{}", call.target_id, call.target_handle),
                    Err(e) => log::warn!("✗ Failed to call {}.{}: {}", call.target_id, call.target_handle, e),
                }
            } else {
                log::warn!("Target component {} not found!", call.target_id);
            }
        }

        true
    }

    fn dispatch_internal_event(&mut self, event: ComponentEvent) -> bool {
        log::trace!("Internal event: {} ({})", event.source, event.source_handle);
        if let Some(component) = self.components.get_mut(event.source.as_ref()) {
            let handle = event.source_handle.as_ref();
            let result = match handle {
                "_pin_change" => component
                    .as_hardware_mut()
                    .map_or(Ok(()), |hw| hw.on_pin_change(event.value)),
                "_i2c_reply" => component
                    .as_hardware_mut()
                    .map_or(Ok(()), |hw| hw.on_i2c_reply(event.value)),
                _ => {
                    let method = &handle[1..];
                    component.dispatch_internal(method, event.value)
                }
            };
            match result {
                Ok(()) => log::trace!("✓ Internal call {}.{}", event.source, handle),
                Err(e) => log::warn!("✗ Internal call {}.{} failed: {}", event.source, handle, e),
            }
        }
        true
    }

    /// Get a component by ID
    #[allow(dead_code)]
    #[must_use]
    pub fn get_component(&self, id: &str) -> Option<&dyn Component> {
        self.components.get(id).map(std::convert::AsRef::as_ref)
    }

    /// Get a mutable component by ID
    pub fn get_component_mut(&mut self, id: &str) -> Option<&mut Box<dyn Component>> {
        self.components.get_mut(id)
    }

    /// Get all component IDs
    #[must_use]
    pub fn component_ids(&self) -> Vec<&str> {
        self.components.keys().map(std::string::String::as_str).collect()
    }

    /// Get the value of a component
    #[allow(dead_code)]
    #[must_use]
    pub fn get_value(&self, id: &str) -> Option<ComponentValue> {
        self.components.get(id).map(|c| c.value())
    }

    /// Route a topic-aware MQTT message to a Figma component
    pub fn route_figma_message(&mut self, component_id: &str, topic: &str, payload: &[u8]) {
        if let Some(component) = self.components.get_mut(component_id) {
            component.receive_raw_message(topic, payload);
        }
    }

    /// Route an MQTT message to the appropriate subscribe component
    pub fn route_mqtt_message(&mut self, component_id: &str, payload: &[u8]) {
        if let Some(component) = self.components.get_mut(component_id) {
            // Convert payload to string and call the component
            let value = String::from_utf8_lossy(payload).to_string();
            let component_value = if let Ok(num) = value.parse::<f64>() {
                ComponentValue::Number(num)
            } else if value == "true" {
                ComponentValue::Bool(true)
            } else if value == "false" {
                ComponentValue::Bool(false)
            } else {
                ComponentValue::String(value)
            };

            // Set the value and emit the message event
            component.set_value(component_value.clone());

            // Emit event through the component's event sender
            if let Some(sender) = component.event_sender() {
                let _ = sender.send(ComponentEvent {
                    source: Arc::from(component_id),
                    source_handle: Arc::from("message"),
                    value: component_value,
                    edge_id: None,
                    sequence: 0,  // Will be set by FlowRuntime when sequence tracking is enabled
                });
            }
        }
    }
}

impl Default for FlowExecutor {
    fn default() -> Self {
        Self::new()
    }
}
