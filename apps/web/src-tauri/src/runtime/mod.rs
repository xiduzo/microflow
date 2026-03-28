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
pub mod commands;
pub mod control;
mod executor;
pub mod external;
pub mod generator;
pub mod input;
pub mod output;
mod registry;
pub mod transformation;
mod types;

pub use base::{BoardCommand, BoardConnection, BoardHandle, Component, ComponentEvent, ComponentValue, SerialPortWrapper};
pub use executor::FlowExecutor;
// FlowEdge is re-exported for use in integration tests and external consumers
#[allow(unused_imports)]
pub use types::{FlowEdge, FlowUpdate};

// Re-export component types for external use (e.g., tests, plugins)
#[allow(unused_imports)]
pub use input::{Button, ButtonConfig, Motion, MotionConfig, Proximity, ProximityConfig, Sensor, SensorConfig};
#[allow(unused_imports)]
pub use output::{Led, LedConfig, Piezo, PiezoConfig, Relay, RelayConfig, Rgb, RgbConfig, Servo, ServoConfig};
#[allow(unused_imports)]
pub use control::{Counter, CounterConfig, Delay, DelayConfig, Trigger, TriggerConfig};
#[allow(unused_imports)]
pub use generator::{Constant, ConstantConfig, Interval, IntervalConfig, Oscillator, OscillatorConfig};
#[allow(unused_imports)]
pub use transformation::{Calculate, CalculateConfig, Compare, CompareConfig, Gate, GateConfig, RangeMap, RangeMapConfig, Smooth, SmoothConfig};

use crate::hardware::board::BoardManager;
use registry::ComponentRegistry;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;

/// Pin listener registration for immediate event routing
#[derive(Clone)]
pub struct PinListener {
    pub component_id: Arc<str>,
    pub pin: u8,
    pub is_analog: bool,
    pub threshold: u16,
}

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
    board_manager: BoardManager,
    executor: FlowExecutor,
    registry: ComponentRegistry,
    event_tx: mpsc::UnboundedSender<ComponentEvent>,
    event_rx: Option<mpsc::UnboundedReceiver<ComponentEvent>>,
    /// Map of pin -> listeners for immediate event routing
    pin_listeners: Arc<std::sync::Mutex<HashMap<u8, Vec<PinListener>>>>,
    /// Monotonically increasing counter for flow update versions (shared with pin callback)
    flow_sequence: Arc<AtomicU64>,
    /// Current flow sequence for event filtering
    current_sequence: u64,
}

impl FlowRuntime {
    #[must_use] 
    pub fn new() -> Self {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        Self {
            board_manager: BoardManager::new(),
            executor: FlowExecutor::new(),
            registry: ComponentRegistry::new(),
            event_tx,
            event_rx: Some(event_rx),
            pin_listeners: Arc::new(std::sync::Mutex::new(HashMap::new())),
            flow_sequence: Arc::new(AtomicU64::new(0)),
            current_sequence: 0,
        }
    }

    #[must_use] 
    pub fn board_manager(&self) -> &BoardManager { &self.board_manager }
    pub fn board_manager_mut(&mut self) -> &mut BoardManager { &mut self.board_manager }
    #[must_use] 
    pub fn board_handle(&self) -> Arc<BoardHandle> { self.board_manager.handle() }
    pub fn take_event_receiver(&mut self) -> Option<mpsc::UnboundedReceiver<ComponentEvent>> { self.event_rx.take() }
    #[must_use] 
    pub fn event_sender(&self) -> mpsc::UnboundedSender<ComponentEvent> { self.event_tx.clone() }
    
    /// Get the current flow sequence number for event filtering
    #[must_use] 
    pub fn current_sequence(&self) -> u64 { self.current_sequence }
    
    /// Get the flow sequence counter for sharing with callbacks
    #[must_use] 
    pub fn flow_sequence(&self) -> Arc<AtomicU64> { Arc::clone(&self.flow_sequence) }

    /// Register a pin listener for immediate event routing
    pub fn register_pin_listener(&self, listener: PinListener) {
        let mut listeners = self.pin_listeners.lock().unwrap();
        listeners.entry(listener.pin).or_default().push(listener);
    }

    /// Clear all pin listeners
    pub fn clear_pin_listeners(&self) {
        let mut listeners = self.pin_listeners.lock().unwrap();
        listeners.clear();
    }

    /// Get the pin listeners map for setting up the callback
    #[must_use] 
    pub fn pin_listeners(&self) -> Arc<std::sync::Mutex<HashMap<u8, Vec<PinListener>>>> {
        Arc::clone(&self.pin_listeners)
    }

    /// Install the pin change callback on the board connection
    /// This should be called after flow updates to ensure the callback uses the latest `pin_listeners`
    pub fn install_pin_change_callback(&self, event_tx: mpsc::UnboundedSender<ComponentEvent>) {
        let pin_listeners = self.pin_listeners();
        let flow_sequence = self.flow_sequence();
        
        let callback: base::PinChangeCallback = Box::new(move |change: base::PinChangeEvent| {
            // Read the current sequence number for this event
            let sequence = flow_sequence.load(Ordering::SeqCst);
            
            let listeners = pin_listeners.lock().unwrap();
            if let Some(pin_listeners) = listeners.get(&change.pin) {
                for listener in pin_listeners {
                    // Emit internal event to trigger component's read processing
                    let value = if change.is_analog {
                        ComponentValue::Number(f64::from(change.value))
                    } else {
                        ComponentValue::Bool(change.value > 0)
                    };
                    
                    log::info!("Pin {} changed to {:?}, notifying component {} (analog={}, seq={})", 
                        change.pin, change.value, listener.component_id, change.is_analog, sequence);
                    
                    let _ = event_tx.send(ComponentEvent {
                        source: Arc::clone(&listener.component_id),
                        source_handle: Arc::from("_pin_change"),
                        value,
                        edge_id: None,
                        sequence,
                    });
                }
            } else {
                // Log pins that change but have no listeners (helps debug stale reporting)
                if change.is_analog {
                    log::trace!("Pin {} changed but no listener registered", change.pin);
                }
            }
        });
        
        // Install the callback on the board connection and clear pin cache
        let board = self.board_handle();
        let _ = board.send_command(BoardCommand::ClearPinCache);
        let _ = board.send_command(BoardCommand::SetPinChangeCallback { callback: Arc::new(callback) });

        log::info!("Pin change callback installed (cache cleared)");
    }

    /// Update the flow with new nodes and edges
    pub fn update_flow(&mut self, update: FlowUpdate) -> Result<(), String> {
        // Increment sequence FIRST - this ensures any events generated during
        // the update will have the new sequence number, and stale events from
        // the previous flow version will be filtered out by the executor
        let new_sequence = self.flow_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        self.current_sequence = new_sequence;
        
        // Update the executor's sequence so it can filter stale events
        self.executor.set_current_sequence(new_sequence);
        
        log::info!("Updating flow (sequence={}): {} nodes, {} edges", 
            new_sequence, update.nodes.len(), update.edges.len());
        
        // Note: The event channel is owned by the event forwarding thread after setup.
        // Stale events (with sequence < current_sequence) will be filtered out
        // by the FlowExecutor.process_event() method when they are processed.
        // This is handled in Task 6.5.
        
        // Clear existing components and pin listeners
        self.executor.clear();
        self.clear_pin_listeners();
        
        // Reset all Firmata reporting to ensure clean state
        // This is critical for hot-swapping pins - prevents stale data
        let board_handle = self.board_handle();
        if board_handle.is_connected() {
            log::info!("Resetting all Firmata reporting for clean flow update");
            let _ = board_handle.send_command(BoardCommand::ResetAllReporting);
        }

        // Create components from nodes
        for node in &update.nodes {
            log::info!("Processing node: id={}, type={:?}, data={:?}", 
                node.id, 
                node.data.get("instance"),
                node.data
            );
            
            let instance_str = node.data.get("instance").and_then(|v| v.as_str())
                .or(node.node_type.as_deref());
            if let Some(instance) = instance_str {
                log::info!("Creating component: {} ({})", node.id, instance);
                match self.registry.create(
                    &node.id,
                    instance,
                    &node.data,
                    self.event_tx.clone(),
                    board_handle.clone(),
                ) {
                    Ok(component) => {
                        log::info!("✓ Created component {} ({}) - type: {}", node.id, instance, component.component_type());
                        
                        // Register pin listeners for input components
                        self.register_component_pin_listener(&node.id, instance, &node.data);
                        
                        self.executor.add_component(&node.id, component);
                    }
                    Err(e) => {
                        // Log but don't fail - unknown components are skipped
                        if e.starts_with("Unknown component type") {
                            log::warn!("✗ Skipping unknown component {}: {}", node.id, e);
                        } else {
                            log::error!("✗ Failed to create component {}: {}", node.id, e);
                        }
                    }
                }
            } else {
                log::warn!("Node {} has no 'instance' field in data", node.id);
            }
        }

        // Wire up edges
        log::info!("Setting up {} edges", update.edges.len());
        for edge in &update.edges {
            log::info!("Edge: {} ({}) -> {} ({})", 
                edge.source, edge.source_handle, 
                edge.target, edge.target_handle
            );
        }
        self.executor.set_edges(update.edges);
        
        log::info!("Flow update complete. Active components: {:?}", self.executor.component_ids());
        Ok(())
    }

    /// Register pin listener for an input component based on its type and config
    fn register_component_pin_listener(&self, component_id: &str, instance: &str, data: &serde_json::Value) {
        match instance {
            "Button" | "Motion" => {
                // Digital input components - handle both string and number pin formats
                let pin: Option<u8> = if let Some(pin_num) = data.get("pin").and_then(serde_json::Value::as_u64) {
                    Some(pin_num as u8)
                } else if let Some(pin_str) = data.get("pin").and_then(|v| v.as_str()) {
                    pin_str.parse().ok()
                } else {
                    None
                };
                
                if let Some(pin) = pin {
                    log::info!("Registering digital pin listener: component={component_id}, pin={pin}");
                    self.register_pin_listener(PinListener {
                        component_id: Arc::from(component_id),
                        pin,
                        is_analog: false,
                        threshold: 0,
                    });
                    let board = self.board_handle();
                    if board.is_connected() {
                        let _ = board.send_command(BoardCommand::RegisterActivePin { pin });
                    }
                }
            }
            "Sensor" | "Proximity" => {
                // Analog input components - handle both string and number pin formats
                let pin: u8 = if let Some(pin_num) = data.get("pin").and_then(serde_json::Value::as_u64) {
                    pin_num as u8
                } else if let Some(pin_str) = data.get("pin").and_then(|v| v.as_str()) {
                    if pin_str.starts_with('A') || pin_str.starts_with('a') {
                        pin_str[1..].parse().unwrap_or(14)
                    } else {
                        pin_str.parse().unwrap_or(14)
                    }
                } else {
                    14
                };

                let threshold = data.get("threshold").and_then(serde_json::Value::as_u64).unwrap_or(1) as u16;

                log::info!("Registering analog pin listener: component={component_id}, pin={pin}, threshold={threshold}");
                self.register_pin_listener(PinListener {
                    component_id: Arc::from(component_id),
                    pin,
                    is_analog: true,
                    threshold,
                });
                let board = self.board_handle();
                if board.is_connected() {
                    let _ = board.send_command(BoardCommand::RegisterActivePin { pin });
                }
            }
            _ => {}
        }
    }

    /// Initialize all hardware components (call when board connects)
    pub fn initialize_hardware(&mut self) -> Result<(), String> {
        let board_handle = self.board_handle();
        if !board_handle.is_connected() {
            return Err("Board not connected".to_string());
        }

        self.executor.initialize_all(board_handle)
    }

    pub fn process_event(&mut self, event: ComponentEvent) -> bool { 
        self.executor.process_event(event)
    }

    pub fn call_component(&mut self, component_id: &str, method: &str, value: ComponentValue) -> Result<(), String> {
        self.executor.get_component_mut(component_id)
            .ok_or_else(|| format!("Component {component_id} not found"))?
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
