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

pub use base::{BoardConnection, BoardHandle, Component, ComponentEvent, ComponentValue, SerialPortWrapper};
pub use executor::FlowExecutor;
pub use types::FlowUpdate;

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
use tokio::sync::mpsc;

/// Pin listener registration for immediate event routing
#[derive(Clone)]
pub struct PinListener {
    pub component_id: String,
    pub pin: u8,
    pub is_analog: bool,
    pub threshold: u16,
}

/// Flow runtime manages the lifecycle of components and flow execution
pub struct FlowRuntime {
    board_manager: BoardManager,
    executor: FlowExecutor,
    registry: ComponentRegistry,
    event_tx: mpsc::UnboundedSender<ComponentEvent>,
    event_rx: Option<mpsc::UnboundedReceiver<ComponentEvent>>,
    /// Map of pin -> listeners for immediate event routing
    pin_listeners: Arc<std::sync::Mutex<HashMap<u8, Vec<PinListener>>>>,
}

impl FlowRuntime {
    pub fn new() -> Self {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        Self {
            board_manager: BoardManager::new(),
            executor: FlowExecutor::new(),
            registry: ComponentRegistry::new(),
            event_tx,
            event_rx: Some(event_rx),
            pin_listeners: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    pub fn board_manager(&self) -> &BoardManager { &self.board_manager }
    pub fn board_manager_mut(&mut self) -> &mut BoardManager { &mut self.board_manager }
    pub fn board_handle(&self) -> Arc<BoardHandle> { self.board_manager.handle() }
    pub fn take_event_receiver(&mut self) -> Option<mpsc::UnboundedReceiver<ComponentEvent>> { self.event_rx.take() }
    pub fn event_sender(&self) -> mpsc::UnboundedSender<ComponentEvent> { self.event_tx.clone() }

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
    pub fn pin_listeners(&self) -> Arc<std::sync::Mutex<HashMap<u8, Vec<PinListener>>>> {
        Arc::clone(&self.pin_listeners)
    }

    /// Install the pin change callback on the board connection
    /// This should be called after flow updates to ensure the callback uses the latest pin_listeners
    pub fn install_pin_change_callback(&self, event_tx: mpsc::UnboundedSender<ComponentEvent>) {
        let pin_listeners = self.pin_listeners();
        
        let callback: base::PinChangeCallback = Box::new(move |change: base::PinChangeEvent| {
            let listeners = pin_listeners.lock().unwrap();
            if let Some(pin_listeners) = listeners.get(&change.pin) {
                for listener in pin_listeners {
                    // Emit internal event to trigger component's read processing
                    let value = if change.is_analog {
                        ComponentValue::Number(change.value as f64)
                    } else {
                        ComponentValue::Bool(change.value > 0)
                    };
                    
                    log::info!("Pin {} changed to {:?}, notifying component {} (analog={})", 
                        change.pin, change.value, listener.component_id, change.is_analog);
                    
                    let _ = event_tx.send(ComponentEvent {
                        source: listener.component_id.clone(),
                        source_handle: "_pin_change".to_string(),
                        value,
                        edge_id: None,
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
        let _ = self.board_handle().with_board(|conn| {
            conn.clear_pin_cache();
            conn.set_pin_change_callback(Arc::new(callback));
            Ok(())
        });
        
        log::info!("Pin change callback installed (cache cleared)");
    }

    /// Update the flow with new nodes and edges
    pub fn update_flow(&mut self, update: FlowUpdate) -> Result<(), String> {
        log::info!("Updating flow: {} nodes, {} edges", update.nodes.len(), update.edges.len());
        
        // Clear existing components and pin listeners
        self.executor.clear();
        self.clear_pin_listeners();
        
        let board_handle = self.board_handle();

        // Create components from nodes
        for node in &update.nodes {
            log::info!("Processing node: id={}, type={:?}, data={:?}", 
                node.id, 
                node.data.get("instance"),
                node.data
            );
            
            if let Some(instance) = node.data.get("instance").and_then(|v| v.as_str()) {
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
                // Digital input components
                if let Some(pin) = data.get("pin").and_then(|v| v.as_u64()).map(|v| v as u8) {
                    log::info!("Registering digital pin listener: component={}, pin={}", component_id, pin);
                    self.register_pin_listener(PinListener {
                        component_id: component_id.to_string(),
                        pin,
                        is_analog: false,
                        threshold: 0,
                    });
                }
            }
            "Sensor" | "Proximity" => {
                // Analog input components - handle both string and number pin formats
                let pin: u8 = if let Some(pin_num) = data.get("pin").and_then(|v| v.as_u64()) {
                    // Numeric format (e.g., 17)
                    pin_num as u8
                } else if let Some(pin_str) = data.get("pin").and_then(|v| v.as_str()) {
                    // String format (e.g., "A0" or "17")
                    if pin_str.starts_with('A') || pin_str.starts_with('a') {
                        pin_str[1..].parse().unwrap_or(14)
                    } else {
                        pin_str.parse().unwrap_or(14)
                    }
                } else {
                    14 // Default to A0
                };
                
                let threshold = data.get("threshold").and_then(|v| v.as_u64()).unwrap_or(1) as u16;
                
                log::info!("Registering analog pin listener: component={}, pin={}, threshold={}", component_id, pin, threshold);
                self.register_pin_listener(PinListener {
                    component_id: component_id.to_string(),
                    pin,
                    is_analog: true,
                    threshold,
                });
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

    pub fn process_event(&mut self, event: ComponentEvent) { 
        self.executor.process_event(event); 
    }

    pub fn poll_inputs(&mut self) -> Result<(), String> {
        if self.board_manager.is_connected() { 
            self.board_manager.poll()?; 
        }
        self.executor.poll_inputs()
    }

    pub fn call_component(&mut self, component_id: &str, method: &str, value: ComponentValue) -> Result<(), String> {
        self.executor.get_component_mut(component_id)
            .ok_or_else(|| format!("Component {} not found", component_id))?
            .call_method(method, value)
    }

    /// Route an MQTT message to a subscribe component
    pub fn route_mqtt_message(&mut self, component_id: &str, payload: &[u8]) {
        self.executor.route_mqtt_message(component_id, payload);
    }

    /// Get all component IDs of a specific type
    pub fn get_components_by_type(&self, component_type: &str) -> Vec<String> {
        self.executor.component_ids()
            .iter()
            .filter(|id| {
                self.executor.get_component(id)
                    .map(|c| c.component_type() == component_type)
                    .unwrap_or(false)
            })
            .map(|s| s.to_string())
            .collect()
    }
}

impl Default for FlowRuntime {
    fn default() -> Self { Self::new() }
}
