//! Tests that event processing logic never silently drops events.

use app_lib::runtime::{FlowExecutor, ComponentEvent, ComponentValue};
use std::sync::Arc;

#[test]
fn process_event_always_runs_when_called() {
    let mut executor = FlowExecutor::new();
    let event = ComponentEvent {
        source: Arc::from("test-source"),
        source_handle: Arc::from("value"),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 0,
    };
    let processed = executor.process_event(event);
    assert!(processed, "Event with sequence=0 must always be processed");
}

#[test]
fn process_event_discards_stale_sequence_only() {
    let mut executor = FlowExecutor::new();
    executor.set_current_sequence(5);

    let stale = ComponentEvent {
        source: Arc::from("old-source"),
        source_handle: Arc::from("value"),
        value: ComponentValue::Bool(false),
        edge_id: None,
        sequence: 3,
    };
    let current = ComponentEvent {
        source: Arc::from("new-source"),
        source_handle: Arc::from("value"),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 5,
    };

    assert!(!executor.process_event(stale), "Stale event must be discarded");
    assert!(executor.process_event(current), "Current-sequence event must be processed");
}
