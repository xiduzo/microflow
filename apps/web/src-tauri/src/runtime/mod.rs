//! Flow Runtime Module
//!
//! Manages the execution of flow graphs with hardware components.
//!
//! # Architecture
//!
//! ```text
//! runtime/
//! ├── mod.rs          - Module exports and FlowRuntime
//! ├── base.rs         - Component trait and board connection
//! ├── types.rs        - Flow types (Node, Edge, etc.)
//! ├── executor.rs     - Flow execution logic
//! ├── registry.rs     - Component factory registry
//! ├── commands.rs     - Tauri commands
//! ├── input/          - Input components (Button, Sensor, Motion, Proximity)
//! ├── output/         - Output components (Led, Rgb, Relay, Piezo, Servo)
//! ├── control/        - Control components (Counter, Delay, Trigger)
//! ├── generator/      - Generator components (Constant, Interval, Oscillator)
//! └── transformation/ - Transformation components (Calculate, Compare, Gate, RangeMap, Smooth)
//! ```
//!
//! # Component Lifecycle
//!
//! 1. Flow update received from frontend
//! 2. Existing components destroyed via `executor.clear()`
//! 3. New components created via `ComponentRegistry`
//! 4. Hardware components initialized if board is connected
//! 5. Edges wired up for event routing
//! 6. Events flow through the graph via `process_event()`

pub mod base;
pub mod board;
mod builders;
pub mod commands;
pub mod component;
pub mod context;
pub mod control;
mod executor;
pub mod external;
pub mod generator;
pub mod input;
pub mod output;
pub mod pin_mode;
mod registry;
pub mod serde_utils;
pub mod transformation;
mod types;
pub mod wiring;
mod wiring_registry;

pub use base::{BoardConnection, BoardHandle, Component, ComponentEvent, ComponentValue, SerialPortWrapper};
pub use context::{ProviderEntry, RuntimeContext};
pub use wiring::{ListenerWiring, SubscriberWiring};
pub use executor::FlowExecutor;
// FlowEdge is re-exported for use in integration tests and external consumers
#[allow(unused_imports)]
pub use types::{FlowEdge, FlowUpdate};

// Re-export component types for external use (e.g., tests, plugins)
#[allow(unused_imports)]
pub use input::{Button, ButtonConfig, Hotkey, HotkeyConfig, Motion, MotionConfig, Proximity, ProximityConfig, Sensor, SensorConfig};
#[allow(unused_imports)]
pub use output::{Led, LedConfig, Piezo, PiezoConfig, Relay, RelayConfig, Rgb, RgbConfig, Servo, ServoConfig};
#[allow(unused_imports)]
pub use control::{Counter, CounterConfig, Delay, DelayConfig, Trigger, TriggerConfig};
#[allow(unused_imports)]
pub use generator::{Constant, ConstantConfig, Interval, IntervalConfig, Oscillator, OscillatorConfig};
#[allow(unused_imports)]
pub use transformation::{Calculate, CalculateConfig, CalculateFunction, Compare, CompareConfig, CompareValidator, Gate, GateConfig, RangeMap, RangeMapConfig, Smooth, SmoothConfig};

use crate::error::RuntimeError;
use registry::ComponentRegistry;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;
use wiring_registry::{WiringRegistry, WiringDelta};

pub use wiring_registry::PinListener;

/// Manages the lifecycle of flow components and event routing.
///
/// # Example
///
/// ```ignore
/// let mut runtime = FlowRuntime::new();
/// // runtime.update_flow(flow)?;
/// // runtime.process_event(event);
/// ```
///
/// # Thread Safety
///
/// This struct is `Send` but not `Sync`. Access from multiple threads
/// requires external synchronization (typically via `Arc<tokio::sync::Mutex<FlowRuntime>>`).
pub struct FlowRuntime {
    board_handle: Arc<BoardHandle>,
    executor: FlowExecutor,
    registry: ComponentRegistry,
    event_tx: mpsc::UnboundedSender<ComponentEvent>,
    event_rx: Option<mpsc::UnboundedReceiver<ComponentEvent>>,
    /// Per-component wiring bookkeeping + pin/key/i2c indices.
    /// Replaces the three separate Arc<Mutex<HashMap>> fields plus the
    /// `clear_*_listeners` + `register_*_listener` methods. See
    /// `runtime/wiring_registry.rs` and `CONTEXT.md` § Wiring.
    wiring: Arc<WiringRegistry>,
    /// Monotonically increasing counter for flow update versions (shared with pin callback)
    flow_sequence: Arc<AtomicU64>,
    /// Current flow sequence for event filtering
    current_sequence: u64,
}

impl FlowRuntime {
    #[must_use]
    pub fn new() -> Self {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let runtime = Self {
            board_handle: Arc::new(BoardHandle::new()),
            executor: FlowExecutor::new(),
            registry: ComponentRegistry::new(),
            event_tx: event_tx.clone(),
            event_rx: Some(event_rx),
            wiring: Arc::new(WiringRegistry::new()),
            flow_sequence: Arc::new(AtomicU64::new(0)),
            current_sequence: 0,
        };
        // The pin-change and I2C-reply callbacks both capture the wiring
        // registry's index `Arc`s plus the event sender — all stable for the
        // lifetime of the runtime. Install once at construction; flow updates
        // mutate the indices in place and the same callback observes the new
        // state.
        runtime.install_pin_change_callback();
        runtime.install_i2c_reply_callback();
        runtime
    }

    #[must_use]
    pub fn board_handle(&self) -> Arc<BoardHandle> { Arc::clone(&self.board_handle) }
    pub fn take_event_receiver(&mut self) -> Option<mpsc::UnboundedReceiver<ComponentEvent>> { self.event_rx.take() }
    #[must_use] 
    pub fn event_sender(&self) -> mpsc::UnboundedSender<ComponentEvent> { self.event_tx.clone() }
    
    /// Get the current flow sequence number for event filtering
    #[must_use] 
    pub fn current_sequence(&self) -> u64 { self.current_sequence }
    
    /// Get the flow sequence counter for sharing with callbacks
    #[must_use] 
    pub fn flow_sequence(&self) -> Arc<AtomicU64> { Arc::clone(&self.flow_sequence) }

    /// Shared handle to the pin listeners map.
    ///
    /// Kept for the pin-change callback closure built in
    /// `install_pin_change_callback`. External callers should not mutate the
    /// map directly — go through [`WiringRegistry::install`] / `revoke`.
    #[must_use]
    pub fn pin_listeners(&self) -> Arc<std::sync::Mutex<HashMap<u8, Vec<PinListener>>>> {
        self.wiring.pin_listeners()
    }

    /// Shared handle to the key listeners map. Used by the `key_event` Tauri
    /// command to dispatch a hotkey to all subscribed Hotkey components.
    #[must_use]
    pub fn key_listeners(&self) -> Arc<std::sync::Mutex<HashMap<String, Vec<Arc<str>>>>> {
        self.wiring.key_listeners()
    }

    fn install_pin_change_callback(&self) {
        let pin_listeners = self.pin_listeners();
        let flow_sequence = self.flow_sequence();
        let event_tx = self.event_tx.clone();

        let callback: base::PinChangeCallback = Box::new(move |change: base::PinChangeEvent| {
            let sequence = flow_sequence.load(Ordering::SeqCst);

            let listeners = pin_listeners
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(pin_listeners) = listeners.get(&change.pin) {
                for listener in pin_listeners {
                    let value = if change.is_analog {
                        ComponentValue::Number(f64::from(change.value))
                    } else {
                        ComponentValue::Bool(change.value > 0)
                    };

                    log::info!(
                        "Pin {} changed to {:?}, notifying component {} (analog={}, seq={})",
                        change.pin, change.value, listener.component_id, change.is_analog, sequence
                    );

                    let _ = event_tx.send(ComponentEvent {
                        source: Arc::clone(&listener.component_id),
                        source_handle: Arc::from("_pin_change"),
                        value,
                        edge_id: None,
                        sequence,
                    });
                }
            } else if change.is_analog {
                log::trace!("Pin {} changed but no listener registered", change.pin);
            }
        });

        let _ = self.board_handle.set_pin_change_callback(Arc::new(callback));
        log::info!("Pin change callback installed");
    }

    fn install_i2c_reply_callback(&self) {
        let i2c_listeners = self.wiring.i2c_listeners();
        let flow_sequence = self.flow_sequence();
        let event_tx = self.event_tx.clone();

        let callback: base::I2cReplyCallback = Box::new(move |reply: base::I2cReplyEvent| {
            let sequence = flow_sequence.load(Ordering::SeqCst);

            let listeners = i2c_listeners
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(component_ids) = listeners.get(&reply.address) {
                let data_values: Vec<ComponentValue> = reply
                    .data
                    .iter()
                    .map(|&b| ComponentValue::Number(f64::from(b)))
                    .collect();

                for component_id in component_ids {
                    log::debug!(
                        "I2C reply from 0x{:02X} (reg=0x{:02X}, {} bytes) → component {}",
                        reply.address, reply.register, reply.data.len(), component_id
                    );

                    let _ = event_tx.send(ComponentEvent {
                        source: Arc::clone(component_id),
                        source_handle: Arc::from("_i2c_reply"),
                        value: ComponentValue::Array(data_values.clone()),
                        edge_id: None,
                        sequence,
                    });
                }
            }
        });

        let _ = self.board_handle.set_i2c_reply_callback(Arc::new(callback));
        log::info!("I2C reply callback installed");
    }

    /// Update the flow with new nodes and edges.
    ///
    /// Uses diff-based updates: unchanged nodes are kept, only modified/added/removed
    /// nodes are touched. This turns an O(n) operation into O(delta) for small edits.
    pub fn update_flow(&mut self, update: FlowUpdate, ctx: &crate::runtime::context::RuntimeContext) -> Result<(), RuntimeError> {
        // Increment sequence FIRST - this ensures any events generated during
        // the update will have the new sequence number, and stale events from
        // the previous flow version will be filtered out by the executor
        let new_sequence = self.flow_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        self.current_sequence = new_sequence;
        
        // Update the executor's sequence so it can filter stale events
        self.executor.set_current_sequence(new_sequence);

        // Build lookup of new nodes by ID
        let new_node_map: std::collections::HashMap<&str, &crate::runtime::types::FlowNode> = update.nodes.iter()
            .map(|n| (n.id.as_str(), n))
            .collect();

        let old_ids: std::collections::HashSet<String> = self.executor.component_ids()
            .iter().map(|s| (*s).to_string()).collect();
        let new_ids: std::collections::HashSet<&str> = new_node_map.keys().copied().collect();

        // Compute which nodes changed (different data JSON)
        let mut unchanged_count = 0usize;
        let mut removed_ids: Vec<String> = Vec::new();
        let mut added_or_changed_nodes: Vec<&crate::runtime::types::FlowNode> = Vec::new();

        // Find removed nodes
        for old_id in &old_ids {
            if !new_ids.contains(old_id.as_str()) {
                removed_ids.push(old_id.clone());
            }
        }

        // Find added or changed nodes
        for node in &update.nodes {
            if old_ids.contains(&node.id) {
                // Node exists in both — check if data changed
                if let Some(existing) = self.executor.get_component(&node.id) {
                    let old_type = existing.component_type();
                    let new_instance = node.data.get("instance").and_then(|v| v.as_str())
                        .or(node.node_type.as_deref())
                        .unwrap_or("");
                    // If the component type changed, it must be recreated
                    if old_type != new_instance {
                        removed_ids.push(node.id.clone());
                        added_or_changed_nodes.push(node);
                    } else if let Some(old_data) = self.executor.get_node_data(&node.id) {
                        // Same type — check if the node data itself changed
                        // (e.g. Piezo switching from buzz to song)
                        if *old_data == node.data {
                            unchanged_count += 1;
                        } else {
                            removed_ids.push(node.id.clone());
                            added_or_changed_nodes.push(node);
                        }
                    } else {
                        // No stored data to compare — recreate to be safe
                        removed_ids.push(node.id.clone());
                        added_or_changed_nodes.push(node);
                    }
                } else {
                    added_or_changed_nodes.push(node);
                }
            } else {
                // New node
                added_or_changed_nodes.push(node);
            }
        }

        log::info!("Flow update (seq={}): {} nodes ({} unchanged, {} added/changed, {} removed), {} edges",
            new_sequence, update.nodes.len(), unchanged_count,
            added_or_changed_nodes.len(), removed_ids.len(), update.edges.len());

        let board_handle = self.board_handle();

        // --- Phase 1: revoke wiring for everything that is leaving or being
        // recreated. `WiringRegistry::install` is idempotent (revokes first),
        // but doing the revoke explicitly here lets us snapshot the pre-state.
        let pre_pins = self.wiring.pin_use_snapshot();

        for id in &removed_ids {
            self.wiring.revoke(id);
            self.executor.remove_component(id);
        }
        for node in &added_or_changed_nodes {
            self.wiring.revoke(&node.id);
        }

        // --- Phase 2: create new / replacement components.
        for node in &added_or_changed_nodes {
            let instance_str = node.data.get("instance").and_then(|v| v.as_str())
                .or(node.node_type.as_deref());
            if let Some(instance) = instance_str {
                match self.registry.create(
                    &node.id,
                    instance,
                    &node.data,
                    ctx,
                    self.event_tx.clone(),
                    board_handle.clone(),
                ) {
                    Ok(component) => {
                        log::info!("✓ Created component {} ({})", node.id, instance);
                        self.executor.add_component(&node.id, component, node.data.clone());
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        if matches!(&e, RuntimeError::ComponentNotFound(_)) {
                            log::warn!("✗ Skipping unknown component {}: {}", node.id, msg);
                        } else {
                            log::error!("✗ Failed to create component {}: {}", node.id, msg);
                        }
                    }
                }
            }
        }

        // --- Phase 3: install wiring for every (still-)active component.
        // Unchanged components stay in `WiringRegistry`; install only the new
        // and the recreated ones. See `CONTEXT.md` § Wiring.
        for node in &added_or_changed_nodes {
            if let Some(component) = self.executor.get_component(&node.id) {
                let wirings = component.listener_wiring();
                if !wirings.is_empty() {
                    self.wiring.install(Arc::from(node.id.as_str()), wirings);
                }
            }
        }

        // --- Phase 4: reconcile Firmata reporting state. Apply the precise
        // pin-level delta against the wire — no global `reset_all_reporting`.
        let post_pins = self.wiring.pin_use_snapshot();
        let delta = WiringRegistry::delta(&pre_pins, &post_pins);
        self.apply_wiring_delta(&board_handle, &delta);

        // Always rebuild edges (cheap — just hash map rebuild)
        self.executor.set_edges(update.edges);

        log::info!(
            "Flow update complete. Active components: {} (pins +{}/-{})",
            self.executor.component_ids().len(),
            delta.pins_to_enable.len(),
            delta.pins_to_disable.len()
        );
        Ok(())
    }

    /// Apply a [`WiringDelta`] to the Firmata wire: enable reporting for
    /// newly-needed pins and disable reporting for vanished pins. Each call
    /// is a small number of `BoardCommand` enqueues, proportional to the
    /// diff — not the entire pin space.
    fn apply_wiring_delta(&self, board: &Arc<BoardHandle>, delta: &WiringDelta) {
        if !board.is_connected() {
            return;
        }
        for &(pin, is_analog) in &delta.pins_to_enable {
            let _ = board.register_active_pin(pin);
            let _ = if is_analog {
                board.enable_analog_reporting(pin)
            } else {
                board.enable_digital_reporting(pin)
            };
        }
        for &(pin, is_analog) in &delta.pins_to_disable {
            let _ = if is_analog {
                board.disable_analog_reporting(pin)
            } else {
                board.disable_digital_reporting(pin)
            };
            board.unregister_active_pin(pin);
        }
    }

    /// Initialize all hardware components (call when board connects)
    pub fn initialize_hardware(&mut self) -> Result<(), RuntimeError> {
        let board_handle = self.board_handle();
        if !board_handle.is_connected() {
            return Err(RuntimeError::BoardNotConnected);
        }

        self.executor.initialize_all(board_handle)
    }

    pub fn process_event(&mut self, event: ComponentEvent) -> bool { 
        self.executor.process_event(event)
    }

    pub fn call_component(&mut self, component_id: &str, method: &str, value: ComponentValue) -> Result<(), RuntimeError> {
        self.executor.get_component_mut(component_id)
            .ok_or_else(|| RuntimeError::ComponentNotFound(component_id.to_string()))?
            .call_method(method, value)
    }

    /// Route an MQTT message to a subscribe component
    pub fn route_mqtt_message(&mut self, component_id: &str, payload: &[u8]) {
        self.executor.route_mqtt_message(component_id, payload);
    }

    /// Route a topic-aware MQTT message to a Figma component
    pub fn route_figma_message(&mut self, component_id: &str, topic: &str, payload: &[u8]) {
        self.executor.route_figma_message(component_id, topic, payload);
    }

    /// Collect every component's subscriber wiring, paired with its component ID.
    /// See `CONTEXT.md` § Wiring.
    #[must_use]
    pub fn collect_subscriber_wirings(&self) -> Vec<(String, crate::runtime::wiring::SubscriberWiring)> {
        let mut out = Vec::new();
        for id in self.executor.component_ids() {
            if let Some(component) = self.executor.get_component(id) {
                for wiring in component.subscriber_wiring() {
                    out.push((id.to_string(), wiring));
                }
            }
        }
        out
    }

    /// Get all component IDs of a specific type
    #[must_use]
    pub fn get_components_by_type(&self, component_type: &str) -> Vec<String> {
        self.executor.component_ids()
            .iter()
            .filter(|id| {
                self.executor.get_component(id)
                    .is_some_and(|c| c.component_type() == component_type)
            })
            .map(|s| (*s).to_string())
            .collect()
    }
}

impl Default for FlowRuntime {
    fn default() -> Self { Self::new() }
}
