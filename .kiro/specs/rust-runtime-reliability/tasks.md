# Implementation Plan: Rust Runtime Reliability (Phase 2)

## Overview

This plan implements Phase 2 (Reliability - P1) improvements to the Tauri/Rust runtime:
1. MQTT reconnection with exponential backoff
2. Board connection state machine
3. Integration tests for components, edges, and event propagation

Target timeline: 3 weeks

## Tasks

- [x] 1. Implement MQTT Reconnection with Exponential Backoff
  - [x] 1.1 Add ReconnectConfig struct to `src/mqtt/broker.rs`
    - Define struct with initial_delay, max_delay, multiplier, max_attempts fields
    - Implement Default trait with specified defaults (1s, 60s, 2.0, None)
    - Implement next_delay() method for calculating backoff
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.7, 1.8_

  - [x]* 1.2 Write property test for delay calculation
    - **Property 1: Exponential Backoff Delay Calculation**
    - **Validates: Requirements 1.7, 1.8**

  - [x] 1.3 Implement connect_internal() method on MqttBroker
    - Extract connection logic from connect() into reusable internal method
    - Return after CONNACK without spawning receive_loop
    - _Requirements: 1.1_

  - [x] 1.4 Implement resubscribe_all() method on MqttBroker
    - Read subscriptions from state
    - Resubscribe to each topic without re-registering callbacks
    - _Requirements: 1.10_

  - [x]* 1.5 Write property test for topic resubscription
    - **Property 3: Topic Resubscription Completeness**
    - **Validates: Requirements 1.10**

  - [x] 1.6 Implement reconnect_loop() on MqttBroker
    - Track attempt count and current delay
    - Check max_attempts before each attempt
    - Apply exponential backoff on failure
    - Call resubscribe_all() on success
    - Log each attempt with delay and attempt number
    - _Requirements: 1.1, 1.6, 1.9, 1.11, 1.12_

  - [x]* 1.7 Write property test for max attempts termination
    - **Property 2: Max Attempts Termination**
    - **Validates: Requirements 1.9**

  - [x] 1.8 Integrate reconnection into receive_loop
    - Spawn reconnect_loop when connection is lost
    - Update status to Disconnected before starting reconnection
    - _Requirements: 1.1_

- [x] 2. Checkpoint - Ensure MQTT reconnection tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Implement Board Connection State Machine
  - [x] 3.1 Create `src/hardware/state.rs` module
    - Define BoardConnectionState enum with 6 states
    - Implement from_u8() and as_str() methods
    - _Requirements: 2.1_

  - [x] 3.2 Implement BoardStateMachine struct
    - Add state field as AtomicU8
    - Add last_error field as RwLock<Option<String>>
    - Implement new() with initial Disconnected state
    - Implement current() to read state
    - _Requirements: 2.2, 2.7_

  - [x] 3.3 Implement transition() method with compare_exchange
    - Use compare_exchange for atomic state change
    - Return true on success, false on failure
    - Leave state unchanged on failure
    - _Requirements: 2.3, 2.4, 2.5, 2.6_

  - [x]* 3.4 Write property test for atomic transitions
    - **Property 4: Atomic State Transition Correctness**
    - **Validates: Requirements 2.4, 2.5, 2.6**

  - [x] 3.5 Implement error handling methods
    - Implement set_error() to store message and transition to Error state
    - Implement get_last_error() to retrieve stored error
    - Implement reset() to clear error and return to Disconnected
    - _Requirements: 2.8, 2.9, 2.10_

  - [x]* 3.6 Write property test for error storage round-trip
    - **Property 5: Error Storage Round-Trip**
    - **Validates: Requirements 2.9, 2.10**

  - [x] 3.7 Export state module from hardware/mod.rs
    - Add `pub mod state;` to hardware/mod.rs
    - Export BoardConnectionState and BoardStateMachine
    - _Requirements: 2.1_

- [x] 4. Checkpoint - Ensure state machine tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Create Integration Test Infrastructure
  - [x] 5.1 Create tests directory structure
    - Create `apps/web/src-tauri/tests/` directory
    - Create `tests/common/mod.rs` for shared utilities
    - _Requirements: 3.1_

  - [x] 5.2 Implement MockBoardHandle
    - Add pin_values HashMap for tracking pin state
    - Add connected AtomicBool for connection state
    - Implement set_pin(), get_pin(), is_connected(), disconnect()
    - _Requirements: 3.3_

  - [x] 5.3 Implement MockComponent
    - Add received_events Vec for tracking events
    - Add current_value for tracking last value
    - Implement receive_event(), event_count(), value()
    - _Requirements: 4.2_

- [ ] 6. Implement Component Lifecycle Tests
  - [x] 6.1 Create `tests/component_lifecycle.rs`
    - Test component creation without board
    - Test graceful failure when no board connected
    - Test initialization with MockBoardHandle
    - _Requirements: 3.1, 3.2, 3.3_

  - [x]* 6.2 Write property test for graceful failure
    - **Property 6: Graceful Failure Without Board**
    - **Validates: Requirements 3.2**

  - [x] 6.3 Add LED-specific lifecycle tests
    - Test LED turn_on() updates value to 1.0
    - Test LED turn_off() updates value to 0.0
    - _Requirements: 3.4, 3.5_

  - [ ] 6.4 Add component cleanup tests
    - Test destroy() releases resources
    - Test operations fail after destroy
    - _Requirements: 3.6_

  - [ ]* 6.5 Write property test for resource cleanup
    - **Property 7: Component Resource Cleanup**
    - **Validates: Requirements 3.6**

- [ ] 7. Implement Edge Routing Tests
  - [ ] 7.1 Create `tests/edge_routing.rs`
    - Test edge configuration between components
    - Test basic event routing from source to target
    - _Requirements: 4.1, 4.2_

  - [ ]* 7.2 Write property test for edge routing correctness
    - **Property 8: Edge Routing Correctness**
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5**

  - [ ] 7.3 Add handle matching tests
    - Test events route only when handles match
    - Test events with non-matching handles are not routed
    - _Requirements: 4.4, 4.5_

  - [ ] 7.4 Add value preservation tests
    - Test target receives exact value from event
    - Test various ComponentValue types (Bool, Number, String)
    - _Requirements: 4.3_

- [ ] 8. Implement Event Propagation Tests
  - [ ] 8.1 Create `tests/event_propagation.rs`
    - Test event propagation through component chains
    - Test multi-hop propagation (A -> B -> C)
    - _Requirements: 5.1_

  - [ ]* 8.2 Write property test for event propagation
    - **Property 9: Event Propagation Through Flows**
    - **Validates: Requirements 5.1, 5.2, 5.3**

  - [ ] 8.3 Add fan-out tests
    - Test single source with multiple targets
    - Verify all targets receive the event
    - _Requirements: 5.2_

  - [ ] 8.4 Add value preservation chain tests
    - Test values are preserved through multi-hop chains
    - Test values are identical at each hop
    - _Requirements: 5.3_

  - [ ] 8.5 Add event ordering tests
    - Test events are processed in correct order
    - Test ordering with multiple concurrent events
    - _Requirements: 5.4_

- [ ] 9. Final Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional property-based tests that can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests use the `proptest` crate with minimum 100 iterations
- Integration tests should use MockBoardHandle to avoid hardware dependencies
- Checkpoints ensure incremental validation of each major feature
