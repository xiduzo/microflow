# Implementation Plan: Rust Runtime Stability (Phase 1)

## Overview

This plan implements the four P0 stability improvements for the Tauri/Rust runtime:
1. Reader thread lifecycle with proper join()
2. Unified error types using thiserror
3. Async mutex migration for command handlers
4. Pin reporting race condition fix with sequence numbers

Implementation uses Rust with thiserror for error handling and proptest for property-based testing.

## Tasks

- [ ] 1. Add dependencies and create error module
  - [x] 1.1 Add thiserror and proptest dependencies to Cargo.toml
    - Add `thiserror = "1"` to dependencies
    - Add `proptest = "1"` to dev-dependencies
    - _Requirements: 2.1_

  - [x] 1.2 Create unified error types in `src/error.rs`
    - Create RuntimeError enum with BoardNotConnected, ComponentNotFound, InvalidPin, Hardware, Mqtt, Serialization, LockPoisoned variants
    - Create HardwareError enum with PortOpen, FirmataCommunication, UnsupportedPinMode variants
    - Create MqttError enum with NotConnected, ConnectionFailed, SubscribeFailed variants
    - Implement From<HardwareError> for RuntimeError
    - Implement From<MqttError> for RuntimeError
    - Implement From<serde_json::Error> for RuntimeError
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ]* 1.3 Write property tests for error context preservation
    - **Property 3: Error Messages Contain Context**
    - Test ComponentNotFound contains component ID
    - Test InvalidPin contains pin details
    - Test PortOpen contains port name and reason
    - Test UnsupportedPinMode contains pin and mode
    - **Validates: Requirements 2.4, 2.5, 2.6, 2.7**

  - [x] 1.4 Export error module from lib.rs
    - Add `mod error; pub use error::*;` to lib.rs
    - _Requirements: 2.1_

- [ ] 2. Fix reader thread lifecycle
  - [x] 2.1 Update stop_reader() to use join() in `src/runtime/base.rs`
    - Replace `drop(handle)` with `handle.join()`
    - Add match on join result for logging
    - Remove the 150ms sleep before drop
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 2.2 Improve reader thread loop flag checking
    - Add flag check after timeout sleep
    - Ensure loop exits promptly when flag is false
    - _Requirements: 1.4, 1.5, 1.6_

  - [ ]* 2.3 Write property test for thread stop responsiveness
    - **Property 1: Thread Stop Responsiveness**
    - Test that stop_reader() completes within bounded time
    - **Validates: Requirements 1.1, 1.4, 1.5, 1.6**

- [x] 3. Checkpoint - Verify error types and thread lifecycle
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Migrate to async mutex for flow_runtime
  - [x] 4.1 Update AppState to use tokio::sync::Mutex in `src/lib.rs`
    - Change `flow_runtime: Arc<Mutex<FlowRuntime>>` to `Arc<tokio::sync::Mutex<FlowRuntime>>`
    - Update initialization in run() function
    - _Requirements: 3.1_

  - [x] 4.2 Update event forwarding thread to handle async mutex
    - The event forwarding thread uses blocking_recv, needs to handle the mutex change
    - Consider using try_lock or spawning async task for event processing
    - _Requirements: 3.1_

  - [x] 4.3 Update board-state listener to handle async mutex
    - The listener callback needs to work with async mutex
    - May need to spawn async task for flow application
    - _Requirements: 3.1_

  - [x] 4.4 Update input polling loop to handle async mutex
    - The polling loop uses blocking lock, needs adjustment
    - Consider using try_lock with retry for polling
    - _Requirements: 3.1_

  - [x] 4.5 Update flow_update command to use async lock in `src/runtime/commands.rs`
    - Change `.lock().unwrap()` to `.lock().await`
    - Update error handling for lock acquisition
    - _Requirements: 3.2, 3.4_

  - [x] 4.6 Update component_call command to use async lock
    - Change `.lock().unwrap()` to `.lock().await`
    - Update error handling for lock acquisition
    - _Requirements: 3.2, 3.5_

- [x] 5. Checkpoint - Verify async mutex migration
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement pin reporting race condition fix
  - [x] 6.1 Add sequence field to ComponentEvent in `src/runtime/base.rs`
    - Add `pub sequence: u64` field with `#[serde(default)]`
    - Update ComponentEvent construction sites
    - _Requirements: 4.1_

  - [x] 6.2 Add flow_sequence counter to FlowRuntime in `src/runtime/mod.rs`
    - Add `flow_sequence: AtomicU64` field
    - Add `current_sequence: u64` field
    - Initialize both to 0 in new()
    - Add getter method for current_sequence
    - _Requirements: 4.2_

  - [x] 6.3 Update update_flow() to increment sequence and drain events
    - Increment flow_sequence at start of update_flow()
    - Store new sequence in current_sequence
    - Drain event channel using try_recv() loop
    - Log discarded events count
    - _Requirements: 4.3, 4.4_

  - [x] 6.4 Update event emission to include sequence number
    - Update ComponentBase.emit_with_value() to accept sequence
    - Update pin change callback to include current sequence
    - _Requirements: 4.1_

  - [x] 6.5 Add stale event filtering in FlowExecutor
    - Add current_sequence field to FlowExecutor
    - Add set_current_sequence() method
    - Update process_event() to check sequence and discard stale events
    - Log discarded stale events at debug level
    - _Requirements: 4.5, 4.6_

  - [ ]* 6.6 Write property tests for sequence behavior
    - **Property 4: Flow Sequence Monotonic Increment**
    - **Property 5: Event Channel Draining**
    - **Property 6: Stale Event Filtering**
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5**

- [x] 7. Final checkpoint - Full integration verification
  - Ensure all tests pass, ask the user if questions arise.
  - Verify no resource leaks with repeated connect/disconnect
  - Verify no stale events after rapid flow updates

## Notes

- Tasks marked with `*` are optional property-based tests that can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- The async mutex migration (task 4) is the most complex change due to the mixed sync/async context in lib.rs
