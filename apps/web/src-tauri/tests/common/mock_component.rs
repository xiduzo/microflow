#![allow(dead_code)]
//! Mock component for testing event routing
//!
//! This module provides a `MockComponent` that simulates a flow component
//! for testing purposes, allowing tests to verify event routing and
//! value propagation without actual hardware components.

use std::sync::RwLock;

/// Simplified `ComponentValue` for testing
/// Mirrors the main crate's `ComponentValue` enum
#[derive(Debug, Clone, PartialEq)]
pub enum ComponentValue {
    Bool(bool),
    Number(f64),
    String(String),
}

impl Default for ComponentValue {
    fn default() -> Self {
        ComponentValue::Number(0.0)
    }
}

/// Simplified `ComponentEvent` for testing
/// Mirrors the main crate's `ComponentEvent` struct
#[derive(Debug, Clone)]
pub struct ComponentEvent {
    pub source: String,
    pub source_handle: String,
    pub value: ComponentValue,
    pub edge_id: Option<String>,
    pub sequence: u64,
}

/// Mock component for testing event routing
pub struct MockComponent {
    /// Component identifier
    pub id: String,
    /// All events received by this component
    pub received_events: RwLock<Vec<ComponentEvent>>,
    /// The most recent value received from an event
    pub current_value: RwLock<Option<ComponentValue>>,
}

impl MockComponent {
    /// Create a new mock component with the given ID
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            received_events: RwLock::new(Vec::new()),
            current_value: RwLock::new(None),
        }
    }

    /// Receive an event and track it
    pub fn receive_event(&self, event: ComponentEvent) {
        if let Ok(mut guard) = self.received_events.write() {
            guard.push(event.clone());
        }
        if let Ok(mut guard) = self.current_value.write() {
            *guard = Some(event.value);
        }
    }

    /// Get the count of received events
    pub fn event_count(&self) -> usize {
        self.received_events.read().map_or(0, |g| g.len())
    }

    /// Get the current value (last received event's value)
    pub fn value(&self) -> Option<ComponentValue> {
        self.current_value.read().ok().and_then(|g| g.clone())
    }

    /// Get all received events
    pub fn received_events(&self) -> Vec<ComponentEvent> {
        self.received_events
            .read()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// Clear all received events and reset current value
    pub fn clear(&self) {
        if let Ok(mut guard) = self.received_events.write() {
            guard.clear();
        }
        if let Ok(mut guard) = self.current_value.write() {
            *guard = None;
        }
    }
}

impl Default for MockComponent {
    fn default() -> Self {
        Self::new("default")
    }
}
