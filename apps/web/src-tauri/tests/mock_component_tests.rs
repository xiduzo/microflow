//! Tests for `MockComponent`
//!
//! This test file verifies the `MockComponent` implementation for testing
//! event routing and value propagation.
//!
//! **Validates: Requirements 4.2**

mod common;

use common::{ComponentEvent, ComponentValue, MockComponent};

#[test]
fn test_new_component_has_no_events() {
    let component = MockComponent::new("test");
    assert_eq!(component.event_count(), 0);
    assert!(component.value().is_none());
}

#[test]
fn test_receive_event_increments_count() {
    let component = MockComponent::new("test");

    let event = ComponentEvent {
        source: "source".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 0,
    };

    component.receive_event(event);
    assert_eq!(component.event_count(), 1);
}

#[test]
fn test_receive_event_updates_value() {
    let component = MockComponent::new("test");

    let event = ComponentEvent {
        source: "source".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Number(42.0),
        edge_id: None,
        sequence: 0,
    };

    component.receive_event(event);
    assert_eq!(component.value(), Some(ComponentValue::Number(42.0)));
}

#[test]
fn test_multiple_events_tracks_last_value() {
    let component = MockComponent::new("test");

    let event1 = ComponentEvent {
        source: "source".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Number(1.0),
        edge_id: None,
        sequence: 0,
    };

    let event2 = ComponentEvent {
        source: "source".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Number(2.0),
        edge_id: None,
        sequence: 1,
    };

    let event3 = ComponentEvent {
        source: "source".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::String("hello".to_string()),
        edge_id: None,
        sequence: 2,
    };

    component.receive_event(event1);
    component.receive_event(event2);
    component.receive_event(event3);

    assert_eq!(component.event_count(), 3);
    assert_eq!(
        component.value(),
        Some(ComponentValue::String("hello".to_string()))
    );
}

#[test]
fn test_received_events_returns_all_events() {
    let component = MockComponent::new("test");

    let event1 = ComponentEvent {
        source: "source1".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 0,
    };

    let event2 = ComponentEvent {
        source: "source2".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Bool(false),
        edge_id: Some("edge1".to_string()),
        sequence: 1,
    };

    component.receive_event(event1);
    component.receive_event(event2);

    let events = component.received_events();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].source, "source1");
    assert_eq!(events[1].source, "source2");
    assert_eq!(events[1].edge_id, Some("edge1".to_string()));
}

#[test]
fn test_clear_resets_state() {
    let component = MockComponent::new("test");

    let event = ComponentEvent {
        source: "source".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 0,
    };

    component.receive_event(event);
    assert_eq!(component.event_count(), 1);
    assert!(component.value().is_some());

    component.clear();
    assert_eq!(component.event_count(), 0);
    assert!(component.value().is_none());
}

#[test]
fn test_default_trait() {
    let component = MockComponent::default();
    assert_eq!(component.id, "default");
    assert_eq!(component.event_count(), 0);
    assert!(component.value().is_none());
}

#[test]
fn test_component_id() {
    let component = MockComponent::new("my-component-id");
    assert_eq!(component.id, "my-component-id");
}

/// Test that `MockComponent` can be used for edge routing verification
/// **Validates: Requirements 4.2**
#[test]
fn test_event_routing_verification() {
    // Create source and target mock components
    let source = MockComponent::new("button-1");
    let target = MockComponent::new("led-1");

    // Simulate an event from source to target
    let event = ComponentEvent {
        source: source.id.clone(),
        source_handle: "pressed".to_string(),
        value: ComponentValue::Bool(true),
        edge_id: Some("edge-1".to_string()),
        sequence: 0,
    };

    // Target receives the event
    target.receive_event(event);

    // Verify the event was routed correctly
    assert_eq!(target.event_count(), 1);
    assert_eq!(target.value(), Some(ComponentValue::Bool(true)));

    // Verify event details
    let events = target.received_events();
    assert_eq!(events[0].source, "button-1");
    assert_eq!(events[0].source_handle, "pressed");
    assert_eq!(events[0].edge_id, Some("edge-1".to_string()));
}

/// Test that `MockComponent` correctly tracks value from events
/// **Validates: Requirements 4.3**
#[test]
fn test_target_receives_correct_value() {
    let target = MockComponent::new("target");

    // Test Bool value
    target.receive_event(ComponentEvent {
        source: "source".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 0,
    });
    assert_eq!(target.value(), Some(ComponentValue::Bool(true)));

    // Test Number value
    target.clear();
    target.receive_event(ComponentEvent {
        source: "source".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Number(123.456),
        edge_id: None,
        sequence: 1,
    });
    assert_eq!(target.value(), Some(ComponentValue::Number(123.456)));

    // Test String value
    target.clear();
    target.receive_event(ComponentEvent {
        source: "source".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::String("test message".to_string()),
        edge_id: None,
        sequence: 2,
    });
    assert_eq!(
        target.value(),
        Some(ComponentValue::String("test message".to_string()))
    );
}
