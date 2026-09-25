# Rust Runtime Audit — April 2026

> **Date:** April 1, 2026  
> **Scope:** `apps/web/src-tauri/src/runtime/`, `lib.rs`, `error.rs`  
> **Baseline:** Post-February 2026 improvement cycle  
> **Status:** Assessment complete, implementation plan attached

---

## Executive Summary

The February 2026 improvement plan has been largely executed. Reader thread lifecycle, `Arc<str>` allocations, `FxHashMap` edge lookup, sequence-based stale event filtering, `tokio::sync::Mutex` migration, and the `thiserror`-based error module are all in place. Integration tests and Criterion benchmarks exist.

However, a second-pass review reveals that several improvements were only partially landed, and new architectural concerns have surfaced as the component count and feature surface (LLM, Figma, MQTT pub/sub) have grown. This document covers what's working, what's not, and a prioritized plan for the next iteration.

---

## 1. What Shipped Well Since February

| Item | Evidence | Verdict |
|------|----------|---------|
| Reader thread lifecycle | `BoardHandle::stop_reader()` now calls `handle.join()` with proper logging | ✅ Resolved |
| Stale event filtering | `flow_sequence` / `current_sequence` with `AtomicU64` + `SeqCst` | ✅ Resolved |
| `Arc<str>` for event IDs | `ComponentEvent.source` and `source_handle` are `Arc<str>` | ✅ Resolved |
| `Cow`-based emit | `ComponentBase::emit_with_value` accepts `Cow<'_, ComponentValue>` | ✅ Resolved |
| `FxHashMap` edge lookup | `EdgeMap` with pre-computed `u64` keys via `FxHasher` | ✅ Resolved |
| `tokio::sync::Mutex` for runtime | `AppState.flow_runtime` is `Arc<tokio::sync::Mutex<FlowRuntime>>` | ✅ Resolved |
| `thiserror` error module | `error.rs` with `RuntimeError`, `HardwareError`, `MqttError` | ✅ Exists |
| Integration tests | 7 test files in `tests/`, property-based tests with `proptest` | ✅ Exists |
| Benchmarks | `benches/event_routing.rs` with Criterion (10/100 targets, stale discard) | ✅ Exists |
| Pin cache + active pin tracking | `BoardConnection::active_pins`, `clear_pin_cache`, `RegisterActivePin` | ✅ Resolved |
| Firmata reporting reset | `ResetAllReporting` command on flow update | ✅ Resolved |

---

## 2. Partially Landed / Incomplete Items

### 2.1 Error Types Exist But Aren't Used

`error.rs` defines `RuntimeError`, `HardwareError`, and `MqttError` with proper `thiserror` derives and even has comprehensive unit tests. But the actual runtime code still returns `Result<(), String>` everywhere:

- `Component::call_method` → `Result<(), String>`
- `Component::initialize` → `Result<(), String>`
- `FlowRuntime::update_flow` → `Result<(), String>`
- `BoardHandle::send_command` → `Result<(), String>`
- Every Tauri command → `Result<(), String>`

The error module is dead code in practice. The `to_frontend_message()` method has never been called.

### 2.2 Mutex Poisoning Strategy Is Inconsistent

`BoardHandle` uses `unwrap_or_else(PoisonError::into_inner)` — the "recover from poison" approach. `FlowRuntime::register_pin_listener` and `clear_pin_listeners` use `.lock().unwrap()` — the "panic on poison" approach. These are contradictory strategies in the same codebase. A poisoned `pin_listeners` mutex will crash the app while a poisoned `cmd_tx` mutex will silently recover.

### 2.3 MQTT Reconnection Not Implemented

The February plan included `ReconnectConfig` with exponential backoff. The current `MqttManager` has no reconnection logic. Broker connections that drop stay dead until the user manually reconnects.

### 2.4 Board State Machine Not Implemented

`hardware/state.rs` exists as a file but contains only type definitions for events — not the `BoardConnectionState` state machine proposed in the February plan.

---

## 3. New Findings

### 3.1 Unbounded Channels With No Backpressure

Every `ComponentEvent` flows through `mpsc::unbounded_channel`. Components like `Oscillator` (60fps) and `Interval` (configurable, minimum 16ms) generate events continuously. With multiple generators and a slow downstream (e.g., LLM node blocking the executor lock), the channel buffer grows without limit.

**Risk:** Memory exhaustion on constrained hardware (Raspberry Pi, older laptops).

### 3.2 Thread Spawning Without Lifecycle Management

| Component | Spawn Method | Join Handle? | Cancellation |
|-----------|-------------|-------------|--------------|
| `Interval` | `std::thread::spawn` | No | `AtomicBool` flag |
| `Oscillator` | `std::thread::spawn` | No | `AtomicBool` flag |
| `Delay` | `std::thread::spawn` | No | `AtomicBool` flag (forget_previous only) |
| `Llm` | `tokio::spawn` | `AbortHandle` | ✅ Proper cancellation |

`Interval` and `Oscillator` set `running = false` in `destroy()` but don't join the thread. The thread may still be executing when the next flow update creates a replacement component. The old thread holds a clone of `event_tx` — if it sends before noticing the flag, the event enters the channel. Sequence filtering (seq=0 for unsequenced events) does NOT catch these because software-emitted events intentionally use seq=0.

### 3.3 Full Teardown on Every Flow Update

`update_flow()` calls `executor.clear()` which destroys every component, then recreates all of them from the JSON. For a 50-node flow where the user changed one wire, this means:

1. 50 `destroy()` calls (some spawning cleanup I/O)
2. Firmata `ResetAllReporting`
3. 50 component constructions + `serde_json::from_value(data.clone())`
4. 50 `set_event_sender()` calls (some triggering auto-start)
5. Edge map rebuild
6. Pin listener re-registration
7. `initialize_hardware()` for all hardware components
8. Pin change callback reinstall

This is O(n) in total nodes for an O(1) change.

### 3.4 Verbose Logging on Hot Paths

`FlowExecutor::process_event` has 8 `log::info!` calls. At 60fps from one Oscillator with 3 downstream edges, that's ~480 log lines/second from a single component. With multiple generators, this easily reaches thousands of lines/second. The log output will dominate I/O and mask real issues.

### 3.5 `Component` Trait Carries Dead Weight for Software Nodes

`initialize(&mut self, board: Arc<BoardHandle>)` is mandatory in the trait but is a no-op for 17 out of 27 registered components. Every software component must implement it as `Ok(())`. The `requires_hardware()` method is the workaround, but it means the trait conflates two concerns.

### 3.6 `data.clone()` in Registry for Every Component

`ComponentRegistry::create` passes `&serde_json::Value` to the factory, but every factory immediately does `serde_json::from_value(data.clone())`. This deep-clones the entire JSON blob per node. For a 50-node flow update, that's 50 unnecessary deep clones.

### 3.7 No Graceful Shutdown Coordination

When the Tauri app closes:
- Interval/Oscillator threads are abandoned (no join)
- The Firmata board is not explicitly reset to a safe state
- MQTT connections are not cleanly disconnected (no DISCONNECT packet)
- The event forwarding thread has no shutdown signal

---

## 4. Implementation Plan

### Phase 1: Correctness (P0) — 1.5 weeks

These items fix bugs or prevent data loss/corruption.

#### 1.1 Adopt Typed Errors Throughout

Migrate `Result<(), String>` → `Result<(), RuntimeError>` across the runtime. The types already exist in `error.rs` — this is purely a wiring task.

**Scope:**
- `Component` trait: `call_method`, `initialize` return `Result<(), RuntimeError>`
- `FlowRuntime::update_flow` → `Result<(), RuntimeError>`
- `FlowExecutor::process_event` internal error paths
- `BoardHandle::send_command` → `Result<(), HardwareError>`
- Tauri commands: convert at the boundary via `impl From<RuntimeError> for String>` (already exists)

**Estimated effort:** 3 days (mechanical refactor, no logic changes)

#### 1.2 Consistent Mutex Poison Strategy

Standardize on `unwrap_or_else(PoisonError::into_inner)` everywhere. The runtime should never panic from a poisoned lock — it should recover the inner data and log a warning. Apply to `FlowRuntime::pin_listeners` and any other `std::sync::Mutex` usage.

**Estimated effort:** 0.5 days

#### 1.3 Thread Lifecycle for Generators

Add join handle tracking to `Interval`, `Oscillator`, and `Delay`. On `destroy()`:
1. Set the stop flag
2. Join the thread with a timeout (e.g., 500ms)
3. If join times out, log a warning (don't block indefinitely)

This ensures the old thread is actually dead before the next flow update creates a replacement.

```rust
pub struct Interval {
    // ...existing fields...
    thread_handle: Option<std::thread::JoinHandle<()>>,
}

impl Interval {
    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.thread_handle.take() {
            // Give the thread time to notice the flag and exit
            let _ = handle.join();
        }
        self.started = false;
    }
}
```

**Estimated effort:** 1 day

#### 1.4 Graceful Shutdown Hook

Register a Tauri `on_event` handler for `RunEvent::Exit` that:
1. Stops all generator threads (via `executor.clear()`)
2. Resets Firmata reporting and drives all output pins low
3. Disconnects the board cleanly
4. Sends MQTT DISCONNECT packets

**Estimated effort:** 1 day

---

### Phase 2: Robustness (P1) — 2 weeks

These items prevent degradation under load or adverse conditions.

#### 2.1 Bounded Event Channel With Drop Policy

Replace `mpsc::unbounded_channel` with `mpsc::channel(capacity)`. When the channel is full, drop the oldest event (or the incoming event) and log a warning. A capacity of 1024 is reasonable — at 60fps that's ~17 seconds of buffer.

Alternatively, keep unbounded but add a high-water-mark check in the event forwarding thread that logs warnings when the backlog exceeds a threshold.

**Estimated effort:** 2 days (includes testing backpressure behavior)

#### 2.2 MQTT Reconnection With Exponential Backoff

Implement the `ReconnectConfig` pattern from the February plan. When a broker connection drops:
1. Emit a `broker-disconnected` event to the frontend
2. Start a background reconnection loop with exponential backoff (1s → 2s → 4s → ... → 60s cap)
3. On reconnect, resubscribe to all active topics
4. Emit `broker-reconnected` event

**Estimated effort:** 3 days

#### 2.3 Reduce Log Verbosity on Hot Paths

Demote `FlowExecutor::process_event` logging from `info!` to `trace!`. Keep `info!` for:
- Component creation/destruction
- Board connect/disconnect
- Flow update (summary: "Updated flow: 12 nodes, 8 edges, seq=5")
- Errors and warnings

Add a periodic summary log instead: "Processed 1,247 events in last 10s (3 dropped as stale)".

**Estimated effort:** 1 day

#### 2.4 Board State Machine

Implement the state machine in `hardware/state.rs`:

```
Disconnected → Detecting → Flashing → Connecting → Connected
     ↑              ↑                                   │
     └──────────────┴───────────── Error ←──────────────┘
```

Replace the `board_connected: Arc<RwLock<bool>>` with `board_state: Arc<BoardStateMachine>`. This prevents invalid transitions (e.g., flashing while already connected) and gives the frontend richer status information.

**Estimated effort:** 2 days

---

### Phase 3: Performance (P2) — 2 weeks

These items improve throughput and reduce waste for larger flows.

#### 3.1 Diff-Based Flow Updates

Instead of full teardown/rebuild, compute the diff between old and new flow:

1. **Unchanged nodes** (same id + same data): keep the existing component
2. **Modified nodes** (same id, different data): destroy and recreate only that component
3. **Removed nodes**: destroy
4. **Added nodes**: create
5. **Edge changes**: rebuild edge map only (this is already fast)

This turns an O(n) operation into O(delta) for the common case of small edits.

**Implementation sketch:**
```rust
pub fn update_flow_diff(&mut self, update: FlowUpdate) -> Result<(), RuntimeError> {
    let new_sequence = self.flow_sequence.fetch_add(1, Ordering::SeqCst) + 1;
    self.current_sequence = new_sequence;
    self.executor.set_current_sequence(new_sequence);

    let old_ids: HashSet<&str> = self.executor.component_ids().into_iter().collect();
    let new_ids: HashMap<&str, &FlowNode> = update.nodes.iter()
        .map(|n| (n.id.as_str(), n))
        .collect();

    // Remove nodes no longer in the flow
    for id in &old_ids {
        if !new_ids.contains_key(id) {
            self.executor.remove_component(id);
        }
    }

    // Add or update nodes
    for node in &update.nodes {
        if old_ids.contains(node.id.as_str()) {
            // TODO: compare data hash to detect changes
            // For now, skip unchanged nodes
            continue;
        }
        // Create new component...
    }

    // Always rebuild edges (cheap)
    self.executor.set_edges(update.edges);
    Ok(())
}
```

**Estimated effort:** 4 days (including data hash comparison and testing)

#### 3.2 Avoid `data.clone()` in Registry

Change the factory signature to accept `&serde_json::Value` and deserialize from a reference using `serde_json::from_value` on a borrowed path, or use `serde_path_to_error` for better diagnostics. Alternatively, pre-parse configs in `update_flow` and pass typed configs to factories.

**Estimated effort:** 2 days

#### 3.3 Split Component Trait

Introduce a `HardwareComponent` extension trait:

```rust
pub trait Component: Send + Sync {
    fn id(&self) -> &str;
    fn value(&self) -> ComponentValue;
    fn set_value(&mut self, value: ComponentValue);
    fn component_type(&self) -> &'static str;
    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), RuntimeError>;
    fn destroy(&mut self);
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>>;
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>);
    fn aggregates_inputs(&self) -> bool { false }
}

pub trait HardwareComponent: Component {
    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), HardwareError>;
    fn requires_pin(&self) -> Option<u8> { None }
}
```

This removes the dead `initialize` and `requires_hardware` from software components. The registry and executor would use `Box<dyn Component>` for all components and downcast to `HardwareComponent` when a board is connected.

**Estimated effort:** 3 days (trait refactor touches every component file)

---

### Phase 4: Maintainability (Ongoing)

#### 4.1 Clippy Pedantic in CI

Add `cargo clippy --all-targets -- -D warnings -W clippy::pedantic` to the GitHub Actions workflow. The codebase already uses `#[must_use]` and `#[allow(dead_code)]` annotations, suggesting clippy awareness — formalizing it prevents regression.

#### 4.2 Test Coverage for Real Components

The current integration tests use `MockComponent` exclusively. Add tests that exercise real component implementations:
- `Led::turn_on` / `turn_off` / `brightness` with a mock board
- `Button::process_state` debounce timing
- `Calculate::check` with edge-case inputs (empty array, NaN, infinity)
- `Gate::passes_gate` truth tables for all 6 gate types
- `Smooth::moving_average` window behavior

#### 4.3 Benchmark Regression Tracking

Integrate Criterion benchmarks into CI with `cargo bench` and track results over time. Alert on >10% regression in `route_event_100_targets`.

---

## 5. Priority Matrix

| # | Item | Phase | Risk if Skipped | Effort | Dependencies |
|---|------|-------|-----------------|--------|-------------|
| 1.1 | Typed errors throughout | P0 | Silent failures, poor diagnostics | 3d | None |
| 1.2 | Mutex poison strategy | P0 | Cascading panics | 0.5d | None |
| 1.3 | Generator thread lifecycle | P0 | Ghost events, resource leaks | 1d | None |
| 1.4 | Graceful shutdown | P0 | Hardware left in unknown state | 1d | 1.3 |
| 2.1 | Bounded event channel | P1 | Memory exhaustion under load | 2d | None |
| 2.2 | MQTT reconnection | P1 | Dead connections after network blip | 3d | None |
| 2.3 | Log verbosity | P1 | Log noise masks real issues | 1d | None |
| 2.4 | Board state machine | P1 | Invalid state transitions | 2d | None |
| 3.1 | Diff-based flow updates | P2 | Slow updates for large flows | 4d | None |
| 3.2 | Avoid data.clone() | P2 | Unnecessary allocations | 2d | None |
| 3.3 | Split Component trait | P2 | Dead code in 17 components | 3d | 1.1 |
| 4.1 | Clippy CI | Ongoing | Lint regression | 0.5d | None |
| 4.2 | Real component tests | Ongoing | Untested business logic | 3d | None |
| 4.3 | Benchmark tracking | Ongoing | Undetected perf regression | 1d | None |

**Total estimated effort:** ~27 days across all phases.

---

## 6. Recommended Execution Order

```
Week 1:  1.1 (typed errors) + 1.2 (mutex strategy) + 1.3 (thread lifecycle)
Week 2:  1.4 (graceful shutdown) + 2.3 (log verbosity) + 2.1 (bounded channel)
Week 3:  2.2 (MQTT reconnect) + 2.4 (board state machine)
Week 4:  3.1 (diff-based updates) + 3.2 (avoid clone)
Week 5:  3.3 (split trait) + 4.1 (clippy CI) + 4.2 (real component tests)
Ongoing: 4.3 (benchmark tracking)
```

Items within the same week can be parallelized across contributors. Phase 1 items should not be skipped or deferred — they represent correctness issues that will surface as bugs in production.
