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
    #[allow(dead_code)]
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
        // Handle internal events (prefixed with _) by routing back to source component
        if event.source_handle.starts_with('_') {
            log::info!("Processing internal event: {} ({}) -> {:?}", 
                event.source, event.source_handle, event.value);
            if let Some(component) = self.components.get_mut(&event.source) {
                // Strip the leading underscore for the method name
                let method = &event.source_handle[1..];
                match component.call_method(method, event.value) {
                    Ok(_) => log::info!("✓ Internal call {}.{}", event.source, method),
                    Err(e) => log::warn!("✗ Internal call {}.{} failed: {}", event.source, method, e),
                }
            }
            return;
        }
        
        let key = (event.source.clone(), event.source_handle.clone());

        log::info!("Processing event: {} ({}) -> looking for edges", event.source, event.source_handle);

        // Find all targets for this event
        let targets = match self.edge_map.get(&key) {
            Some(t) => {
                log::info!("Found {} target(s) for {} ({})", t.len(), event.source, event.source_handle);
                t.clone()
            }
            None => {
                log::info!("No edges found for {} ({})", event.source, event.source_handle);
                return;
            }
        };

        // Route to each target
        for (target_id, target_handle, _edge_id) in targets {
            log::info!("Routing to {}.{} with value {:?}", target_id, target_handle, event.value);
            
            // Check if target component aggregates inputs
            let aggregates = self.components.get(&target_id)
                .map(|c| c.aggregates_inputs())
                .unwrap_or(false);
            
            let args = if aggregates {
                let all_inputs = self.collect_input_values(&target_id, &target_handle);
                log::info!("Collected {} input values for {}.{}: {:?}", all_inputs.len(), target_id, target_handle, all_inputs);
                ComponentValue::Array(all_inputs)
            } else {
                event.value.clone()
            };
            
            if let Some(target) = self.components.get_mut(&target_id) {
                match target.call_method(&target_handle, args) {
                    Ok(_) => log::info!("✓ Successfully called {}.{}", target_id, target_handle),
                    Err(e) => log::warn!("✗ Failed to call {}.{}: {}", target_id, target_handle, e),
                }
            } else {
                log::warn!("Target component {} not found!", target_id);
            }
        }
    }
    
    /// Collect current values from all components connected to a target's specific handle
    fn collect_input_values(&self, target_id: &str, target_handle: &str) -> Vec<ComponentValue> {
        self.edges
            .iter()
            .filter(|e| e.target == target_id && e.target_handle == target_handle)
            .filter_map(|e| self.components.get(&e.source).map(|c| c.value()))
            .collect()
    }

    /// Get a component by ID
    #[allow(dead_code)]
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
    #[allow(dead_code)]
    pub fn get_value(&self, id: &str) -> Option<ComponentValue> {
        self.components.get(id).map(|c| c.value())
    }

    /// Get values of all components connected to a target
    #[allow(dead_code)]
    pub fn get_input_values(&self, target_id: &str) -> Vec<ComponentValue> {
        self.edges
            .iter()
            .filter(|e| e.target == target_id)
            .filter_map(|e| self.get_value(&e.source))
            .collect()
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
                    source: component_id.to_string(),
                    source_handle: "message".to_string(),
                    value: component_value,
                    edge_id: None,
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
