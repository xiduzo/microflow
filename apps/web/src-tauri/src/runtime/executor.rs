//! Flow Executor
//!
//! Handles the execution of flow graphs by routing events between components.

use super::base::{BoardHandle, Component, ComponentEvent, ComponentValue};
use super::types::FlowEdge;
use rustc_hash::{FxHashMap, FxHasher};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

/// Target information for an edge
#[derive(Clone)]
pub struct EdgeTarget {
    pub target_id: Arc<str>,
    pub target_handle: Arc<str>,
    /// Edge identifier for tracking (reserved for future use)
    #[allow(dead_code)]
    pub edge_id: Option<Arc<str>>,
}

/// Optimized edge lookup map using `FxHashMap` with pre-computed keys.
///
/// Uses `rustc_hash::FxHasher` for fast integer hashing of `(source, handle)` pairs.
/// Keys are pre-computed 64-bit hashes to avoid repeated string hashing on hot paths.
pub struct EdgeMap {
    map: FxHashMap<u64, Vec<EdgeTarget>>,
}

impl EdgeMap {
    pub fn new() -> Self {
        Self {
            map: FxHashMap::default(),
        }
    }

    /// Compute a hash key from source and handle strings
    #[inline]
    pub fn key(source: &str, handle: &str) -> u64 {
        let mut hasher = FxHasher::default();
        source.hash(&mut hasher);
        // Use a separator to avoid collisions like ("ab", "c") vs ("a", "bc")
        0u8.hash(&mut hasher);
        handle.hash(&mut hasher);
        hasher.finish()
    }

    /// Insert an edge target for a source/handle pair
    pub fn insert(&mut self, source: &str, handle: &str, target: EdgeTarget) {
        let key = Self::key(source, handle);
        self.map.entry(key).or_default().push(target);
    }

    /// Get all targets for a source/handle pair
    #[inline]
    pub fn get(&self, source: &str, handle: &str) -> Option<&[EdgeTarget]> {
        let key = Self::key(source, handle);
        self.map.get(&key).map(std::vec::Vec::as_slice)
    }

    /// Clear all edges
    pub fn clear(&mut self) {
        self.map.clear();
    }
}

impl Default for EdgeMap {
    fn default() -> Self {
        Self::new()
    }
}

/// Executes flow graphs by managing components and routing events.
///
/// Holds a map of components keyed by ID and an [`EdgeMap`] for O(1) event routing.
/// Stale events from previous flow versions are filtered by sequence number.
pub struct FlowExecutor {
    components: HashMap<String, Box<dyn Component>>,
    edges: Vec<FlowEdge>,
    /// Optimized edge lookup map using `FxHashMap` with pre-computed keys
    edge_map: EdgeMap,
    /// Current flow sequence for filtering stale events
    current_sequence: u64,
}

impl FlowExecutor {
    #[must_use] 
    pub fn new() -> Self {
        Self {
            components: HashMap::new(),
            edges: Vec::new(),
            edge_map: EdgeMap::new(),
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
        log::info!("Setting {} edges:", edges.len());
        for edge in &edges {
            log::info!("  Edge: {} ({}) -> {} ({})", 
                edge.source, edge.source_handle, 
                edge.target, edge.target_handle);
        }
        self.edges = edges;
        self.rebuild_edge_map();
    }

    /// Rebuild the edge lookup map
    fn rebuild_edge_map(&mut self) {
        self.edge_map.clear();

        for edge in &self.edges {
            let target = EdgeTarget {
                target_id: Arc::from(edge.target.as_str()),
                target_handle: Arc::from(edge.target_handle.as_str()),
                edge_id: edge.id.as_ref().map(|s| Arc::from(s.as_str())),
            };
            self.edge_map.insert(&edge.source, &edge.source_handle, target);
        }
    }

    /// Initialize all components that require hardware
    pub fn initialize_all(&mut self, board_handle: Arc<BoardHandle>) -> Result<(), String> {
        let mut errors = Vec::new();

        for (id, component) in &mut self.components {
            if component.requires_hardware() {
                if let Err(e) = component.initialize(board_handle.clone()) {
                    errors.push(format!("{id}: {e}"));
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
    /// Returns true if the event was processed, false if it was discarded as stale
    pub fn process_event(&mut self, event: ComponentEvent) -> bool {
        log::info!(">>> process_event called: {} ({}) seq={}", event.source, event.source_handle, event.sequence);
        
        // Check for stale events - discard events from previous flow versions.
        // sequence == 0 means "unsequenced" (emitted by component logic, not the board
        // reader callback). These are never stale — they are produced in direct response
        // to an already-validated event and must always be processed.
        // Only filter events that carry an explicit, non-zero sequence that predates the
        // current flow version (i.e. leftover board-reader events from the old flow).
        if event.sequence > 0 && event.sequence < self.current_sequence {
            log::debug!(
                "Discarding stale event from {} (seq={}, current={})",
                event.source,
                event.sequence,
                self.current_sequence
            );
            return false;
        }

        // Handle internal events (prefixed with _) by routing back to source component
        if event.source_handle.starts_with('_') {
            log::info!("Processing internal event: {} ({}) -> {:?}", 
                event.source, event.source_handle, event.value);
            if let Some(component) = self.components.get_mut(event.source.as_ref()) {
                // Strip the leading underscore for the method name
                let method = &event.source_handle[1..];
                match component.call_method(method, event.value) {
                    Ok(()) => log::info!("✓ Internal call {}.{}", event.source, method),
                    Err(e) => log::warn!("✗ Internal call {}.{} failed: {}", event.source, method, e),
                }
            }
            return true;
        }

        log::info!("Processing event: {} ({}) -> looking for edges (total edges: {})", 
            event.source, event.source_handle, self.edges.len());

        // Fast lookup using pre-computed hash
        let targets = if let Some(t) = self.edge_map.get(event.source.as_ref(), event.source_handle.as_ref()) {
            log::info!("Found {} target(s) for {} ({})", t.len(), event.source, event.source_handle);
            t.to_vec()  // Clone the slice for iteration
        } else {
            log::info!("No edges found for {} ({})", event.source, event.source_handle);
            return true;
        };

        // Route to each target using Arc<str> - no allocations
        for target in targets {
            log::info!("Routing to {}.{} with value {:?}", target.target_id, target.target_handle, event.value);
            
            // Check if target component aggregates inputs
            let aggregates = self.components.get(target.target_id.as_ref())
                .is_some_and(|c| c.aggregates_inputs());
            
            let args = if aggregates {
                let all_inputs = self.collect_input_values(target.target_id.as_ref(), target.target_handle.as_ref());
                log::info!("Collected {} input values for {}.{}: {:?}", all_inputs.len(), target.target_id, target.target_handle, all_inputs);
                ComponentValue::Array(all_inputs)
            } else {
                event.value.clone()
            };
            
            if let Some(component) = self.components.get_mut(target.target_id.as_ref()) {
                match component.call_method(&target.target_handle, args) {
                    Ok(()) => log::info!("✓ Successfully called {}.{}", target.target_id, target.target_handle),
                    Err(e) => log::warn!("✗ Failed to call {}.{}: {}", target.target_id, target.target_handle, e),
                }
            } else {
                log::warn!("Target component {} not found!", target.target_id);
            }
        }
        
        true
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

    /// Get values of all components connected to a target
    #[allow(dead_code)]
    #[must_use] 
    pub fn get_input_values(&self, target_id: &str) -> Vec<ComponentValue> {
        self.edges
            .iter()
            .filter(|e| e.target == target_id)
            .filter_map(|e| self.get_value(&e.source))
            .collect()
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
