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
pub use input::{Button, ButtonConfig, Motion, MotionConfig, Proximity, ProximityConfig, Sensor, SensorConfig};
pub use output::{Led, LedConfig, Piezo, PiezoConfig, Relay, RelayConfig, Rgb, RgbConfig, Servo, ServoConfig};
pub use control::{Counter, CounterConfig, Delay, DelayConfig, Trigger, TriggerConfig};
pub use generator::{Constant, ConstantConfig, Interval, IntervalConfig, Oscillator, OscillatorConfig};
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
            if let Some(instance) = node.data.get("instance").and_then(|v| v.as_str()) {
                match self.registry.create(
                    &node.id,
                    instance,
                    &node.data,
                    self.event_tx.clone(),
                    board_handle.clone(),
                ) {
                    Ok(component) => {
                        log::debug!("Created component {} ({})", node.id, instance);
                        self.executor.add_component(&node.id, component);
                    }
                    Err(e) => {
                        // Log but don't fail - unknown components are skipped
                        if e.starts_with("Unknown component type") {
                            log::debug!("Skipping {}: {}", node.id, e);
                        } else {
                            log::warn!("Failed to create component {}: {}", node.id, e);
                        }
                    }
                }
            }
        }

        // Wire up edges
        self.executor.set_edges(update.edges);
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
}

impl Default for FlowRuntime {
    fn default() -> Self { Self::new() }
}
