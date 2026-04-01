//! Integration tests for flow edge routing.
//!
//! Tests that `FlowExecutor` correctly routes events through edges,
//! handles stale sequence filtering, and supports fan-out routing.

use app_lib::runtime::{ComponentEvent, ComponentValue, FlowEdge, FlowExecutor};
use app_lib::runtime::base::{BoardHandle, Component, ComponentBase};
use std::sync::Arc;
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Minimal mock component for routing tests
// ---------------------------------------------------------------------------

struct MockComponent {
    base: ComponentBase,
    last_method: Option<String>,
    call_count: usize,
}

impl MockComponent {
    fn new(id: &str) -> Self {
        Self {
            base: ComponentBase::new(id.to_string(), ComponentValue::Number(0.0)),
            last_method: None,
            call_count: 0,
        }
    }
}

impl Component for MockComponent {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, v: ComponentValue) { self.base.value = v; }
    fn component_type(&self) -> &'static str { "Mock" }
    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), app_lib::RuntimeError> { Ok(()) }
    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), app_lib::RuntimeError> {
        self.last_method = Some(method.to_string());
        self.call_count += 1;
        self.base.value = args;
        Ok(())
    }
    fn destroy(&mut self) {}
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> {
        self.base.event_sender.clone()
    }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) {
        self.base.event_sender = Some(sender);
    }
}

fn edge(source: &str, source_handle: &str, target: &str, target_handle: &str) -> FlowEdge {
    FlowEdge {
        id: None,
        source: source.to_string(),
        source_handle: source_handle.to_string(),
        target: target.to_string(),
        target_handle: target_handle.to_string(),
    }
}

fn event(source: &str, handle: &str, value: ComponentValue) -> ComponentEvent {
    ComponentEvent {
        source: Arc::from(source),
        source_handle: Arc::from(handle),
        value,
        edge_id: None,
        sequence: 0,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn test_single_edge_routing() {
    let mut executor = FlowExecutor::new();

    executor.add_component("button", Box::new(MockComponent::new("button")));
    executor.add_component("led", Box::new(MockComponent::new("led")));

    executor.set_edges(vec![
        edge("button", "event", "led", "value"),
    ]);

    executor.process_event(event("button", "event", ComponentValue::Bool(true)));

    let led = executor.get_component("led").unwrap();
    assert_eq!(led.value(), ComponentValue::Bool(true));
}

#[test]
fn test_no_edge_event_is_ignored() {
    let mut executor = FlowExecutor::new();

    executor.add_component("button", Box::new(MockComponent::new("button")));
    executor.add_component("led", Box::new(MockComponent::new("led")));
    // No edges wired

    let processed = executor.process_event(event("button", "event", ComponentValue::Bool(true)));

    assert!(processed, "Event should be processed (just has no targets)");
    let led = executor.get_component("led").unwrap();
    // Led value unchanged
    assert_eq!(led.value(), ComponentValue::Number(0.0));
}

#[test]
fn test_fan_out_routing() {
    let mut executor = FlowExecutor::new();

    executor.add_component("button", Box::new(MockComponent::new("button")));
    executor.add_component("led1", Box::new(MockComponent::new("led1")));
    executor.add_component("led2", Box::new(MockComponent::new("led2")));

    executor.set_edges(vec![
        edge("button", "event", "led1", "value"),
        edge("button", "event", "led2", "value"),
    ]);

    executor.process_event(event("button", "event", ComponentValue::Bool(true)));

    assert_eq!(executor.get_component("led1").unwrap().value(), ComponentValue::Bool(true));
    assert_eq!(executor.get_component("led2").unwrap().value(), ComponentValue::Bool(true));
}

#[test]
fn test_stale_event_is_discarded() {
    let mut executor = FlowExecutor::new();
    executor.set_current_sequence(5);

    executor.add_component("button", Box::new(MockComponent::new("button")));
    executor.add_component("led", Box::new(MockComponent::new("led")));
    executor.set_edges(vec![edge("button", "event", "led", "value")]);

    let stale = ComponentEvent {
        source: Arc::from("button"),
        source_handle: Arc::from("event"),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 3, // older than current_sequence=5
    };
    let discarded = !executor.process_event(stale);
    assert!(discarded, "Stale event must be discarded");

    // LED should not have been updated
    assert_eq!(executor.get_component("led").unwrap().value(), ComponentValue::Number(0.0));
}

#[test]
fn test_current_sequence_event_is_processed() {
    let mut executor = FlowExecutor::new();
    executor.set_current_sequence(5);

    executor.add_component("button", Box::new(MockComponent::new("button")));
    executor.add_component("led", Box::new(MockComponent::new("led")));
    executor.set_edges(vec![edge("button", "event", "led", "value")]);

    let current = ComponentEvent {
        source: Arc::from("button"),
        source_handle: Arc::from("event"),
        value: ComponentValue::Number(42.0),
        edge_id: None,
        sequence: 5,
    };
    let processed = executor.process_event(current);
    assert!(processed, "Current-sequence event must be processed");
    assert_eq!(executor.get_component("led").unwrap().value(), ComponentValue::Number(42.0));
}

#[test]
fn test_sequence_zero_always_processed() {
    let mut executor = FlowExecutor::new();
    executor.set_current_sequence(10);

    executor.add_component("src", Box::new(MockComponent::new("src")));
    executor.add_component("dst", Box::new(MockComponent::new("dst")));
    executor.set_edges(vec![edge("src", "out", "dst", "in")]);

    let unsequenced = ComponentEvent {
        source: Arc::from("src"),
        source_handle: Arc::from("out"),
        value: ComponentValue::Number(7.0),
        edge_id: None,
        sequence: 0, // unsequenced - always processes
    };
    let processed = executor.process_event(unsequenced);
    assert!(processed);
    assert_eq!(executor.get_component("dst").unwrap().value(), ComponentValue::Number(7.0));
}

#[test]
fn test_clear_removes_all_components_and_edges() {
    let mut executor = FlowExecutor::new();

    executor.add_component("a", Box::new(MockComponent::new("a")));
    executor.add_component("b", Box::new(MockComponent::new("b")));
    executor.set_edges(vec![edge("a", "out", "b", "in")]);

    executor.clear();

    // After clear, routing an event should not panic
    let processed = executor.process_event(event("a", "out", ComponentValue::Bool(true)));
    assert!(processed, "process_event after clear must not panic");
    assert!(executor.get_component("b").is_none());
}

#[test]
fn test_chain_routing() {
    // a -> b -> c
    let mut executor = FlowExecutor::new();

    executor.add_component("a", Box::new(MockComponent::new("a")));
    executor.add_component("b", Box::new(MockComponent::new("b")));
    executor.add_component("c", Box::new(MockComponent::new("c")));

    executor.set_edges(vec![
        edge("a", "out", "b", "in"),
        edge("b", "out", "c", "in"),
    ]);

    // Trigger a -> b
    executor.process_event(event("a", "out", ComponentValue::Number(1.0)));
    assert_eq!(executor.get_component("b").unwrap().value(), ComponentValue::Number(1.0));

    // b does not emit automatically (no event sender), so c is not triggered
    // by process_event("a",...). Manually trigger b -> c.
    executor.process_event(event("b", "out", ComponentValue::Number(2.0)));
    assert_eq!(executor.get_component("c").unwrap().value(), ComponentValue::Number(2.0));
}
