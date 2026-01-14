//! Flow Runtime Module
//!
//! Manages the execution of flow graphs with hardware components.
//!
//! # Architecture
//!
//! ```text
//! runtime/
//! ├── mod.rs       - Module exports and FlowRuntime
//! ├── base.rs      - Component trait and board connection
//! ├── types.rs     - Flow types (Node, Edge, etc.)
//! ├── executor.rs  - Flow execution logic
//! ├── commands.rs  - Tauri commands
//! ├── input/       - Input components (Button, Sensor, Motion, Proximity)
//! └── output/      - Output components (Led, Rgb, Relay, Piezo, Servo)
//! ```

pub mod base;
pub mod commands;
mod executor;
pub mod input;
pub mod output;
mod types;

pub use base::{BoardConnection, BoardHandle, Component, ComponentEvent, ComponentValue, SerialPortWrapper};
pub use executor::FlowExecutor;
pub use input::{Button, ButtonConfig, Motion, MotionConfig, Proximity, ProximityConfig, Sensor, SensorConfig};
pub use output::{Led, LedConfig, Piezo, PiezoConfig, Relay, RelayConfig, Rgb, RgbConfig, Servo, ServoConfig};
pub use types::FlowUpdate;

use crate::hardware::board::BoardManager;
use std::sync::Arc;
use tokio::sync::mpsc;

/// Flow runtime manages the lifecycle of components and flow execution
pub struct FlowRuntime {
    board_manager: BoardManager,
    executor: FlowExecutor,
    event_tx: mpsc::UnboundedSender<ComponentEvent>,
    event_rx: Option<mpsc::UnboundedReceiver<ComponentEvent>>,
}

impl FlowRuntime {
    pub fn new() -> Self {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        Self {
            board_manager: BoardManager::new(),
            executor: FlowExecutor::new(),
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
        self.executor.clear();
        let board_handle = self.board_handle();

        for node in &update.nodes {
            if let Some(instance) = node.data.get("instance").and_then(|v| v.as_str()) {
                match self.create_component(&node.id, instance, &node.data, board_handle.clone()) {
                    Ok(()) => log::debug!("Created component {} ({})", node.id, instance),
                    Err(e) => log::warn!("Failed to create component {}: {}", node.id, e),
                }
            }
        }

        self.executor.set_edges(update.edges);
        Ok(())
    }

    fn create_component(&mut self, id: &str, instance: &str, data: &serde_json::Value, board_handle: Arc<BoardHandle>) -> Result<(), String> {
        match instance {
            "Led" => {
                let config: LedConfig = serde_json::from_value(data.clone()).unwrap_or_default();
                let mut component = Led::new(id.to_string(), config);
                component.set_event_sender(self.event_tx.clone());
                if board_handle.is_connected() { component.initialize(board_handle)?; }
                self.executor.add_component(id, Box::new(component));
            }
            "Button" => {
                let config: ButtonConfig = serde_json::from_value(data.clone()).unwrap_or_default();
                let mut component = Button::new(id.to_string(), config);
                component.set_event_sender(self.event_tx.clone());
                if board_handle.is_connected() { component.initialize(board_handle)?; }
                self.executor.add_component(id, Box::new(component));
            }
            "Sensor" => {
                let config: SensorConfig = serde_json::from_value(data.clone()).unwrap_or_default();
                let mut component = Sensor::new(id.to_string(), config);
                component.set_event_sender(self.event_tx.clone());
                if board_handle.is_connected() { component.initialize(board_handle)?; }
                self.executor.add_component(id, Box::new(component));
            }
            "Servo" => {
                let config: ServoConfig = serde_json::from_value(data.clone()).unwrap_or_default();
                let mut component = Servo::new(id.to_string(), config);
                component.set_event_sender(self.event_tx.clone());
                if board_handle.is_connected() { component.initialize(board_handle)?; }
                self.executor.add_component(id, Box::new(component));
            }
            "Rgb" => {
                let config: RgbConfig = serde_json::from_value(data.clone()).unwrap_or_default();
                let mut component = Rgb::new(id.to_string(), config);
                component.set_event_sender(self.event_tx.clone());
                if board_handle.is_connected() { component.initialize(board_handle)?; }
                self.executor.add_component(id, Box::new(component));
            }
            "Relay" => {
                let config: RelayConfig = serde_json::from_value(data.clone()).unwrap_or_default();
                let mut component = Relay::new(id.to_string(), config);
                component.set_event_sender(self.event_tx.clone());
                if board_handle.is_connected() { component.initialize(board_handle)?; }
                self.executor.add_component(id, Box::new(component));
            }
            "Piezo" => {
                let config: PiezoConfig = serde_json::from_value(data.clone()).unwrap_or_default();
                let mut component = Piezo::new(id.to_string(), config);
                component.set_event_sender(self.event_tx.clone());
                if board_handle.is_connected() { component.initialize(board_handle)?; }
                self.executor.add_component(id, Box::new(component));
            }
            "Motion" => {
                let config: MotionConfig = serde_json::from_value(data.clone()).unwrap_or_default();
                let mut component = Motion::new(id.to_string(), config);
                component.set_event_sender(self.event_tx.clone());
                if board_handle.is_connected() { component.initialize(board_handle)?; }
                self.executor.add_component(id, Box::new(component));
            }
            "Proximity" => {
                let config: ProximityConfig = serde_json::from_value(data.clone()).unwrap_or_default();
                let mut component = Proximity::new(id.to_string(), config);
                component.set_event_sender(self.event_tx.clone());
                if board_handle.is_connected() { component.initialize(board_handle)?; }
                self.executor.add_component(id, Box::new(component));
            }
            _ => log::debug!("Skipping non-hardware component: {}", instance),
        }
        Ok(())
    }

    pub fn process_event(&mut self, event: ComponentEvent) { self.executor.process_event(event); }

    pub fn poll_inputs(&mut self) -> Result<(), String> {
        if self.board_manager.is_connected() { self.board_manager.poll()?; }
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
