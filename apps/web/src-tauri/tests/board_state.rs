//! Property-based tests for Board Connection State Machine
//!
//! These tests verify the correctness of the `BoardStateMachine`'s atomic
//! state transitions using the proptest framework.
//!
//! **Validates: Requirements 2.4, 2.5, 2.6**

use proptest::prelude::*;

// Import the BoardStateMachine and BoardConnectionState from the main crate
use app_lib::hardware::{BoardConnectionState, BoardStateMachine};

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    // Feature: rust-runtime-reliability, Property 4: Atomic State Transition Correctness
    // **Validates: Requirements 2.4, 2.5, 2.6**
    //
    // *For any* BoardStateMachine in state S, and *for any* transition attempt from state F to state T:
    // - If F equals S, the transition succeeds and current() returns T
    // - If F does not equal S, the transition fails and current() returns S (unchanged)
    #[test]
    fn transition_succeeds_only_when_from_matches(
        initial_state in 0u8..6,
        from_state in 0u8..6,
        to_state in 0u8..6
    ) {
        let sm = BoardStateMachine::new();
        // Set initial state using the force_state_raw method
        sm.force_state_raw(initial_state);

        let from = BoardConnectionState::from_u8(from_state);
        let to = BoardConnectionState::from_u8(to_state);

        let result = sm.transition(from, to);

        if initial_state == from_state {
            prop_assert!(result, "Transition should succeed when from matches current state");
            prop_assert_eq!(
                sm.current_raw(),
                to_state,
                "State should be updated to 'to' state after successful transition"
            );
        } else {
            prop_assert!(!result, "Transition should fail when from doesn't match current state");
            prop_assert_eq!(
                sm.current_raw(),
                initial_state,
                "State should remain unchanged after failed transition"
            );
        }
    }

    // Feature: rust-runtime-reliability, Property 4: Atomic State Transition Correctness (All States)
    // **Validates: Requirements 2.4, 2.5, 2.6**
    //
    // This test verifies that all valid BoardConnectionState values can be used
    // in transitions and that the state machine correctly handles each state.
    #[test]
    fn all_states_are_valid_for_transitions(
        state_value in 0u8..6
    ) {
        let sm = BoardStateMachine::new();
        let state = BoardConnectionState::from_u8(state_value);

        // Transition from Disconnected (initial state) to the target state
        let result = sm.transition(BoardConnectionState::Disconnected, state);

        prop_assert!(result, "Transition from initial Disconnected state should succeed");
        prop_assert_eq!(
            sm.current(),
            state,
            "State should match the target state after transition"
        );
    }

    // Feature: rust-runtime-reliability, Property 4: Atomic State Transition Correctness (Idempotent)
    // **Validates: Requirements 2.4, 2.5, 2.6**
    //
    // This test verifies that transitioning to the same state (from == to) works correctly.
    // The transition should succeed if from matches current, even if to equals from.
    #[test]
    fn transition_to_same_state_succeeds_when_from_matches(
        state_value in 0u8..6
    ) {
        let sm = BoardStateMachine::new();
        sm.force_state_raw(state_value);

        let state = BoardConnectionState::from_u8(state_value);

        // Transition from current state to the same state
        let result = sm.transition(state, state);

        prop_assert!(result, "Transition to same state should succeed when from matches");
        prop_assert_eq!(
            sm.current_raw(),
            state_value,
            "State should remain the same after self-transition"
        );
    }

    // Feature: rust-runtime-reliability, Property 4: Atomic State Transition Correctness (Sequential)
    // **Validates: Requirements 2.4, 2.5, 2.6**
    //
    // This test verifies that sequential transitions work correctly.
    // After a successful transition, the next transition must use the new state as 'from'.
    #[test]
    fn sequential_transitions_require_correct_from_state(
        state1 in 0u8..6,
        state2 in 0u8..6,
        state3 in 0u8..6
    ) {
        let sm = BoardStateMachine::new();

        // First transition: Disconnected -> state1
        let s1 = BoardConnectionState::from_u8(state1);
        let result1 = sm.transition(BoardConnectionState::Disconnected, s1);
        prop_assert!(result1, "First transition from Disconnected should succeed");
        prop_assert_eq!(sm.current_raw(), state1);

        // Second transition: state1 -> state2
        let s2 = BoardConnectionState::from_u8(state2);
        let result2 = sm.transition(s1, s2);
        prop_assert!(result2, "Second transition from state1 should succeed");
        prop_assert_eq!(sm.current_raw(), state2);

        // Third transition with wrong 'from' should fail
        // Use state1 as 'from' when current is state2
        if state1 != state2 {
            let s3 = BoardConnectionState::from_u8(state3);
            let result3 = sm.transition(s1, s3);
            prop_assert!(!result3, "Transition with wrong 'from' state should fail");
            prop_assert_eq!(
                sm.current_raw(),
                state2,
                "State should remain unchanged after failed transition"
            );
        }
    }

    // Feature: rust-runtime-reliability, Property 4: Atomic State Transition Correctness (Invalid u8)
    // **Validates: Requirements 2.4, 2.5, 2.6**
    //
    // This test verifies that invalid u8 values (>= 6) are handled correctly by from_u8,
    // which should return Disconnected for any invalid value.
    #[test]
    fn invalid_u8_values_map_to_disconnected(
        invalid_value in 6u8..=255
    ) {
        let state = BoardConnectionState::from_u8(invalid_value);
        prop_assert_eq!(
            state,
            BoardConnectionState::Disconnected,
            "Invalid u8 values should map to Disconnected"
        );
    }

    // Feature: rust-runtime-reliability, Property 5: Error Storage Round-Trip
    // **Validates: Requirements 2.9, 2.10**
    //
    // *For any* error message string M, when set_error(M) is called on a BoardStateMachine,
    // get_last_error() SHALL return Some(M) containing the exact same string.
    // Additionally, set_error SHALL transition the state machine to the Error state.
    #[test]
    fn error_message_round_trips(message in ".{1,200}") {
        let sm = BoardStateMachine::new();
        
        // Store the original message for comparison
        let original_message = message.clone();
        
        // Set the error message
        sm.set_error(message);
        
        // Verify the state machine transitioned to Error state
        prop_assert_eq!(
            sm.current(),
            BoardConnectionState::Error,
            "set_error should transition state to Error"
        );
        
        // Verify the error message can be retrieved
        let retrieved = sm.get_last_error();
        prop_assert!(
            retrieved.is_some(),
            "get_last_error should return Some after set_error"
        );
        
        // Verify the retrieved message matches the original exactly
        prop_assert_eq!(
            retrieved.unwrap(),
            original_message,
            "Retrieved error message should match the original exactly"
        );
    }

    // Feature: rust-runtime-reliability, Property 5: Error Storage Round-Trip (Various String Types)
    // **Validates: Requirements 2.9, 2.10**
    //
    // This test verifies error storage works with various string patterns including
    // empty-ish strings, unicode, and special characters.
    #[test]
    fn error_message_round_trips_various_patterns(
        // Test with different string patterns
        pattern_type in 0u8..5,
        base_content in "[a-zA-Z0-9 ]{1,50}"
    ) {
        let message = match pattern_type {
            0 => base_content.clone(), // Basic alphanumeric
            1 => format!("Error: {base_content}"), // Prefixed message
            2 => format!("{base_content}\n{base_content}"), // Multi-line
            3 => format!("  {base_content}  "), // Whitespace padded
            _ => format!("{base_content}!@#$%"), // Special characters
        };
        
        let sm = BoardStateMachine::new();
        sm.set_error(message.clone());
        
        // Verify state transition
        prop_assert_eq!(
            sm.current(),
            BoardConnectionState::Error,
            "set_error should transition state to Error"
        );
        
        // Verify round-trip
        let retrieved = sm.get_last_error();
        prop_assert!(retrieved.is_some());
        prop_assert_eq!(retrieved.unwrap(), message);
    }

    // Feature: rust-runtime-reliability, Property 5: Error Storage Round-Trip (From Any State)
    // **Validates: Requirements 2.9, 2.10**
    //
    // This test verifies that set_error works correctly regardless of the initial state,
    // always transitioning to Error and storing the message.
    #[test]
    fn error_storage_works_from_any_state(
        initial_state in 0u8..6,
        message in ".{1,100}"
    ) {
        let sm = BoardStateMachine::new();
        
        // Set initial state to any valid state
        sm.force_state_raw(initial_state);
        prop_assert_eq!(
            sm.current_raw(),
            initial_state,
            "Initial state should be set correctly"
        );
        
        // Set error from this state
        sm.set_error(message.clone());
        
        // Verify transition to Error state
        prop_assert_eq!(
            sm.current(),
            BoardConnectionState::Error,
            "set_error should always transition to Error state"
        );
        
        // Verify message is stored correctly
        let retrieved = sm.get_last_error();
        prop_assert!(retrieved.is_some());
        prop_assert_eq!(retrieved.unwrap(), message);
    }

    // Feature: rust-runtime-reliability, Property 5: Error Storage Round-Trip (Overwrite)
    // **Validates: Requirements 2.9, 2.10**
    //
    // This test verifies that calling set_error multiple times correctly overwrites
    // the previous error message, and the latest message is always retrievable.
    #[test]
    fn error_message_overwrites_previous(
        first_message in ".{1,100}",
        second_message in ".{1,100}"
    ) {
        let sm = BoardStateMachine::new();
        
        // Set first error
        sm.set_error(first_message.clone());
        prop_assert_eq!(sm.get_last_error().unwrap(), first_message);
        
        // Set second error (should overwrite)
        sm.set_error(second_message.clone());
        
        // Verify only the second message is stored
        let retrieved = sm.get_last_error();
        prop_assert!(retrieved.is_some());
        prop_assert_eq!(
            retrieved.unwrap(),
            second_message,
            "Second error message should overwrite the first"
        );
        
        // State should still be Error
        prop_assert_eq!(sm.current(), BoardConnectionState::Error);
    }
}

/// Unit tests for `BoardConnectionState` enum
#[cfg(test)]
mod state_enum_tests {
    use super::*;

    #[test]
    fn all_states_have_correct_u8_values() {
        assert_eq!(BoardConnectionState::Disconnected as u8, 0);
        assert_eq!(BoardConnectionState::Detecting as u8, 1);
        assert_eq!(BoardConnectionState::Flashing as u8, 2);
        assert_eq!(BoardConnectionState::Connecting as u8, 3);
        assert_eq!(BoardConnectionState::Connected as u8, 4);
        assert_eq!(BoardConnectionState::Error as u8, 5);
    }

    #[test]
    fn from_u8_round_trips_correctly() {
        for i in 0u8..6 {
            let state = BoardConnectionState::from_u8(i);
            assert_eq!(state as u8, i, "from_u8({i}) should round-trip correctly");
        }
    }

    #[test]
    fn as_str_returns_expected_values() {
        assert_eq!(BoardConnectionState::Disconnected.as_str(), "disconnected");
        assert_eq!(BoardConnectionState::Detecting.as_str(), "detecting");
        assert_eq!(BoardConnectionState::Flashing.as_str(), "flashing");
        assert_eq!(BoardConnectionState::Connecting.as_str(), "connecting");
        assert_eq!(BoardConnectionState::Connected.as_str(), "connected");
        assert_eq!(BoardConnectionState::Error.as_str(), "error");
    }
}

/// Unit tests for `BoardStateMachine`
#[cfg(test)]
mod state_machine_tests {
    use super::*;

    #[test]
    fn new_state_machine_starts_disconnected() {
        let sm = BoardStateMachine::new();
        assert_eq!(sm.current(), BoardConnectionState::Disconnected);
    }

    #[test]
    fn default_state_machine_starts_disconnected() {
        let sm = BoardStateMachine::default();
        assert_eq!(sm.current(), BoardConnectionState::Disconnected);
    }

    #[test]
    fn transition_succeeds_when_from_matches() {
        let sm = BoardStateMachine::new();
        
        // Transition from Disconnected to Detecting
        let result = sm.transition(
            BoardConnectionState::Disconnected,
            BoardConnectionState::Detecting,
        );
        
        assert!(result, "Transition should succeed");
        assert_eq!(sm.current(), BoardConnectionState::Detecting);
    }

    #[test]
    fn transition_fails_when_from_does_not_match() {
        let sm = BoardStateMachine::new();
        
        // Try to transition from Connecting (wrong) to Connected
        let result = sm.transition(
            BoardConnectionState::Connecting,
            BoardConnectionState::Connected,
        );
        
        assert!(!result, "Transition should fail");
        assert_eq!(sm.current(), BoardConnectionState::Disconnected);
    }

    #[test]
    fn full_connection_lifecycle() {
        let sm = BoardStateMachine::new();
        
        // Disconnected -> Detecting
        assert!(sm.transition(
            BoardConnectionState::Disconnected,
            BoardConnectionState::Detecting,
        ));
        assert_eq!(sm.current(), BoardConnectionState::Detecting);
        
        // Detecting -> Connecting
        assert!(sm.transition(
            BoardConnectionState::Detecting,
            BoardConnectionState::Connecting,
        ));
        assert_eq!(sm.current(), BoardConnectionState::Connecting);
        
        // Connecting -> Connected
        assert!(sm.transition(
            BoardConnectionState::Connecting,
            BoardConnectionState::Connected,
        ));
        assert_eq!(sm.current(), BoardConnectionState::Connected);
        
        // Connected -> Disconnected
        assert!(sm.transition(
            BoardConnectionState::Connected,
            BoardConnectionState::Disconnected,
        ));
        assert_eq!(sm.current(), BoardConnectionState::Disconnected);
    }

    #[test]
    fn force_state_sets_state_directly() {
        let sm = BoardStateMachine::new();
        
        sm.force_state(BoardConnectionState::Connected);
        assert_eq!(sm.current(), BoardConnectionState::Connected);
        
        sm.force_state(BoardConnectionState::Error);
        assert_eq!(sm.current(), BoardConnectionState::Error);
    }

    #[test]
    fn force_state_raw_sets_state_directly() {
        let sm = BoardStateMachine::new();
        
        sm.force_state_raw(4); // Connected
        assert_eq!(sm.current_raw(), 4);
        assert_eq!(sm.current(), BoardConnectionState::Connected);
    }

    #[test]
    fn current_raw_returns_u8_value() {
        let sm = BoardStateMachine::new();
        assert_eq!(sm.current_raw(), 0); // Disconnected
        
        sm.force_state(BoardConnectionState::Flashing);
        assert_eq!(sm.current_raw(), 2);
    }

    #[test]
    fn set_error_stores_message_and_transitions_to_error() {
        let sm = BoardStateMachine::new();
        
        // Set an error
        sm.set_error("Connection failed".to_string());
        
        // Verify state is Error
        assert_eq!(sm.current(), BoardConnectionState::Error);
        
        // Verify error message is stored
        let error = sm.get_last_error();
        assert!(error.is_some());
        assert_eq!(error.unwrap(), "Connection failed");
    }

    #[test]
    fn get_last_error_returns_none_when_no_error() {
        let sm = BoardStateMachine::new();
        
        // No error set yet
        assert!(sm.get_last_error().is_none());
    }

    #[test]
    fn reset_clears_error_and_returns_to_disconnected() {
        let sm = BoardStateMachine::new();
        
        // Set an error first
        sm.set_error("Some error".to_string());
        assert_eq!(sm.current(), BoardConnectionState::Error);
        assert!(sm.get_last_error().is_some());
        
        // Reset
        sm.reset();
        
        // Verify state is Disconnected
        assert_eq!(sm.current(), BoardConnectionState::Disconnected);
        
        // Verify error is cleared
        assert!(sm.get_last_error().is_none());
    }

    #[test]
    fn set_error_overwrites_previous_error() {
        let sm = BoardStateMachine::new();
        
        // Set first error
        sm.set_error("First error".to_string());
        assert_eq!(sm.get_last_error().unwrap(), "First error");
        
        // Set second error
        sm.set_error("Second error".to_string());
        assert_eq!(sm.get_last_error().unwrap(), "Second error");
    }

    #[test]
    fn set_error_works_from_any_state() {
        let sm = BoardStateMachine::new();
        
        // From Disconnected
        sm.set_error("Error from disconnected".to_string());
        assert_eq!(sm.current(), BoardConnectionState::Error);
        
        // Reset and try from Connected
        sm.reset();
        sm.force_state(BoardConnectionState::Connected);
        sm.set_error("Error from connected".to_string());
        assert_eq!(sm.current(), BoardConnectionState::Error);
        assert_eq!(sm.get_last_error().unwrap(), "Error from connected");
    }
}
