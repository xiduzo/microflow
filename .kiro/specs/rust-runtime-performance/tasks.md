# Implementation Plan: Rust Runtime Performance Optimizations

## Overview

This plan implements Phase 3 (Performance) optimizations for the Microflow Rust runtime. The implementation follows an incremental approach: first updating the core types, then the edge lookup system, and finally ensuring all tests pass.

## Tasks

- [x] 1. Add rustc-hash dependency
  - Add `rustc-hash = "1"` to `apps/web/src-tauri/Cargo.toml` dependencies
  - _Requirements: 3.2_

- [ ] 2. Update ComponentEvent to use Arc<str>
  - [x] 2.1 Modify ComponentEvent struct in `apps/web/src-tauri/src/runtime/base.rs`
    - Change `source: String` to `source: Arc<str>`
    - Change `source_handle: String` to `source_handle: Arc<str>`
    - Add `use std::sync::Arc;` import
    - Add custom serde deserializer for Arc<str> fields
    - _Requirements: 1.1, 1.2, 5.1, 5.3_

  - [ ]* 2.2 Write property test for Arc<str> clone shares memory
    - **Property 1: Arc<str> Clone Shares Memory**
    - **Validates: Requirements 1.3**

  - [ ]* 2.3 Write property test for ComponentEvent JSON round-trip
    - **Property 4: ComponentEvent JSON Round-Trip**
    - **Validates: Requirements 5.1, 5.3**

- [ ] 3. Update ComponentBase to use Arc<str> and Cow
  - [x] 3.1 Modify ComponentBase struct in `apps/web/src-tauri/src/runtime/base.rs`
    - Change `id: String` to `id: Arc<str>`
    - Update `new()` to convert String to Arc<str>
    - Update `emit_with_value()` to accept `Cow<'_, ComponentValue>`
    - Update `emit()` to use `Cow::Borrowed`
    - Add `use std::borrow::Cow;` import
    - _Requirements: 1.4, 1.5, 2.1, 2.4_

  - [ ]* 3.2 Write property test for emit reuses component ID Arc
    - **Property 2: Emit Reuses Component ID Arc**
    - **Validates: Requirements 1.5**

- [x] 4. Checkpoint - Verify base.rs compiles
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Implement EdgeMap with FxHashMap
  - [x] 5.1 Create EdgeTarget struct in `apps/web/src-tauri/src/runtime/executor.rs`
    - Define EdgeTarget with `target_id: Arc<str>`, `target_handle: Arc<str>`, `edge_id: Option<Arc<str>>`
    - _Requirements: 3.1_

  - [x] 5.2 Create EdgeMap struct in `apps/web/src-tauri/src/runtime/executor.rs`
    - Implement `new()`, `key()`, `insert()`, `get()`, `clear()` methods
    - Use FxHashMap<u64, Vec<EdgeTarget>> internally
    - Use FxHasher for key computation with null byte separator
    - _Requirements: 3.1, 3.3, 4.1, 4.2, 4.5_

  - [ ]* 5.3 Write property test for hash key determinism
    - **Property 3: Hash Key Determinism**
    - **Validates: Requirements 4.2**

- [ ] 6. Update FlowExecutor to use EdgeMap
  - [x] 6.1 Replace edge_map field in FlowExecutor
    - Change from `HashMap<(String, String), Vec<(String, String, Option<String>)>>` to `EdgeMap`
    - Update `new()` to create EdgeMap
    - _Requirements: 3.1, 4.1_

  - [x] 6.2 Update rebuild_edge_map() method
    - Use EdgeMap::insert() instead of HashMap entry API
    - Convert edge strings to Arc<str> when building EdgeTarget
    - _Requirements: 4.3_

  - [x] 6.3 Update process_event() method
    - Use EdgeMap::get() for lookup
    - Update to work with EdgeTarget struct
    - Handle Arc<str> types in routing logic
    - _Requirements: 4.4_

  - [x] 6.4 Update collect_input_values() method
    - Ensure compatibility with new edge types
    - _Requirements: 5.2_

  - [x] 6.5 Update route_mqtt_message() method
    - Update ComponentEvent creation to use Arc<str>
    - _Requirements: 5.2_

- [ ] 7. Update FlowRuntime event creation
  - [x] 7.1 Update install_pin_change_callback() in `apps/web/src-tauri/src/runtime/mod.rs`
    - Update ComponentEvent creation to use Arc<str> for source and source_handle
    - _Requirements: 1.1, 1.2_

  - [x] 7.2 Update PinListener to use Arc<str>
    - Change `component_id: String` to `component_id: Arc<str>`
    - Update register_pin_listener() and related methods
    - _Requirements: 1.1_

- [x] 8. Checkpoint - Verify all runtime code compiles
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Update component implementations
  - [x] 9.1 Update components that create ComponentEvent directly
    - Search for `ComponentEvent {` in component files
    - Update to use `Arc::from()` for string fields
    - Files: input/, output/, control/, generator/, transformation/, external/
    - _Requirements: 1.1, 1.2, 5.2_

- [x] 10. Final checkpoint - Run all tests
  - Ensure all tests pass, ask the user if questions arise.
  - Run `cargo test` in apps/web/src-tauri
  - Run `cargo clippy` to check for warnings
  - _Requirements: 5.5_

## Notes

- Tasks marked with `*` are optional property-based tests
- The proptest crate is already in dev-dependencies
- Arc<str> is created from String using `Arc::from(s)` or from &str using `Arc::from(s)`
- FxHashMap is a drop-in replacement for HashMap with faster hashing
- All changes maintain backward compatibility with existing JSON serialization
