//! Flow Executor
//!
//! Handles the execution of flow graphs by routing events between components.

use super::base::{BoardHandle, Component, ComponentEvent, ComponentValue};
use super::types::FlowEdge;
use std::collections::HashMap;
use std::sync::Arc;

/// Executes flow graphs by managing components and routing events
pub struct FlowExecutor {
    components: HashMap<String, Box<dyn Component>>,
    edges: Vec<FlowEdge>,
    /// Map from (source_id, source_handle) to list of (target_id, target_handle, edge_id)
    edge_map: HashMap<(String, String), Vec<(String, String, Option<String>)>>,
}

impl FlowExecutor {
    pub fn new() -> Self {
        Self {
            components: HashMap::new(),
            edges: Vec::new(),
            edge_map: HashMap::new(),
        }
    }

    /// Add a component to the executor
    pub fn add_component(&mut self, id: &str, component: Box<dyn Component>) {
        self.components.insert(id.to_string(), component);
    }

    /// Remove a component
    pub fn remove_component(&mut self, id: &str) -> Option<Box<dyn Component>> {
        if let Some(mut component) = self.components.remove(id) {
            component.destroy();
            Some(component)
        } else {
            None
        }
    }

    /// Clear all components
    pub fn clear(&mut self) {
        for (_, mut component) in self.components.drain() {
            component.destroy();
        }
        self.edges.clear();
        self.edge_map.clear();
    }

    /// Set the edges for the flow
    pub fn set_edges(&mut self, edges: Vec<FlowEdge>) {
        self.edges = edges;
        self.rebuild_edge_map();
    }

    /// Rebuild the edge lookup map
    fn rebuild_edge_map(&mut self) {
        self.edge_map.clear();

        for edge in &self.edges {
            let key = (edge.source.clone(), edge.source_handle.clone());
            let value = (
                edge.target.clone(),
                edge.target_handle.clone(),
                edge.id.clone(),
            );

            self.edge_map.entry(key).or_default().push(value);
        }
    }

    /// Initialize all components that require hardware
    pub fn initialize_all(&mut self, board_handle: Arc<BoardHandle>) -> Result<(), String> {
        let mut errors = Vec::new();

        for (id, component) in &mut self.components {
            if component.requires_hardware() {
                if let Err(e) = component.initialize(board_handle.clone()) {
                    errors.push(format!("{}: {}", id, e));
                }
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!("Failed to initialize components: {}", errors.join(", ")))
        }
    }

    /// Process an event from a component and propagate to connected components
    pub fn process_event(&mut self, event: ComponentEvent) {
        let key = (event.source.clone(), event.source_handle.clone());

        // Find all targets for this event
        let targets = match self.edge_map.get(&key) {
            Some(t) => t.clone(),
            None => return,
        };

        // Route to each target
        for (target_id, target_handle, _edge_id) in targets {
            if let Some(target) = self.components.get_mut(&target_id) {
                if let Err(e) = target.call_method(&target_handle, event.value.clone()) {
                    log::warn!("Failed to call {}.{}: {}", target_id, target_handle, e);
                }
            }
        }
    }

    /// Get a component by ID
    pub fn get_component(&self, id: &str) -> Option<&dyn Component> {
        self.components.get(id).map(|c| c.as_ref())
    }

    /// Get a mutable component by ID
    pub fn get_component_mut(&mut self, id: &str) -> Option<&mut Box<dyn Component>> {
        self.components.get_mut(id)
    }

    /// Get all component IDs
    pub fn component_ids(&self) -> Vec<&str> {
        self.components.keys().map(|s| s.as_str()).collect()
    }

    /// Poll all input components (buttons, sensors, etc.)
    pub fn poll_inputs(&mut self) -> Result<(), String> {
        // Collect IDs of input components
        let input_ids: Vec<String> = self
            .components
            .iter()
            .filter(|(_, c)| {
                matches!(
                    c.component_type(),
                    "Button" | "Sensor" | "Motion" | "Proximity"
                )
            })
            .map(|(id, _)| id.clone())
            .collect();

        // Poll each input component
        for id in input_ids {
            if let Some(component) = self.components.get_mut(&id) {
                if let Err(e) = component.call_method("read", ComponentValue::default()) {
                    log::debug!("Poll error for {}: {}", id, e);
                }
            }
        }

        Ok(())
    }

    /// Get the value of a component
    pub fn get_value(&self, id: &str) -> Option<ComponentValue> {
        self.components.get(id).map(|c| c.value())
    }

    /// Get values of all components connected to a target
    pub fn get_input_values(&self, target_id: &str) -> Vec<ComponentValue> {
        self.edges
            .iter()
            .filter(|e| e.target == target_id)
            .filter_map(|e| self.get_value(&e.source))
            .collect()
    }
}

impl Default for FlowExecutor {
    fn default() -> Self {
        Self::new()
    }
}
