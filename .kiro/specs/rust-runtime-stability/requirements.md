# Requirements Document

## Introduction

This document specifies the requirements for Phase 1 (Stability - P0) improvements to the Tauri/Rust runtime in Microflow. These improvements address critical stability issues including resource leaks from improper thread lifecycle management, inconsistent error handling, blocking mutex usage in async contexts, and race conditions in pin event reporting.

## Glossary

- **Reader_Thread**: A dedicated thread that continuously reads and decodes Firmata messages from the serial port
- **BoardHandle**: The shared handle to the Firmata board connection used by components
- **FlowRuntime**: The runtime that manages flow component lifecycle and event routing
- **ComponentEvent**: An event emitted by a component containing source, handle, and value information
- **Pin_Listener**: A registration that maps hardware pins to components for event routing
- **Flow_Sequence**: A monotonically increasing counter that tracks flow update versions
- **RuntimeError**: The unified error type for all runtime operations
- **HardwareError**: Error type for hardware-related failures (port, Firmata, pin modes)
- **Async_Mutex**: A mutex from tokio::sync that can be held across await points without blocking

## Requirements

### Requirement 1: Reader Thread Lifecycle Management

**User Story:** As a developer, I want the reader thread to join cleanly on disconnect, so that there are no resource leaks after repeated connect/disconnect cycles.

#### Acceptance Criteria

1. WHEN the Reader_Thread is stopped, THE BoardHandle SHALL call join() on the thread handle instead of dropping it
2. WHEN the Reader_Thread join completes successfully, THE BoardHandle SHALL log a clean shutdown message
3. WHEN the Reader_Thread panics during shutdown, THE BoardHandle SHALL log a warning and continue cleanup
4. WHILE the Reader_Thread is running, THE Reader_Thread SHALL check the running flag between read operations
5. WHEN the serial read times out, THE Reader_Thread SHALL continue checking the running flag without error
6. IF the board disconnects while the Reader_Thread is running, THEN THE Reader_Thread SHALL exit its loop gracefully

### Requirement 2: Unified Error Types

**User Story:** As a developer, I want structured error types with context, so that I can diagnose and handle errors appropriately.

#### Acceptance Criteria

1. THE RuntimeError type SHALL use thiserror for derive macro error handling
2. THE RuntimeError type SHALL include variants for BoardNotConnected, ComponentNotFound, InvalidPin, Hardware, Mqtt, Serialization, and LockPoisoned
3. THE HardwareError type SHALL include variants for PortOpen, FirmataCommunication, and UnsupportedPinMode
4. WHEN a ComponentNotFound error occurs, THE RuntimeError SHALL include the component ID in the error message
5. WHEN an InvalidPin error occurs, THE RuntimeError SHALL include the pin configuration details
6. WHEN a PortOpen error occurs, THE HardwareError SHALL include both the port name and the failure reason
7. WHEN a UnsupportedPinMode error occurs, THE HardwareError SHALL include both the pin number and the requested mode

### Requirement 3: Async Mutex Migration

**User Story:** As a developer, I want non-blocking mutex operations in async command handlers, so that the runtime doesn't deadlock under load.

#### Acceptance Criteria

1. THE AppState flow_runtime field SHALL use tokio::sync::Mutex instead of std::sync::Mutex
2. WHEN an async command handler acquires the flow_runtime lock, THE handler SHALL use .lock().await instead of .lock().unwrap()
3. WHEN a lock acquisition fails due to poisoning, THE handler SHALL return a RuntimeError::LockPoisoned error
4. THE flow_update command SHALL acquire the mutex asynchronously
5. THE component_call command SHALL acquire the mutex asynchronously

### Requirement 4: Pin Reporting Race Condition Fix

**User Story:** As a developer, I want pin events to be discarded if they arrive from a previous flow version, so that stale events don't cause ghost interactions.

#### Acceptance Criteria

1. THE ComponentEvent type SHALL include a sequence field for flow version tracking
2. THE FlowRuntime SHALL maintain a flow_sequence counter that increments on each flow update
3. WHEN update_flow is called, THE FlowRuntime SHALL increment the flow_sequence before clearing components
4. WHEN update_flow is called, THE FlowRuntime SHALL drain the event channel to discard pending stale events
5. WHEN a ComponentEvent is processed, THE FlowExecutor SHALL discard events with sequence less than current_sequence
6. WHEN a stale event is discarded, THE FlowExecutor SHALL log a debug message with the event sequence number
