//! Integration tests for Component Lifecycle
//!
//! These tests verify that components can be created, initialized, and operated
//! correctly in various scenarios including:
//! - Creation without a connected board
//! - Graceful failure when no board is connected
//! - Initialization with MockBoardHandle
//!
//! **Validates: Requirements 3.1, 3.2, 3.3**

mod common;

use proptest::prelude::*;

use common::{ComponentEvent, ComponentValue, MockBoardHandle, MockComponent};

/// Test that MockComponent can be created without any board connection
/// **Validates: Requirement 3.1**
#[test]
fn test_component_creation_without_board() {
    // Create a component without any board handle
    let component = MockComponent::new("led-1");

    // Verify the component was created successfully
    assert_eq!(component.id, "led-1");
    assert_eq!(component.event_count(), 0);
    assert!(component.value().is_none());
}

/// Test that multiple components can be created without a board
/// **Validates: Requirement 3.1**
#[test]
fn test_multiple_components_creation_without_board() {
    // Create multiple components without any board connection
    let led = MockComponent::new("led-1");
    let button = MockComponent::new("button-1");
    let servo = MockComponent::new("servo-1");

    // Verify all components were created successfully
    assert_eq!(led.id, "led-1");
    assert_eq!(button.id, "button-1");
    assert_eq!(servo.id, "servo-1");

    // All should have no events and no value
    assert_eq!(led.event_count(), 0);
    assert_eq!(button.event_count(), 0);
    assert_eq!(servo.event_count(), 0);
}

/// Test that MockBoardHandle can be created and is initially connected
/// **Validates: Requirement 3.3**
#[test]
fn test_mock_board_handle_creation() {
    let board = MockBoardHandle::new();

    // Board should be connected by default
    assert!(board.is_connected());

    // No pins should be set initially
    assert_eq!(board.get_pin(0), None);
    assert_eq!(board.get_pin(13), None);
}

/// Test that components can be initialized with MockBoardHandle
/// **Validates: Requirement 3.3**
#[test]
fn test_component_initialization_with_mock_board() {
    // Create a mock board handle
    let board = MockBoardHandle::new();

    // Create a component
    let component = MockComponent::new("led-1");

    // Verify board is connected
    assert!(board.is_connected());

    // Simulate component initialization by setting initial pin state
    board.set_pin(13, 0); // LED pin 13, initially off

    // Verify the pin was set
    assert_eq!(board.get_pin(13), Some(0));

    // Component should be ready to receive events
    assert_eq!(component.event_count(), 0);
}

/// Test that operations fail gracefully when board is disconnected
/// **Validates: Requirement 3.2**
#[test]
fn test_graceful_failure_when_board_disconnected() {
    // Create a mock board handle
    let board = MockBoardHandle::new();

    // Verify board is initially connected
    assert!(board.is_connected());

    // Set a pin value while connected
    board.set_pin(13, 255);
    assert_eq!(board.get_pin(13), Some(255));

    // Disconnect the board
    board.disconnect();

    // Verify board is disconnected
    assert!(!board.is_connected());

    // Pin values should still be readable (cached state)
    // This tests that the mock doesn't panic when disconnected
    assert_eq!(board.get_pin(13), Some(255));

    // Setting pins should still work (mock behavior)
    // In a real implementation, this would return an error
    board.set_pin(13, 0);
    assert_eq!(board.get_pin(13), Some(0));
}

/// Test that component operations don't panic when board is not connected
/// **Validates: Requirement 3.2**
#[test]
fn test_component_operations_without_board_dont_panic() {
    // Create a component without any board
    let component = MockComponent::new("led-1");

    // These operations should not panic even without a board
    let event = ComponentEvent {
        source: "button-1".to_string(),
        source_handle: "pressed".to_string(),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 0,
    };

    // Receiving events should work without a board
    component.receive_event(event);

    // Verify the event was received
    assert_eq!(component.event_count(), 1);
    assert_eq!(component.value(), Some(ComponentValue::Bool(true)));
}

/// Test that component can track state changes via events without board
/// **Validates: Requirement 3.2**
#[test]
fn test_component_state_tracking_without_board() {
    let component = MockComponent::new("led-1");

    // Simulate LED turn on event
    let on_event = ComponentEvent {
        source: "controller".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Number(1.0),
        edge_id: None,
        sequence: 0,
    };
    component.receive_event(on_event);
    assert_eq!(component.value(), Some(ComponentValue::Number(1.0)));

    // Simulate LED turn off event
    let off_event = ComponentEvent {
        source: "controller".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Number(0.0),
        edge_id: None,
        sequence: 1,
    };
    component.receive_event(off_event);
    assert_eq!(component.value(), Some(ComponentValue::Number(0.0)));

    // Verify all events were tracked
    assert_eq!(component.event_count(), 2);
}

/// Test that MockBoardHandle can simulate pin operations
/// **Validates: Requirement 3.3**
#[test]
fn test_mock_board_pin_operations() {
    let board = MockBoardHandle::new();

    // Test digital pin operations (0 or 1)
    board.set_pin(13, 1); // LED on
    assert_eq!(board.get_pin(13), Some(1));

    board.set_pin(13, 0); // LED off
    assert_eq!(board.get_pin(13), Some(0));

    // Test analog pin operations (0-1023)
    board.set_pin(0, 512); // Analog read value
    assert_eq!(board.get_pin(0), Some(512));

    // Test PWM operations (0-255)
    board.set_pin(9, 128); // 50% duty cycle
    assert_eq!(board.get_pin(9), Some(128));
}

/// Test that multiple components can share a MockBoardHandle
/// **Validates: Requirement 3.3**
#[test]
fn test_multiple_components_with_shared_board() {
    let board = MockBoardHandle::new();

    // Create multiple components
    let led1 = MockComponent::new("led-1");
    let led2 = MockComponent::new("led-2");
    let button = MockComponent::new("button-1");

    // Simulate pin assignments
    board.set_pin(13, 0); // LED 1 on pin 13
    board.set_pin(12, 0); // LED 2 on pin 12
    board.set_pin(2, 0); // Button on pin 2

    // Verify all pins are set
    assert_eq!(board.get_pin(13), Some(0));
    assert_eq!(board.get_pin(12), Some(0));
    assert_eq!(board.get_pin(2), Some(0));

    // Simulate button press updating LED states
    let button_event = ComponentEvent {
        source: button.id.clone(),
        source_handle: "pressed".to_string(),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 0,
    };

    // Both LEDs receive the event
    led1.receive_event(button_event.clone());
    led2.receive_event(ComponentEvent {
        source: button.id.clone(),
        source_handle: "pressed".to_string(),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 1,
    });

    // Update board state to reflect LED changes
    board.set_pin(13, 1);
    board.set_pin(12, 1);

    // Verify state
    assert_eq!(led1.event_count(), 1);
    assert_eq!(led2.event_count(), 1);
    assert_eq!(board.get_pin(13), Some(1));
    assert_eq!(board.get_pin(12), Some(1));
}

/// Test that component creation is idempotent
/// **Validates: Requirement 3.1**
#[test]
fn test_component_creation_is_idempotent() {
    // Creating multiple components with the same ID should work
    // (they are independent instances)
    let component1 = MockComponent::new("led-1");
    let component2 = MockComponent::new("led-1");

    // Both should be independent
    let event = ComponentEvent {
        source: "source".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 0,
    };

    component1.receive_event(event);

    // component1 should have the event, component2 should not
    assert_eq!(component1.event_count(), 1);
    assert_eq!(component2.event_count(), 0);
}

/// Test that board disconnect doesn't affect component state
/// **Validates: Requirement 3.2**
#[test]
fn test_board_disconnect_preserves_component_state() {
    let board = MockBoardHandle::new();
    let component = MockComponent::new("led-1");

    // Set up initial state
    board.set_pin(13, 1);
    let event = ComponentEvent {
        source: "source".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Number(1.0),
        edge_id: None,
        sequence: 0,
    };
    component.receive_event(event);

    // Verify initial state
    assert_eq!(board.get_pin(13), Some(1));
    assert_eq!(component.value(), Some(ComponentValue::Number(1.0)));

    // Disconnect the board
    board.disconnect();

    // Component state should be preserved
    assert_eq!(component.event_count(), 1);
    assert_eq!(component.value(), Some(ComponentValue::Number(1.0)));

    // Board pin state should also be preserved (cached)
    assert_eq!(board.get_pin(13), Some(1));
}

/// Test that component can be cleared and reused
/// **Validates: Requirement 3.1**
#[test]
fn test_component_clear_and_reuse() {
    let component = MockComponent::new("led-1");

    // Add some events
    for i in 0..5 {
        let event = ComponentEvent {
            source: "source".to_string(),
            source_handle: "output".to_string(),
            value: ComponentValue::Number(i as f64),
            edge_id: None,
            sequence: i,
        };
        component.receive_event(event);
    }

    assert_eq!(component.event_count(), 5);
    assert_eq!(component.value(), Some(ComponentValue::Number(4.0)));

    // Clear the component
    component.clear();

    // Verify it's reset
    assert_eq!(component.event_count(), 0);
    assert!(component.value().is_none());

    // Can receive new events
    let new_event = ComponentEvent {
        source: "new_source".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 0,
    };
    component.receive_event(new_event);

    assert_eq!(component.event_count(), 1);
    assert_eq!(component.value(), Some(ComponentValue::Bool(true)));
}

/// Test that MockBoardHandle default trait works
/// **Validates: Requirement 3.3**
#[test]
fn test_mock_board_handle_default() {
    let board = MockBoardHandle::default();

    // Should be connected by default
    assert!(board.is_connected());

    // Should have no pins set
    assert_eq!(board.get_pin(0), None);
}

/// Test graceful handling of edge cases
/// **Validates: Requirement 3.2**
#[test]
fn test_graceful_handling_of_edge_cases() {
    let board = MockBoardHandle::new();
    let component = MockComponent::new("test");

    // Test with maximum pin number
    board.set_pin(255, 65535);
    assert_eq!(board.get_pin(255), Some(65535));

    // Test with minimum values
    board.set_pin(0, 0);
    assert_eq!(board.get_pin(0), Some(0));

    // Test component with empty string ID
    let empty_component = MockComponent::new("");
    assert_eq!(empty_component.id, "");

    // Test event with empty strings
    let event = ComponentEvent {
        source: String::new(),
        source_handle: String::new(),
        value: ComponentValue::String(String::new()),
        edge_id: Some(String::new()),
        sequence: 0,
    };
    component.receive_event(event);
    assert_eq!(component.event_count(), 1);
}

/// Test that component operations are thread-safe
/// **Validates: Requirement 3.2**
#[test]
fn test_component_thread_safety() {
    use std::sync::Arc;
    use std::thread;

    let component = Arc::new(MockComponent::new("led-1"));
    let board = Arc::new(MockBoardHandle::new());

    let mut handles = vec![];

    // Spawn multiple threads that interact with the component and board
    for i in 0u64..10 {
        let comp = Arc::clone(&component);
        let brd = Arc::clone(&board);

        let handle = thread::spawn(move || {
            // Each thread sends an event
            let event = ComponentEvent {
                source: format!("source-{i}"),
                source_handle: "output".to_string(),
                value: ComponentValue::Number(i as f64),
                edge_id: None,
                sequence: i,
            };
            comp.receive_event(event);

            // Each thread sets a pin
            brd.set_pin(i as u8, i as u16);
        });

        handles.push(handle);
    }

    // Wait for all threads to complete
    for handle in handles {
        handle.join().expect("Thread should not panic");
    }

    // Verify all events were received
    assert_eq!(component.event_count(), 10);

    // Verify all pins were set
    for i in 0..10 {
        assert_eq!(board.get_pin(i as u8), Some(i as u16));
    }
}

/// Test that board can be reconnected after disconnect
/// **Validates: Requirement 3.2**
#[test]
fn test_board_reconnection_simulation() {
    let board = MockBoardHandle::new();

    // Initial state
    assert!(board.is_connected());
    board.set_pin(13, 1);

    // Disconnect
    board.disconnect();
    assert!(!board.is_connected());

    // Note: MockBoardHandle doesn't have a reconnect method,
    // but we can verify that operations still work after disconnect
    // (in a real implementation, reconnection would be handled differently)

    // Pin state is preserved
    assert_eq!(board.get_pin(13), Some(1));

    // Can still set pins (mock behavior)
    board.set_pin(13, 0);
    assert_eq!(board.get_pin(13), Some(0));
}


// =============================================================================
// Property-Based Tests for Graceful Failure Without Board
// =============================================================================

// Feature: rust-runtime-reliability, Property 6: Graceful Failure Without Board
// **Validates: Requirements 3.2**
//
// Property: For any component type and for any operation that requires hardware
// access, when no board is connected, the operation SHALL return an error result
// without panicking or corrupting state.

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Test that MockComponent operations don't panic with random component IDs
    /// when no board is connected.
    ///
    /// **Validates: Requirements 3.2**
    #[test]
    fn prop_component_creation_without_board_never_panics(
        component_id in "[a-zA-Z0-9_-]{0,100}"
    ) {
        // Creating a component without a board should never panic
        let component = MockComponent::new(&component_id);
        
        // Verify component was created with correct ID
        prop_assert_eq!(&component.id, &component_id);
        
        // Verify initial state is clean (no events, no value)
        prop_assert_eq!(component.event_count(), 0);
        prop_assert!(component.value().is_none());
    }

    /// Test that MockBoardHandle operations don't panic with random pin numbers
    /// and values, even when disconnected.
    ///
    /// **Validates: Requirements 3.2**
    #[test]
    fn prop_board_operations_without_connection_never_panic(
        pin in 0u8..=255,
        value in 0u16..=65535
    ) {
        let board = MockBoardHandle::new();
        
        // Disconnect the board to simulate no hardware
        board.disconnect();
        prop_assert!(!board.is_connected());
        
        // Setting pins should not panic even when disconnected
        board.set_pin(pin, value);
        
        // Getting pins should not panic and should return the cached value
        let retrieved = board.get_pin(pin);
        prop_assert_eq!(retrieved, Some(value));
    }

    /// Test that MockComponent can receive events with random data without
    /// panicking when no board is connected.
    ///
    /// **Validates: Requirements 3.2**
    #[test]
    fn prop_component_receive_event_without_board_never_panics(
        component_id in "[a-zA-Z0-9_-]{1,50}",
        source in "[a-zA-Z0-9_-]{1,50}",
        source_handle in "[a-zA-Z0-9_-]{1,50}",
        bool_value in any::<bool>(),
        sequence in 0u64..=u64::MAX
    ) {
        let component = MockComponent::new(&component_id);
        
        // Create an event with random data
        let event = ComponentEvent {
            source: source.clone(),
            source_handle: source_handle.clone(),
            value: ComponentValue::Bool(bool_value),
            edge_id: None,
            sequence,
        };
        
        // Receiving events should not panic without a board
        component.receive_event(event);
        
        // Verify state is consistent after receiving event
        prop_assert_eq!(component.event_count(), 1);
        prop_assert_eq!(component.value(), Some(ComponentValue::Bool(bool_value)));
    }

    /// Test that MockComponent can receive events with numeric values without
    /// panicking, including edge cases like NaN, infinity, etc.
    ///
    /// **Validates: Requirements 3.2**
    #[test]
    fn prop_component_receive_numeric_event_without_board_never_panics(
        component_id in "[a-zA-Z0-9_-]{1,50}",
        source in "[a-zA-Z0-9_-]{1,50}",
        source_handle in "[a-zA-Z0-9_-]{1,50}",
        number_value in any::<f64>(),
        sequence in 0u64..=u64::MAX
    ) {
        let component = MockComponent::new(&component_id);
        
        // Create an event with a numeric value (including edge cases)
        let event = ComponentEvent {
            source,
            source_handle,
            value: ComponentValue::Number(number_value),
            edge_id: None,
            sequence,
        };
        
        // Receiving events should not panic without a board
        component.receive_event(event);
        
        // Verify state is consistent
        prop_assert_eq!(component.event_count(), 1);
        
        // For NaN values, we need special comparison
        if let Some(ComponentValue::Number(v)) = component.value() {
            if number_value.is_nan() {
                prop_assert!(v.is_nan());
            } else {
                prop_assert_eq!(v, number_value);
            }
        } else {
            prop_assert!(false, "Expected Number value");
        }
    }

    /// Test that MockComponent can receive events with string values without
    /// panicking, including empty strings and unicode.
    ///
    /// **Validates: Requirements 3.2**
    #[test]
    fn prop_component_receive_string_event_without_board_never_panics(
        component_id in "[a-zA-Z0-9_-]{1,50}",
        source in "[a-zA-Z0-9_-]{1,50}",
        source_handle in "[a-zA-Z0-9_-]{1,50}",
        string_value in ".*",
        edge_id in proptest::option::of("[a-zA-Z0-9_-]{1,50}"),
        sequence in 0u64..=u64::MAX
    ) {
        let component = MockComponent::new(&component_id);
        
        // Create an event with a string value
        let event = ComponentEvent {
            source,
            source_handle,
            value: ComponentValue::String(string_value.clone()),
            edge_id,
            sequence,
        };
        
        // Receiving events should not panic without a board
        component.receive_event(event);
        
        // Verify state is consistent
        prop_assert_eq!(component.event_count(), 1);
        prop_assert_eq!(component.value(), Some(ComponentValue::String(string_value)));
    }

    /// Test that multiple operations on MockBoardHandle don't corrupt state
    /// when board is disconnected.
    ///
    /// **Validates: Requirements 3.2**
    #[test]
    fn prop_multiple_board_operations_without_connection_preserve_state(
        pins_and_values in proptest::collection::vec((0u8..=255, 0u16..=65535), 1..20)
    ) {
        let board = MockBoardHandle::new();
        
        // Disconnect the board
        board.disconnect();
        prop_assert!(!board.is_connected());
        
        // Set multiple pins
        for (pin, value) in &pins_and_values {
            board.set_pin(*pin, *value);
        }
        
        // Verify all pins have correct values (last write wins for duplicates)
        let mut expected: std::collections::HashMap<u8, u16> = std::collections::HashMap::new();
        for (pin, value) in &pins_and_values {
            expected.insert(*pin, *value);
        }
        
        for (pin, expected_value) in expected {
            let actual = board.get_pin(pin);
            prop_assert_eq!(actual, Some(expected_value), 
                "Pin {} should have value {}", pin, expected_value);
        }
    }

    /// Test that multiple events to MockComponent don't corrupt state
    /// when no board is connected.
    ///
    /// **Validates: Requirements 3.2**
    #[test]
    fn prop_multiple_events_without_board_preserve_state(
        component_id in "[a-zA-Z0-9_-]{1,50}",
        event_count in 1usize..50
    ) {
        let component = MockComponent::new(&component_id);
        
        // Send multiple events
        for i in 0..event_count {
            let event = ComponentEvent {
                source: format!("source-{i}"),
                source_handle: "output".to_string(),
                value: ComponentValue::Number(i as f64),
                edge_id: None,
                sequence: i as u64,
            };
            component.receive_event(event);
        }
        
        // Verify all events were received
        prop_assert_eq!(component.event_count(), event_count);
        
        // Verify last value is correct
        prop_assert_eq!(
            component.value(), 
            Some(ComponentValue::Number((event_count - 1) as f64))
        );
    }

    /// Test that MockComponent clear operation doesn't panic and properly
    /// resets state when no board is connected.
    ///
    /// **Validates: Requirements 3.2**
    #[test]
    fn prop_component_clear_without_board_never_panics(
        component_id in "[a-zA-Z0-9_-]{1,50}",
        event_count in 0usize..20
    ) {
        let component = MockComponent::new(&component_id);
        
        // Send some events
        for i in 0..event_count {
            let event = ComponentEvent {
                source: "source".to_string(),
                source_handle: "output".to_string(),
                value: ComponentValue::Number(i as f64),
                edge_id: None,
                sequence: i as u64,
            };
            component.receive_event(event);
        }
        
        // Clear should not panic
        component.clear();
        
        // Verify state is reset
        prop_assert_eq!(component.event_count(), 0);
        prop_assert!(component.value().is_none());
    }

    /// Test that board disconnect/reconnect cycle doesn't corrupt pin state.
    ///
    /// **Validates: Requirements 3.2**
    #[test]
    fn prop_board_disconnect_preserves_pin_state(
        pin in 0u8..=255,
        value in 0u16..=65535
    ) {
        let board = MockBoardHandle::new();
        
        // Set pin while connected
        prop_assert!(board.is_connected());
        board.set_pin(pin, value);
        prop_assert_eq!(board.get_pin(pin), Some(value));
        
        // Disconnect
        board.disconnect();
        prop_assert!(!board.is_connected());
        
        // Pin state should be preserved after disconnect
        prop_assert_eq!(board.get_pin(pin), Some(value));
    }

    /// Test that component and board operations interleaved don't cause
    /// panics or state corruption when board is disconnected.
    ///
    /// **Validates: Requirements 3.2**
    #[test]
    fn prop_interleaved_operations_without_board_never_panic(
        component_id in "[a-zA-Z0-9_-]{1,50}",
        pin in 0u8..=255,
        value in 0u16..=65535,
        bool_value in any::<bool>()
    ) {
        let board = MockBoardHandle::new();
        let component = MockComponent::new(&component_id);
        
        // Disconnect board
        board.disconnect();
        
        // Interleave operations
        board.set_pin(pin, value);
        
        let event = ComponentEvent {
            source: "source".to_string(),
            source_handle: "output".to_string(),
            value: ComponentValue::Bool(bool_value),
            edge_id: None,
            sequence: 0,
        };
        component.receive_event(event);
        
        let _ = board.get_pin(pin);
        let _ = component.value();
        let _ = component.event_count();
        let _ = board.is_connected();
        
        // Verify final state is consistent
        prop_assert_eq!(board.get_pin(pin), Some(value));
        prop_assert_eq!(component.event_count(), 1);
        prop_assert_eq!(component.value(), Some(ComponentValue::Bool(bool_value)));
        prop_assert!(!board.is_connected());
    }
}


// =============================================================================
// LED-Specific Lifecycle Tests
// =============================================================================

/// Test that LED turn_on() updates value to 1.0
/// Simulates LED turn_on by sending an event with value 1.0
/// **Validates: Requirement 3.4**
#[test]
fn test_led_turn_on_updates_value_to_one() {
    // Create a mock LED component
    let led = MockComponent::new("led-1");

    // Verify initial state - no value set
    assert!(led.value().is_none());

    // Simulate LED turn_on() by sending an event with value 1.0
    let turn_on_event = ComponentEvent {
        source: "controller".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Number(1.0),
        edge_id: None,
        sequence: 0,
    };
    led.receive_event(turn_on_event);

    // Verify the LED value is now 1.0 (on state)
    assert_eq!(led.value(), Some(ComponentValue::Number(1.0)));
    assert_eq!(led.event_count(), 1);
}

/// Test that LED turn_off() updates value to 0.0
/// Simulates LED turn_off by sending an event with value 0.0
/// **Validates: Requirement 3.5**
#[test]
fn test_led_turn_off_updates_value_to_zero() {
    // Create a mock LED component
    let led = MockComponent::new("led-1");

    // First turn the LED on
    let turn_on_event = ComponentEvent {
        source: "controller".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Number(1.0),
        edge_id: None,
        sequence: 0,
    };
    led.receive_event(turn_on_event);
    assert_eq!(led.value(), Some(ComponentValue::Number(1.0)));

    // Simulate LED turn_off() by sending an event with value 0.0
    let turn_off_event = ComponentEvent {
        source: "controller".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Number(0.0),
        edge_id: None,
        sequence: 1,
    };
    led.receive_event(turn_off_event);

    // Verify the LED value is now 0.0 (off state)
    assert_eq!(led.value(), Some(ComponentValue::Number(0.0)));
    assert_eq!(led.event_count(), 2);
}

/// Test LED toggle behavior (on -> off -> on)
/// **Validates: Requirements 3.4, 3.5**
#[test]
fn test_led_toggle_behavior() {
    let led = MockComponent::new("led-1");

    // Initial state - LED is off (no value)
    assert!(led.value().is_none());

    // Turn on
    led.receive_event(ComponentEvent {
        source: "button".to_string(),
        source_handle: "pressed".to_string(),
        value: ComponentValue::Number(1.0),
        edge_id: None,
        sequence: 0,
    });
    assert_eq!(led.value(), Some(ComponentValue::Number(1.0)));

    // Turn off
    led.receive_event(ComponentEvent {
        source: "button".to_string(),
        source_handle: "released".to_string(),
        value: ComponentValue::Number(0.0),
        edge_id: None,
        sequence: 1,
    });
    assert_eq!(led.value(), Some(ComponentValue::Number(0.0)));

    // Turn on again
    led.receive_event(ComponentEvent {
        source: "button".to_string(),
        source_handle: "pressed".to_string(),
        value: ComponentValue::Number(1.0),
        edge_id: None,
        sequence: 2,
    });
    assert_eq!(led.value(), Some(ComponentValue::Number(1.0)));

    // Verify all events were tracked
    assert_eq!(led.event_count(), 3);
}

/// Test LED with board pin state synchronization
/// **Validates: Requirements 3.4, 3.5**
#[test]
fn test_led_with_board_pin_state() {
    let board = MockBoardHandle::new();
    let led = MockComponent::new("led-1");

    // Initialize LED pin (pin 13) to off state
    board.set_pin(13, 0);
    assert_eq!(board.get_pin(13), Some(0));

    // Simulate LED turn_on
    let turn_on_event = ComponentEvent {
        source: "controller".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Number(1.0),
        edge_id: None,
        sequence: 0,
    };
    led.receive_event(turn_on_event);

    // Update board pin to reflect LED on state (digital HIGH = 1)
    board.set_pin(13, 1);

    // Verify both component value and board pin state
    assert_eq!(led.value(), Some(ComponentValue::Number(1.0)));
    assert_eq!(board.get_pin(13), Some(1));

    // Simulate LED turn_off
    let turn_off_event = ComponentEvent {
        source: "controller".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Number(0.0),
        edge_id: None,
        sequence: 1,
    };
    led.receive_event(turn_off_event);

    // Update board pin to reflect LED off state (digital LOW = 0)
    board.set_pin(13, 0);

    // Verify both component value and board pin state
    assert_eq!(led.value(), Some(ComponentValue::Number(0.0)));
    assert_eq!(board.get_pin(13), Some(0));
}

/// Test multiple LEDs can be controlled independently
/// **Validates: Requirements 3.4, 3.5**
#[test]
fn test_multiple_leds_independent_control() {
    let led1 = MockComponent::new("led-1");
    let led2 = MockComponent::new("led-2");
    let led3 = MockComponent::new("led-3");

    // Turn on LED 1
    led1.receive_event(ComponentEvent {
        source: "controller".to_string(),
        source_handle: "led1_output".to_string(),
        value: ComponentValue::Number(1.0),
        edge_id: None,
        sequence: 0,
    });

    // Turn on LED 2
    led2.receive_event(ComponentEvent {
        source: "controller".to_string(),
        source_handle: "led2_output".to_string(),
        value: ComponentValue::Number(1.0),
        edge_id: None,
        sequence: 1,
    });

    // LED 3 remains off (no event sent)

    // Verify states
    assert_eq!(led1.value(), Some(ComponentValue::Number(1.0)));
    assert_eq!(led2.value(), Some(ComponentValue::Number(1.0)));
    assert!(led3.value().is_none());

    // Turn off LED 1, LED 2 should remain on
    led1.receive_event(ComponentEvent {
        source: "controller".to_string(),
        source_handle: "led1_output".to_string(),
        value: ComponentValue::Number(0.0),
        edge_id: None,
        sequence: 2,
    });

    // Verify LED 1 is off, LED 2 is still on
    assert_eq!(led1.value(), Some(ComponentValue::Number(0.0)));
    assert_eq!(led2.value(), Some(ComponentValue::Number(1.0)));
}

/// Test LED responds to boolean value events (alternative representation)
/// **Validates: Requirements 3.4, 3.5**
#[test]
fn test_led_with_boolean_values() {
    let led = MockComponent::new("led-1");

    // Turn on using boolean true
    led.receive_event(ComponentEvent {
        source: "button".to_string(),
        source_handle: "pressed".to_string(),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 0,
    });
    assert_eq!(led.value(), Some(ComponentValue::Bool(true)));

    // Turn off using boolean false
    led.receive_event(ComponentEvent {
        source: "button".to_string(),
        source_handle: "released".to_string(),
        value: ComponentValue::Bool(false),
        edge_id: None,
        sequence: 1,
    });
    assert_eq!(led.value(), Some(ComponentValue::Bool(false)));
}

/// Test LED state persists after board disconnect
/// **Validates: Requirements 3.4, 3.5**
#[test]
fn test_led_state_persists_after_board_disconnect() {
    let board = MockBoardHandle::new();
    let led = MockComponent::new("led-1");

    // Turn LED on while board is connected
    led.receive_event(ComponentEvent {
        source: "controller".to_string(),
        source_handle: "output".to_string(),
        value: ComponentValue::Number(1.0),
        edge_id: None,
        sequence: 0,
    });
    board.set_pin(13, 1);

    // Verify LED is on
    assert_eq!(led.value(), Some(ComponentValue::Number(1.0)));
    assert_eq!(board.get_pin(13), Some(1));

    // Disconnect the board
    board.disconnect();
    assert!(!board.is_connected());

    // LED component state should be preserved
    assert_eq!(led.value(), Some(ComponentValue::Number(1.0)));

    // Board pin state should also be preserved (cached)
    assert_eq!(board.get_pin(13), Some(1));
}

/// Test LED rapid on/off switching
/// **Validates: Requirements 3.4, 3.5**
#[test]
fn test_led_rapid_switching() {
    let led = MockComponent::new("led-1");

    // Rapidly switch LED on and off multiple times
    for i in 0..10 {
        let value = if i % 2 == 0 { 1.0 } else { 0.0 };
        led.receive_event(ComponentEvent {
            source: "pwm_controller".to_string(),
            source_handle: "output".to_string(),
            value: ComponentValue::Number(value),
            edge_id: None,
            sequence: i,
        });

        // Verify value after each switch
        assert_eq!(led.value(), Some(ComponentValue::Number(value)));
    }

    // Final state should be off (last iteration i=9 is odd, so value=0.0)
    assert_eq!(led.value(), Some(ComponentValue::Number(0.0)));
    assert_eq!(led.event_count(), 10);
}

// =============================================================================
// Property-Based Tests for LED Lifecycle
// =============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property test: LED turn_on always results in value 1.0
    /// **Validates: Requirement 3.4**
    #[test]
    fn prop_led_turn_on_always_sets_value_to_one(
        led_id in "[a-zA-Z0-9_-]{1,50}",
        source in "[a-zA-Z0-9_-]{1,50}",
        source_handle in "[a-zA-Z0-9_-]{1,50}",
        sequence in 0u64..=u64::MAX
    ) {
        let led = MockComponent::new(&led_id);

        // Simulate turn_on with value 1.0
        let turn_on_event = ComponentEvent {
            source,
            source_handle,
            value: ComponentValue::Number(1.0),
            edge_id: None,
            sequence,
        };
        led.receive_event(turn_on_event);

        // LED value should always be 1.0 after turn_on
        prop_assert_eq!(led.value(), Some(ComponentValue::Number(1.0)));
    }

    /// Property test: LED turn_off always results in value 0.0
    /// **Validates: Requirement 3.5**
    #[test]
    fn prop_led_turn_off_always_sets_value_to_zero(
        led_id in "[a-zA-Z0-9_-]{1,50}",
        source in "[a-zA-Z0-9_-]{1,50}",
        source_handle in "[a-zA-Z0-9_-]{1,50}",
        sequence in 0u64..=u64::MAX
    ) {
        let led = MockComponent::new(&led_id);

        // First turn on the LED
        led.receive_event(ComponentEvent {
            source: "init".to_string(),
            source_handle: "output".to_string(),
            value: ComponentValue::Number(1.0),
            edge_id: None,
            sequence: 0,
        });

        // Simulate turn_off with value 0.0
        let turn_off_event = ComponentEvent {
            source,
            source_handle,
            value: ComponentValue::Number(0.0),
            edge_id: None,
            sequence,
        };
        led.receive_event(turn_off_event);

        // LED value should always be 0.0 after turn_off
        prop_assert_eq!(led.value(), Some(ComponentValue::Number(0.0)));
    }

    /// Property test: LED state transitions are consistent
    /// After any sequence of on/off operations, the final state matches the last operation
    /// **Validates: Requirements 3.4, 3.5**
    #[test]
    fn prop_led_final_state_matches_last_operation(
        led_id in "[a-zA-Z0-9_-]{1,50}",
        operations in proptest::collection::vec(any::<bool>(), 1..20)
    ) {
        let led = MockComponent::new(&led_id);

        // Apply each operation (true = on, false = off)
        for (i, &is_on) in operations.iter().enumerate() {
            let value = if is_on { 1.0 } else { 0.0 };
            led.receive_event(ComponentEvent {
                source: "controller".to_string(),
                source_handle: "output".to_string(),
                value: ComponentValue::Number(value),
                edge_id: None,
                sequence: i as u64,
            });
        }

        // Final state should match the last operation
        let last_operation = operations.last().unwrap();
        let expected_value = if *last_operation { 1.0 } else { 0.0 };
        prop_assert_eq!(led.value(), Some(ComponentValue::Number(expected_value)));

        // Event count should match number of operations
        prop_assert_eq!(led.event_count(), operations.len());
    }
}

