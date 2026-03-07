# Requirements Document

## Introduction

This document specifies the requirements for Phase 3 (Performance) of the Rust Runtime Improvements plan. The goal is to reduce memory allocations in hot paths and optimize edge lookup performance in the flow runtime. These optimizations target the event routing system which processes component events at high frequency during flow execution.

## Glossary

- **ComponentEvent**: A struct representing an event emitted by a component, containing source ID, handle, value, and metadata
- **FlowExecutor**: The component responsible for routing events between flow components via edges
- **EdgeMap**: A data structure mapping (source_id, source_handle) pairs to target component information
- **Arc<str>**: A reference-counted immutable string slice that avoids heap allocation for cloning
- **Cow**: Copy-on-write smart pointer that can hold either borrowed or owned data
- **FxHashMap**: A HashMap using the FxHash algorithm from rustc-hash, optimized for small keys
- **Hot_Path**: Code executed frequently during normal operation (event routing, value emission)

## Requirements

### Requirement 1: Reduce String Allocations in ComponentEvent

**User Story:** As a runtime developer, I want ComponentEvent to use Arc<str> for ID fields, so that event cloning in hot paths avoids heap allocations.

#### Acceptance Criteria

1. THE ComponentEvent struct SHALL use Arc<str> for the source field instead of String
2. THE ComponentEvent struct SHALL use Arc<str> for the source_handle field instead of String
3. WHEN a ComponentEvent is cloned, THE Runtime SHALL only increment reference counts without allocating new heap memory for source and source_handle
4. THE ComponentBase emit methods SHALL accept &str parameters and convert to Arc<str> efficiently
5. WHEN components emit events, THE Runtime SHALL reuse the component's stored Arc<str> ID without allocation

### Requirement 2: Optimize Value Emission with Copy-on-Write

**User Story:** As a runtime developer, I want value emission to use Cow semantics, so that values can be passed by reference when possible and only cloned when necessary.

#### Acceptance Criteria

1. THE ComponentBase emit_with_value method SHALL accept Cow<ComponentValue> as the value parameter
2. WHEN the caller owns the value, THE emit_with_value method SHALL take ownership without cloning
3. WHEN the caller borrows the value, THE emit_with_value method SHALL clone only when the value must be stored
4. THE existing emit method SHALL continue to work by borrowing the component's current value

### Requirement 3: Optimize Edge Lookup with FxHashMap

**User Story:** As a runtime developer, I want edge lookups to use FxHashMap, so that event routing has lower latency due to faster hashing.

#### Acceptance Criteria

1. THE FlowExecutor edge_map field SHALL use FxHashMap instead of std::collections::HashMap
2. THE rustc-hash crate SHALL be added as a dependency in Cargo.toml
3. WHEN looking up edges by (source, handle) pair, THE FlowExecutor SHALL use FxHashMap's faster hash function
4. THE edge lookup performance SHALL be improved for typical flow sizes (10-100 components)

### Requirement 4: Pre-compute Hash Keys for Edge Lookup

**User Story:** As a runtime developer, I want edge keys to use pre-computed hashes, so that repeated lookups for the same source/handle pair are faster.

#### Acceptance Criteria

1. THE EdgeMap SHALL use a pre-computed u64 hash key instead of (String, String) tuple keys
2. THE EdgeMap SHALL provide a key() function that computes a hash from source and handle strings
3. WHEN edges are set, THE FlowExecutor SHALL pre-compute hash keys for all edge sources
4. WHEN processing events, THE FlowExecutor SHALL compute the hash key once and use it for lookup
5. THE hash computation SHALL use FxHasher for consistency with FxHashMap

### Requirement 5: Maintain API Compatibility

**User Story:** As a runtime developer, I want the performance optimizations to maintain backward compatibility, so that existing code continues to work without modification.

#### Acceptance Criteria

1. THE ComponentEvent struct SHALL remain serializable with serde (JSON format unchanged)
2. THE Component trait methods SHALL continue to accept the same parameter types
3. WHEN deserializing ComponentEvent from JSON, THE Runtime SHALL convert String fields to Arc<str>
4. THE FlowRuntime public API SHALL remain unchanged
5. IF existing tests exist, THEN they SHALL continue to pass after the optimizations
