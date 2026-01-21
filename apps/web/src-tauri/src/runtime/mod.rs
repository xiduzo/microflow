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
use std::sync::Arc;
use tokio::sync::mpsc;

/// Flow runtime manages the lifecycle of components and flow execution
pub struct FlowRuntime {
    board_manager: BoardManager,
    executor: FlowExecutor,
    registry: ComponentRegistry,
    event_tx: mpsc::UnboundedSender<ComponentEvent>,
    event_rx: Option<mpsc::UnboundedReceiver<ComponentEvent>>,
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
        }
    }

    pub fn board_manager(&self) -> &BoardManager { &self.board_manager }
    pub fn board_manager_mut(&mut self) -> &mut BoardManager { &mut self.board_manager }
    pub fn board_handle(&self) -> Arc<BoardHandle> { self.board_manager.handle() }
    pub fn take_event_receiver(&mut self) -> Option<mpsc::UnboundedReceiver<ComponentEvent>> { self.event_rx.take() }
    pub fn event_sender(&self) -> mpsc::UnboundedSender<ComponentEvent> { self.event_tx.clone() }

    /// Update the flow with new nodes and edges
    pub fn update_flow(&mut self, update: FlowUpdate) -> Result<(), String> {
        log::info!("Updating flow: {} nodes, {} edges", update.nodes.len(), update.edges.len());
        
        // Clear existing components
        self.executor.clear();
        
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
