# Design Document: Rust Runtime Performance Optimizations

## Overview

This design document describes the implementation of Phase 3 (Performance) optimizations for the Microflow Rust runtime. The optimizations focus on two key areas:

1. **Reducing allocations** in hot paths by using `Arc<str>` for IDs and `Cow` for values
2. **Optimizing edge lookup** by replacing `HashMap` with `FxHashMap` and pre-computing hash keys

These changes target the event routing system, which is the most frequently executed code path during flow execution. The goal is to minimize heap allocations and reduce hash computation overhead without changing the public API.

## Architecture

The performance optimizations affect three main components:

```
┌─────────────────────────────────────────────────────────────────┐
│                        FlowRuntime                               │
│  ┌─────────────────┐    ┌─────────────────┐                     │
│  │  ComponentBase  │───▶│ ComponentEvent  │                     │
│  │  - id: Arc<str> │    │ - source: Arc   │                     │
│  │  - emit()       │    │ - handle: Arc   │                     │
│  │  - emit_with_   │    │ - value: Cow    │                     │
│  │    value(Cow)   │    └────────┬────────┘                     │
│  └─────────────────┘             │                              │
│                                  ▼                              │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                      FlowExecutor                           ││
│  │  ┌─────────────────────────────────────────────────────┐   ││
│  │  │                     EdgeMap                          │   ││
│  │  │  - map: FxHashMap<u64, Vec<EdgeTarget>>             │   ││
│  │  │  - key(source, handle) -> u64                       │   ││
│  │  │  - get(source, handle) -> Option<&[EdgeTarget]>     │   ││
│  │  └─────────────────────────────────────────────────────┘   ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### 1. ComponentEvent with Arc<str> Fields

**Current Implementation:**
```rust
pub struct ComponentEvent {
    pub source: String,
    pub source_handle: String,
    pub value: ComponentValue,
    pub edge_id: Option<String>,
    pub sequence: u64,
}
```

**Optimized Implementation:**
```rust
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentEvent {
    #[serde(deserialize_with = "deserialize_arc_str")]
    pub source: Arc<str>,
    #[serde(deserialize_with = "deserialize_arc_str")]
    pub source_handle: Arc<str>,
    pub value: ComponentValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<String>,
    #[serde(default)]
    pub sequence: u64,
}

// Custom deserializer to convert String -> Arc<str>
fn deserialize_arc_str<'de, D>(deserializer: D) -> Result<Arc<str>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    Ok(Arc::from(s))
}
```

**Benefits:**
- Cloning `ComponentEvent` only increments reference counts for `source` and `source_handle`
- No heap allocation when events are routed through multiple edges
- `Arc<str>` is 16 bytes (pointer + length) vs String's 24 bytes (pointer + length + capacity)

### 2. ComponentBase with Arc<str> ID

**Current Implementation:**
```rust
pub struct ComponentBase {
    pub id: String,
    pub value: ComponentValue,
    pub event_sender: Option<mpsc::UnboundedSender<ComponentEvent>>,
}
```

**Optimized Implementation:**
```rust
pub struct ComponentBase {
    pub id: Arc<str>,
    pub value: ComponentValue,
    pub event_sender: Option<mpsc::UnboundedSender<ComponentEvent>>,
}

impl ComponentBase {
    pub fn new(id: String, initial_value: ComponentValue) -> Self {
        Self {
            id: Arc::from(id),
            value: initial_value,
            event_sender: None,
        }
    }

    /// Emit an event with the current value (borrows value)
    pub fn emit(&self, handle: &str) {
        self.emit_with_value(handle, Cow::Borrowed(&self.value));
    }

    /// Emit an event with a custom value using Cow semantics
    pub fn emit_with_value(&self, handle: &str, value: Cow<'_, ComponentValue>) {
        if let Some(sender) = &self.event_sender {
            let _ = sender.send(ComponentEvent {
                source: Arc::clone(&self.id),  // No allocation - just ref count increment
                source_handle: Arc::from(handle),  // Single allocation for handle
                value: value.into_owned(),
                edge_id: None,
                sequence: 0,
            });
        }
    }
}
```

### 3. EdgeMap with FxHashMap and Pre-computed Keys

**Current Implementation:**
```rust
use std::collections::HashMap;

pub struct FlowExecutor {
    edge_map: HashMap<(String, String), Vec<(String, String, Option<String>)>>,
}
```

**Optimized Implementation:**
```rust
use rustc_hash::{FxHashMap, FxHasher};
use std::hash::{Hash, Hasher};

/// Target information for an edge
#[derive(Clone)]
pub struct EdgeTarget {
    pub target_id: Arc<str>,
    pub target_handle: Arc<str>,
    pub edge_id: Option<Arc<str>>,
}

/// Optimized edge lookup map using FxHashMap with pre-computed keys
pub struct EdgeMap {
    map: FxHashMap<u64, Vec<EdgeTarget>>,
}

impl EdgeMap {
    pub fn new() -> Self {
        Self {
            map: FxHashMap::default(),
        }
    }

    /// Compute a hash key from source and handle strings
    #[inline]
    pub fn key(source: &str, handle: &str) -> u64 {
        let mut hasher = FxHasher::default();
        source.hash(&mut hasher);
        // Use a separator to avoid collisions like ("ab", "c") vs ("a", "bc")
        0u8.hash(&mut hasher);
        handle.hash(&mut hasher);
        hasher.finish()
    }

    /// Insert an edge target for a source/handle pair
    pub fn insert(&mut self, source: &str, handle: &str, target: EdgeTarget) {
        let key = Self::key(source, handle);
        self.map.entry(key).or_default().push(target);
    }

    /// Get all targets for a source/handle pair
    #[inline]
    pub fn get(&self, source: &str, handle: &str) -> Option<&[EdgeTarget]> {
        let key = Self::key(source, handle);
        self.map.get(&key).map(|v| v.as_slice())
    }

    /// Clear all edges
    pub fn clear(&mut self) {
        self.map.clear();
    }
}
```

**Benefits of FxHashMap:**
- FxHash is ~2-3x faster than SipHash (default HashMap hasher) for small keys
- Designed for hash table use cases where DoS resistance isn't needed
- Used extensively in rustc itself for performance-critical paths

### 4. Updated FlowExecutor

```rust
pub struct FlowExecutor {
    components: HashMap<String, Box<dyn Component>>,
    edges: Vec<FlowEdge>,
    edge_map: EdgeMap,  // Changed from HashMap<(String, String), Vec<...>>
    current_sequence: u64,
}

impl FlowExecutor {
    /// Rebuild the edge lookup map with pre-computed keys
    fn rebuild_edge_map(&mut self) {
        self.edge_map.clear();

        for edge in &self.edges {
            let target = EdgeTarget {
                target_id: Arc::from(edge.target.as_str()),
                target_handle: Arc::from(edge.target_handle.as_str()),
                edge_id: edge.id.as_ref().map(|s| Arc::from(s.as_str())),
            };
            self.edge_map.insert(&edge.source, &edge.source_handle, target);
        }
    }

    /// Process an event - optimized lookup path
    pub fn process_event(&mut self, event: ComponentEvent) -> bool {
        // ... sequence check ...

        // Fast lookup using pre-computed hash
        let targets = match self.edge_map.get(&event.source, &event.source_handle) {
            Some(t) => t.to_vec(),  // Clone the slice for iteration
            None => return true,
        };

        for target in targets {
            // Route to target using Arc<str> - no allocations
            if let Some(component) = self.components.get_mut(target.target_id.as_ref()) {
                let _ = component.call_method(&target.target_handle, event.value.clone());
            }
        }
        
        true
    }
}
```

## Data Models

### ComponentEvent (Updated)

| Field | Type | Description |
|-------|------|-------------|
| source | Arc<str> | Component ID that emitted the event |
| source_handle | Arc<str> | Output handle name |
| value | ComponentValue | Event payload |
| edge_id | Option<String> | Optional edge identifier |
| sequence | u64 | Flow version for stale event filtering |

### EdgeTarget (New)

| Field | Type | Description |
|-------|------|-------------|
| target_id | Arc<str> | Target component ID |
| target_handle | Arc<str> | Target input handle name |
| edge_id | Option<Arc<str>> | Optional edge identifier |

### EdgeMap (New)

| Field | Type | Description |
|-------|------|-------------|
| map | FxHashMap<u64, Vec<EdgeTarget>> | Pre-hashed edge lookup table |



## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Based on the prework analysis, the following properties can be verified through property-based testing:

### Property 1: Arc<str> Clone Shares Memory

*For any* ComponentEvent with source and source_handle fields, cloning the event SHALL result in the cloned fields pointing to the same memory address as the original (Arc::ptr_eq returns true).

**Validates: Requirements 1.3**

### Property 2: Emit Reuses Component ID Arc

*For any* ComponentBase instance, when emit() or emit_with_value() is called, the resulting ComponentEvent's source field SHALL have the same Arc pointer as the component's stored ID (Arc::ptr_eq returns true).

**Validates: Requirements 1.5**

### Property 3: Hash Key Determinism

*For any* pair of strings (source, handle), calling EdgeMap::key() multiple times with the same inputs SHALL always produce the same u64 hash value.

**Validates: Requirements 4.2**

### Property 4: ComponentEvent JSON Round-Trip

*For any* valid ComponentEvent, serializing to JSON and deserializing back SHALL produce a ComponentEvent with equivalent field values (source, source_handle, value, edge_id, sequence all match).

**Validates: Requirements 5.1, 5.3**

## Error Handling

### Serialization Errors

- **Invalid JSON**: When deserializing ComponentEvent from invalid JSON, return a serde error with context
- **Missing fields**: Required fields (source, source_handle, value) must be present; use serde defaults for optional fields

### Hash Collisions

- **Collision handling**: FxHashMap handles collisions internally; no special error handling needed
- **Key separator**: Use a null byte separator between source and handle to prevent collisions like ("ab", "c") vs ("a", "bc")

### Memory Pressure

- **Arc overhead**: Arc<str> has minimal overhead (16 bytes vs 24 bytes for String)
- **No special handling needed**: The optimizations reduce memory usage, not increase it

## Testing Strategy

### Unit Tests

Unit tests should verify specific examples and edge cases:

1. **ComponentEvent creation**: Verify Arc<str> fields are created correctly
2. **ComponentBase emit**: Verify events are sent with correct Arc references
3. **EdgeMap operations**: Verify insert/get/clear work correctly
4. **Serde compatibility**: Verify JSON serialization produces expected format

### Property-Based Tests

Property tests should use the `proptest` crate (already in dev-dependencies) with minimum 100 iterations:

1. **Arc clone property**: Generate random ComponentEvents, clone them, verify Arc::ptr_eq
2. **Emit ID reuse property**: Generate random component IDs, emit events, verify Arc::ptr_eq
3. **Hash determinism property**: Generate random string pairs, verify hash consistency
4. **JSON round-trip property**: Generate random ComponentEvents, serialize/deserialize, verify equality

### Integration Tests

1. **Flow execution**: Verify existing flow tests pass with optimized types
2. **Event routing**: Verify events route correctly through EdgeMap
3. **Performance regression**: Ensure no performance degradation (optional benchmark)

### Test Configuration

- Property tests: Minimum 100 iterations per property
- Tag format: **Feature: rust-runtime-performance, Property N: {property_text}**
- Use proptest's `proptest!` macro for property definitions
