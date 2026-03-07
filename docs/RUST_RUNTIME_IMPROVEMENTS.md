# Rust Runtime Improvement Plan

> **Created:** February 2026  
> **Status:** Approved for Implementation  
> **Priority:** P0 items blocking production stability

This document outlines the prioritized improvements for the Tauri/Rust runtime based on the architecture assessment.

---

## Phase 1: Stability (P0) — Target: 2 weeks

### 1.1 Fix Reader Thread Lifecycle

**File:** `apps/web/src-tauri/src/runtime/base.rs`

**Current Problem:**
```rust
pub fn stop_reader(&self) {
    self.reader_running.store(false, Ordering::SeqCst);
    if let Some(handle) = self.reader_handle.lock().unwrap().take() {
        std::thread::sleep(Duration::from_millis(150));
        drop(handle);  // Thread may still be running!
    }
}
```

**Solution:**
```rust
pub fn stop_reader(&self) {
    self.reader_running.store(false, Ordering::SeqCst);
    
    if let Some(handle) = self.reader_handle.lock().unwrap().take() {
        // Give thread time to notice the flag
        match handle.join() {
            Ok(_) => log::info!("Reader thread stopped cleanly"),
            Err(_) => log::warn!("Reader thread panicked during shutdown"),
        }
    }
}
```

Also update the reader loop to check the flag more frequently and use non-blocking reads with shorter timeouts.

**Acceptance Criteria:**
- [ ] Reader thread joins cleanly on disconnect
- [ ] No resource leaks after repeated connect/disconnect cycles
- [ ] Logs confirm clean shutdown

---

### 1.2 Unified Error Types

**New File:** `apps/web/src-tauri/src/error.rs`

**Implementation:**
```rust
use thiserror::Error;

#[derive(Error, Debug)]
pub enum RuntimeError {
    #[error("Board not connected")]
    BoardNotConnected,
    
    #[error("Component '{0}' not found")]
    ComponentNotFound(String),
    
    #[error("Invalid pin configuration: {0}")]
    InvalidPin(String),
    
    #[error("Hardware error: {0}")]
    Hardware(#[from] HardwareError),
    
    #[error("MQTT error: {0}")]
    Mqtt(#[from] MqttError),
    
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    
    #[error("Lock poisoned: {0}")]
    LockPoisoned(String),
}

#[derive(Error, Debug)]
pub enum HardwareError {
    #[error("Failed to open port '{port}': {reason}")]
    PortOpen { port: String, reason: String },
    
    #[error("Firmata communication failed: {0}")]
    FirmataCommunication(String),
    
    #[error("Pin {pin} does not support mode {mode}")]
    UnsupportedPinMode { pin: u8, mode: u8 },
}

#[derive(Error, Debug)]
pub enum MqttError {
    #[error("Broker '{0}' not connected")]
    NotConnected(String),
    
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),
    
    #[error("Subscribe failed for topic '{topic}': {reason}")]
    SubscribeFailed { topic: String, reason: String },
}
```

**Migration Steps:**
1. Add `thiserror = "1"` to Cargo.toml
2. Create `src/error.rs` with types above
3. Update `lib.rs` to `mod error; pub use error::*;`
4. Gradually replace `Result<T, String>` with `Result<T, RuntimeError>`
5. Update Tauri commands to convert errors for frontend

**Acceptance Criteria:**
- [ ] All public functions return typed errors
- [ ] Error messages include context (component ID, pin number, etc.)
- [ ] Frontend receives structured error information

---

### 1.3 Replace Blocking Mutex in Async Paths

**Files:** `apps/web/src-tauri/src/lib.rs`, `apps/web/src-tauri/src/runtime/commands.rs`

**Current Problem:**
```rust
// In async command handler
let mut runtime = state.flow_runtime.lock().unwrap();  // BLOCKS!
```

**Solution Options:**

**Option A: Use tokio::sync::Mutex (Recommended for commands.rs)**
```rust
// In AppState
pub flow_runtime: Arc<tokio::sync::Mutex<FlowRuntime>>,

// In command
let mut runtime = state.flow_runtime.lock().await;
```

**Option B: Use try_lock with retry (For mixed sync/async)**
```rust
fn try_with_runtime<F, R>(state: &AppState, f: F) -> Result<R, RuntimeError>
where
    F: FnOnce(&mut FlowRuntime) -> Result<R, RuntimeError>,
{
    const MAX_ATTEMPTS: usize = 10;
    const RETRY_DELAY: Duration = Duration::from_millis(10);
    
    for attempt in 0..MAX_ATTEMPTS {
        match state.flow_runtime.try_lock() {
            Ok(mut guard) => return f(&mut guard),
            Err(TryLockError::WouldBlock) => {
                if attempt < MAX_ATTEMPTS - 1 {
                    std::thread::sleep(RETRY_DELAY);
                }
            }
            Err(TryLockError::Poisoned(_)) => {
                return Err(RuntimeError::LockPoisoned("flow_runtime".into()));
            }
        }
    }
    Err(RuntimeError::LockPoisoned("timeout acquiring lock".into()))
}
```

**Acceptance Criteria:**
- [ ] No blocking `.lock().unwrap()` in async command handlers
- [ ] Lock acquisition has timeout/retry logic
- [ ] Poisoned locks are handled gracefully

---

### 1.4 Fix Pin Reporting Race Condition

**File:** `apps/web/src-tauri/src/runtime/mod.rs`

**Current Problem:**
When `update_flow()` is called, there's a window where:
1. Old components are destroyed
2. Pin reporting is reset
3. New components are created
4. But stale pin events from the serial buffer can still arrive

**Solution:**
```rust
// Add to ComponentEvent
pub struct ComponentEvent {
    pub source: String,
    pub source_handle: String,
    pub value: ComponentValue,
    pub edge_id: Option<String>,
    pub sequence: u64,  // NEW: Flow update sequence number
}

// In FlowRuntime
pub struct FlowRuntime {
    // ... existing fields ...
    flow_sequence: AtomicU64,  // Incremented on each flow update
}

impl FlowRuntime {
    pub fn update_flow(&mut self, update: FlowUpdate) -> Result<(), String> {
        // Increment sequence FIRST
        let new_sequence = self.flow_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        
        // Clear event channel to discard stale events
        while self.event_rx.as_mut().map(|rx| rx.try_recv().is_ok()).unwrap_or(false) {}
        
        // ... rest of update logic ...
        
        // Store sequence in pin listeners
        self.current_sequence = new_sequence;
    }
}

// In event processing
fn process_event(&mut self, event: ComponentEvent) {
    // Discard events from old flow versions
    if event.sequence < self.current_sequence {
        log::debug!("Discarding stale event from sequence {}", event.sequence);
        return;
    }
    // ... process event ...
}
```

**Acceptance Criteria:**
- [ ] No stale pin events processed after flow update
- [ ] Rapid flow updates don't cause ghost events
- [ ] Sequence numbers logged for debugging

---

## Phase 2: Reliability (P1) — Target: 3 weeks

### 2.1 MQTT Reconnection with Backoff

**File:** `apps/web/src-tauri/src/mqtt/broker.rs`

```rust
pub struct ReconnectConfig {
    pub initial_delay: Duration,
    pub max_delay: Duration,
    pub multiplier: f64,
    pub max_attempts: Option<usize>,
}

impl Default for ReconnectConfig {
    fn default() -> Self {
        Self {
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(60),
            multiplier: 2.0,
            max_attempts: None,  // Infinite
        }
    }
}

impl MqttBroker {
    async fn reconnect_loop(&self, config: ReconnectConfig) {
        let mut delay = config.initial_delay;
        let mut attempts = 0;
        
        loop {
            if let Some(max) = config.max_attempts {
                if attempts >= max {
                    log::error!("[MQTT] Max reconnection attempts reached");
                    break;
                }
            }
            
            log::info!("[MQTT] Reconnecting in {:?} (attempt {})", delay, attempts + 1);
            tokio::time::sleep(delay).await;
            
            match self.connect_internal().await {
                Ok(_) => {
                    log::info!("[MQTT] Reconnected successfully");
                    // Resubscribe to all topics
                    self.resubscribe_all().await;
                    break;
                }
                Err(e) => {
                    log::warn!("[MQTT] Reconnection failed: {}", e);
                    attempts += 1;
                    delay = Duration::from_secs_f64(
                        (delay.as_secs_f64() * config.multiplier).min(config.max_delay.as_secs_f64())
                    );
                }
            }
        }
    }
}
```

---

### 2.2 Board Connection State Machine

**New File:** `apps/web/src-tauri/src/hardware/state.rs`

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoardConnectionState {
    Disconnected,
    Detecting,
    Flashing,
    Connecting,
    Connected,
    Error,
}

pub struct BoardStateMachine {
    state: AtomicU8,
    last_error: RwLock<Option<String>>,
}

impl BoardStateMachine {
    pub fn transition(&self, from: BoardConnectionState, to: BoardConnectionState) -> bool {
        self.state.compare_exchange(
            from as u8,
            to as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ).is_ok()
    }
    
    pub fn current(&self) -> BoardConnectionState {
        // Convert from u8
    }
}
```

---

### 2.3 Integration Tests

**New Directory:** `apps/web/src-tauri/tests/`

```rust
// tests/component_lifecycle.rs
#[test]
fn test_led_lifecycle() {
    let config = LedConfig { pin: 13 };
    let mut led = Led::new("test-led".into(), config);
    
    // Should not panic without board
    assert!(led.turn_on().is_err());
    
    // With mock board
    let mock_board = MockBoardHandle::new();
    led.initialize(Arc::new(mock_board)).unwrap();
    
    led.turn_on().unwrap();
    assert_eq!(led.value(), ComponentValue::Number(1.0));
    
    led.destroy();
}

// tests/event_routing.rs
#[test]
fn test_edge_routing() {
    let mut executor = FlowExecutor::new();
    
    // Add components
    executor.add_component("button", Box::new(MockButton::new()));
    executor.add_component("led", Box::new(MockLed::new()));
    
    // Wire edge
    executor.set_edges(vec![FlowEdge {
        id: Some("e1".into()),
        source: "button".into(),
        source_handle: "event".into(),
        target: "led".into(),
        target_handle: "value".into(),
    }]);
    
    // Simulate button press
    executor.process_event(ComponentEvent {
        source: "button".into(),
        source_handle: "event".into(),
        value: ComponentValue::Bool(true),
        edge_id: None,
    });
    
    // Verify LED received the event
    let led = executor.get_component("led").unwrap();
    assert_eq!(led.value(), ComponentValue::Bool(true));
}
```

---

## Phase 3: Performance (P2) — Target: 3 weeks

### 3.1 Reduce Allocations

**Pattern: Use Arc<str> for IDs**
```rust
// Before
pub struct ComponentEvent {
    pub source: String,
    pub source_handle: String,
    // ...
}

// After
pub struct ComponentEvent {
    pub source: Arc<str>,
    pub source_handle: Arc<str>,
    // ...
}
```

**Pattern: Use Cow for values**
```rust
use std::borrow::Cow;

impl ComponentBase {
    pub fn emit_with_value(&self, handle: &str, value: Cow<'_, ComponentValue>) {
        if let Some(sender) = &self.event_sender {
            let _ = sender.send(ComponentEvent {
                source: self.id.clone(),
                source_handle: handle.into(),
                value: value.into_owned(),
                edge_id: None,
            });
        }
    }
}
```

---

### 3.2 Optimize Edge Lookup

**Current:** `HashMap<(String, String), Vec<...>>`

**Improved:**
```rust
use rustc_hash::FxHashMap;  // Faster hashing

// Pre-compute hash for common lookups
pub struct EdgeMap {
    map: FxHashMap<u64, Vec<EdgeTarget>>,
}

impl EdgeMap {
    fn key(source: &str, handle: &str) -> u64 {
        let mut hasher = FxHasher::default();
        source.hash(&mut hasher);
        handle.hash(&mut hasher);
        hasher.finish()
    }
    
    pub fn get(&self, source: &str, handle: &str) -> Option<&[EdgeTarget]> {
        self.map.get(&Self::key(source, handle)).map(|v| v.as_slice())
    }
}
```

---

## Phase 4: Maintainability (Ongoing)

### 4.1 Add Clippy to CI

```yaml
# .github/workflows/rust.yml
- name: Clippy
  run: cargo clippy --all-targets -- -D warnings -W clippy::pedantic
  working-directory: apps/web/src-tauri
```

### 4.2 Documentation Standards

All public items should have doc comments:

```rust
/// Manages the lifecycle of flow components and event routing.
///
/// # Example
///
/// ```
/// let mut runtime = FlowRuntime::new();
/// runtime.update_flow(flow)?;
/// runtime.process_event(event);
/// ```
///
/// # Thread Safety
///
/// This struct is `Send` but not `Sync`. Access from multiple threads
/// requires external synchronization (typically via `Arc<Mutex<FlowRuntime>>`).
pub struct FlowRuntime { ... }
```

### 4.3 Benchmark Suite

```rust
// benches/event_routing.rs
use criterion::{criterion_group, criterion_main, Criterion};

fn bench_event_routing(c: &mut Criterion) {
    let mut executor = setup_executor_with_100_components();
    let event = create_test_event();
    
    c.bench_function("route_event_100_components", |b| {
        b.iter(|| executor.process_event(event.clone()))
    });
}

criterion_group!(benches, bench_event_routing);
criterion_main!(benches);
```

---

## Tracking

| Phase | Item | Status | Owner | PR |
|-------|------|--------|-------|-----|
| 1 | Reader thread lifecycle | � Complete | — | — |
| 1 | Unified error types | � Complete | — | — |
| 1 | Async mutex migration | � Complete | — | — |
| 1 | Pin race condition | � Complete | — | — |
| 2 | MQTT reconnection | � Complete | — | — |
| 2 | Board state machine | � Complete | — | — |
| 2 | Integration tests | � In Progress | — | — |
| 3 | Reduce allocations | � Complete | — | — |
| 3 | Optimize edge lookup | � Complete | — | — |
| 4 | Clippy CI | 🔴 Not Started | — | — |
| 4 | Documentation | 🔴 Not Started | — | — |
| 4 | Benchmarks | 🔴 Not Started | — | — |

---

## Quick Reference: Files to Modify

| Improvement | Primary Files |
|-------------|---------------|
| Reader thread | `runtime/base.rs` |
| Error types | New `error.rs`, then all modules |
| Async mutex | `lib.rs`, `runtime/commands.rs` |
| Pin race | `runtime/mod.rs`, `runtime/base.rs` |
| MQTT reconnect | `mqtt/broker.rs`, `mqtt/manager.rs` |
| State machine | New `hardware/state.rs`, `hardware/mod.rs` |
| Tests | New `tests/` directory |
