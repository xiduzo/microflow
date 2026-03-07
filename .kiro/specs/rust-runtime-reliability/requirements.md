# Requirements Document

## Introduction

This document specifies the requirements for Phase 2 (Reliability - P1) improvements to the Tauri/Rust runtime in Microflow. These improvements focus on connection resilience and testability: automatic MQTT reconnection with exponential backoff, a proper state machine for board connection lifecycle, and integration tests for component behavior and event routing.

## Glossary

- **MqttBroker**: The client that manages connections to an MQTT broker for IoT messaging
- **ReconnectConfig**: Configuration parameters for the exponential backoff reconnection strategy
- **Exponential_Backoff**: A retry strategy where delay doubles after each failed attempt up to a maximum
- **BoardConnectionState**: An enumeration of possible states in the board connection lifecycle
- **BoardStateMachine**: A state machine that manages atomic transitions between board connection states
- **Atomic_Transition**: A state change using compare_exchange to ensure thread-safe, race-free updates
- **FlowExecutor**: The component that routes events between flow components based on edge definitions
- **ComponentEvent**: An event emitted by a component containing source, handle, and value information
- **FlowEdge**: A connection between two components defining how events are routed

## Requirements

### Requirement 1: MQTT Reconnection with Exponential Backoff

**User Story:** As a developer, I want the MQTT client to automatically reconnect when the broker connection is lost, so that IoT flows remain operational without manual intervention.

#### Acceptance Criteria

1. WHEN the MQTT connection is lost, THE MqttBroker SHALL initiate automatic reconnection
2. THE ReconnectConfig SHALL support configurable initial_delay with default of 1 second
3. THE ReconnectConfig SHALL support configurable max_delay with default of 60 seconds
4. THE ReconnectConfig SHALL support configurable multiplier with default of 2.0
5. THE ReconnectConfig SHALL support configurable max_attempts with default of None (infinite)
6. WHEN a reconnection attempt fails, THE MqttBroker SHALL wait for the current delay before retrying
7. WHEN a reconnection attempt fails, THE MqttBroker SHALL multiply the delay by the multiplier for the next attempt
8. WHEN the calculated delay exceeds max_delay, THE MqttBroker SHALL cap the delay at max_delay
9. IF max_attempts is set AND the attempt count reaches max_attempts, THEN THE MqttBroker SHALL stop reconnecting and log an error
10. WHEN reconnection succeeds, THE MqttBroker SHALL resubscribe to all previously subscribed topics
11. WHEN reconnection succeeds, THE MqttBroker SHALL reset the delay to initial_delay
12. WHILE reconnecting, THE MqttBroker SHALL log each attempt with the current delay and attempt number

### Requirement 2: Board Connection State Machine

**User Story:** As a developer, I want a proper state machine for board connection lifecycle, so that connection state is always consistent and race conditions are prevented.

#### Acceptance Criteria

1. THE BoardConnectionState enum SHALL include Disconnected, Detecting, Flashing, Connecting, Connected, and Error states
2. THE BoardStateMachine SHALL store state as an atomic u8 for thread-safe access
3. THE BoardStateMachine SHALL provide a transition method using compare_exchange for atomic state changes
4. WHEN a transition is attempted, THE BoardStateMachine SHALL return true only if the from state matches current state
5. WHEN a transition succeeds, THE BoardStateMachine SHALL atomically update to the to state
6. WHEN a transition fails, THE BoardStateMachine SHALL leave the state unchanged
7. THE BoardStateMachine SHALL provide a current method to read the current state
8. THE BoardStateMachine SHALL maintain a last_error field for debugging failed transitions
9. WHEN an error occurs during connection, THE BoardStateMachine SHALL store the error message in last_error
10. THE BoardStateMachine SHALL provide a get_last_error method to retrieve the stored error

### Requirement 3: Integration Tests for Component Lifecycle

**User Story:** As a developer, I want integration tests for component lifecycle, so that I can verify components initialize, operate, and destroy correctly.

#### Acceptance Criteria

1. THE test suite SHALL verify that components can be created without a connected board
2. THE test suite SHALL verify that component operations fail gracefully when no board is connected
3. THE test suite SHALL verify that components can be initialized with a mock board handle
4. THE test suite SHALL verify that LED components correctly update their value when turned on
5. THE test suite SHALL verify that LED components correctly update their value when turned off
6. THE test suite SHALL verify that components clean up resources when destroyed

### Requirement 4: Integration Tests for Edge Routing

**User Story:** As a developer, I want integration tests for edge routing, so that I can verify events flow correctly between connected components.

#### Acceptance Criteria

1. THE test suite SHALL verify that edges can be configured between components
2. THE test suite SHALL verify that events from a source component are routed to the target component
3. THE test suite SHALL verify that the target component receives the correct value from the event
4. THE test suite SHALL verify that events are routed based on matching source_handle and target_handle
5. THE test suite SHALL verify that events with non-matching handles are not routed

### Requirement 5: Integration Tests for Event Propagation

**User Story:** As a developer, I want integration tests for event propagation through flows, so that I can verify complex multi-component flows work correctly.

#### Acceptance Criteria

1. THE test suite SHALL verify that events propagate through a chain of connected components
2. THE test suite SHALL verify that multiple edges from a single source correctly fan out events
3. THE test suite SHALL verify that event values are preserved during propagation
4. THE test suite SHALL verify that the flow executor processes events in the correct order
