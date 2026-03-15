# Firmata Runtime Performance Fix — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate dropped inputs and sluggish outputs by removing the `try_lock()` event-drop pattern and giving the reader thread exclusive ownership of the board connection.

**Architecture:** Replace `Mutex<Option<BoardConnection>>` (held during blocking serial I/O) with a `BoardCommand` MPSC channel — the reader thread owns the connection exclusively and drains commands between reads. Replace `try_lock()` in the event forwarding thread with `blocking_lock()` so events queue naturally instead of being silently discarded. Remove the redundant 100 Hz polling loop that races the reader thread for the same mutex.

**Tech Stack:** Rust, `std::sync::mpsc`, `tokio::sync::Mutex` (already in use), `firmata-rs`, `serialport`

---

## Chunk 1: Stop Dropping Events

### Task 1: Replace `try_lock()` with `blocking_lock()` in event forwarding thread

**Files:**
- Modify: `apps/web/src-tauri/src/lib.rs:162-172`
- Test: `apps/web/src-tauri/tests/event_forwarding.rs` (new file)

The event forwarding thread uses `try_lock()` on `Arc<TokioMutex<FlowRuntime>>`. Any event arriving while the lock is held (e.g., during a flow update or poll) is silently discarded — it is emitted to the frontend but never routed to the component graph. Fix: use `blocking_lock()` so the thread blocks until the lock is free and the event is always processed.

- [ ] **Step 1.1: Write a failing test demonstrating event processing**

Create `apps/web/src-tauri/tests/event_forwarding.rs`:

```rust
//! Tests that the event forwarding thread processes ALL events, even under lock contention.
//! These tests cover the FlowRuntime.process_event path directly.

use app_lib::runtime::{FlowExecutor, ComponentEvent, ComponentValue};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Simulate what the event forwarding thread does: process events via FlowRuntime.
/// Verifies that all events are processed, not dropped.
#[test]
fn process_event_always_runs_when_called() {
    let mut executor = FlowExecutor::new();

    // Create a source component that emits an event to a sink
    // Even without components, process_event should return true (not panic/drop silently)
    let (tx, _rx) = mpsc::unbounded_channel::<ComponentEvent>();

    let event = ComponentEvent {
        source: Arc::from("test-source"),
        source_handle: Arc::from("value"),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 0,
    };

    // Must return true (processed), not false (stale discard)
    let processed = executor.process_event(event);
    assert!(processed, "Event with sequence=0 must always be processed");
}

#[test]
fn process_event_discards_stale_sequence_only() {
    let mut executor = FlowExecutor::new();
    executor.set_current_sequence(5);

    let stale = ComponentEvent {
        source: Arc::from("old-source"),
        source_handle: Arc::from("value"),
        value: ComponentValue::Bool(false),
        edge_id: None,
        sequence: 3, // older than current_sequence=5
    };

    let current = ComponentEvent {
        source: Arc::from("new-source"),
        source_handle: Arc::from("value"),
        value: ComponentValue::Bool(true),
        edge_id: None,
        sequence: 5,
    };

    assert!(!executor.process_event(stale), "Stale event must be discarded");
    assert!(executor.process_event(current), "Current-sequence event must be processed");
}
```

- [ ] **Step 1.2: Run tests to confirm they pass (logic already correct, just ensuring the test harness works)**

```bash
cd apps/web/src-tauri && cargo test --test event_forwarding 2>&1 | tail -20
```

Expected: PASS (the executor logic is already correct — we're establishing a baseline before changing lib.rs)

- [ ] **Step 1.3: Change `try_lock()` to `blocking_lock()` in lib.rs**

In `apps/web/src-tauri/src/lib.rs`, change lines 162–173:

```rust
// BEFORE
match flow_runtime_events.try_lock() {
    Ok(mut runtime) => {
        runtime.process_event(event);
    }
    Err(_) => {
        // Lock is held (e.g., during flow update), skip processing
        // The event has already been emitted to frontend
        log::debug!("Flow runtime lock held, skipping event processing for: {}", event.source);
    }
}
```

```rust
// AFTER
// This thread is std::thread::spawn, NOT a tokio::spawn task — blocking_lock() is
// safe here and will not stall the Tokio executor. The original try_lock() rationale
// ("avoid blocking the async runtime") was incorrect for this call site.
// blocking_lock() ensures events are NEVER dropped — they queue in the mpsc buffer
// and are processed as soon as the runtime is free (e.g., after a flow update completes).
let mut runtime = flow_runtime_events.blocking_lock();
runtime.process_event(event);
```

- [ ] **Step 1.4: Run the full test suite to confirm nothing regressed**

```bash
cd apps/web/src-tauri && cargo test 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 1.5: Commit**

```bash
cd apps/web/src-tauri && git add src/lib.rs tests/event_forwarding.rs
git commit -m "fix(runtime): never drop events under lock contention

Replace try_lock() with blocking_lock() in the event forwarding thread.
Events now queue naturally in the mpsc buffer instead of being silently
discarded when FlowRuntime is locked during flow updates or polls.

This fixes the primary symptom: inputs (buttons, sensors) not reaching
the UI after the first few events."
```

---

## Chunk 2: BoardCommand Channel — Reader Thread Owns the Connection

### Task 2: Define `BoardCommand` enum in `base.rs`

**Files:**
- Modify: `apps/web/src-tauri/src/runtime/base.rs` (add enum after `PinChangeCallback` type alias at line 365)
- Test: inline `#[cfg(test)]` module in `base.rs`

- [ ] **Step 2.1: Write failing tests for BoardCommand**

Add at the bottom of `apps/web/src-tauri/src/runtime/base.rs`:

```rust
#[cfg(test)]
mod command_tests {
    use super::*;

    #[test]
    fn board_command_digital_write_round_trips() {
        let cmd = BoardCommand::DigitalWrite { pin: 13, value: true };
        match cmd {
            BoardCommand::DigitalWrite { pin, value } => {
                assert_eq!(pin, 13);
                assert!(value);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn board_command_reset_all_reporting_is_unit() {
        let cmd = BoardCommand::ResetAllReporting;
        assert!(matches!(cmd, BoardCommand::ResetAllReporting));
    }

    #[test]
    fn board_command_stop_is_unit() {
        let cmd = BoardCommand::Stop;
        assert!(matches!(cmd, BoardCommand::Stop));
    }
}
```

- [ ] **Step 2.2: Run tests to confirm they fail (BoardCommand doesn't exist yet)**

```bash
cd apps/web/src-tauri && cargo test board_command 2>&1 | tail -10
```

Expected: FAIL with `cannot find type BoardCommand`

- [ ] **Step 2.3: Add `BoardCommand` enum to `base.rs`**

Insert after the `PinChangeCallback` type alias (line 365 of `base.rs`):

```rust
/// Commands sent to the reader thread for board operations.
/// The reader thread owns `BoardConnection` exclusively and processes
/// these between read cycles — no mutex contention on the hot path.
pub enum BoardCommand {
    SetPinMode { pin: u8, mode: u8 },
    DigitalWrite { pin: u8, value: bool },
    AnalogWrite { pin: u8, value: u16 },
    EnableAnalogReporting { pin: u8 },
    DisableAnalogReporting { pin: u8 },
    EnableDigitalReporting { pin: u8 },
    DisableDigitalReporting { pin: u8 },
    ResetAllReporting,
    SetPinChangeCallback { callback: Arc<PinChangeCallback> },
    ClearPinCache,
    Stop,
}
```

- [ ] **Step 2.4: Run tests to confirm they pass**

```bash
cd apps/web/src-tauri && cargo test board_command 2>&1 | tail -10
```

Expected: PASS

---

### Task 3: Refactor `BoardHandle` — command channel replaces mutex

**Files:**
- Modify: `apps/web/src-tauri/src/runtime/base.rs` (the `BoardHandle` struct, `connect`, `disconnect`, `start_reader`, `stop_reader`, `with_board`, `is_connected`)

This is the heart of the fix. `BoardHandle` loses its `Mutex<Option<BoardConnection>>`. Instead:
- `connect()` creates an MPSC channel and starts the reader thread (connection moves into the thread)
- `send_command()` replaces `with_board()` for all writes
- `is_connected()` reads an `AtomicBool` — no lock needed

**Before (struct):**
```rust
pub struct BoardHandle {
    inner: std::sync::Mutex<Option<BoardConnection>>,
    reader_running: std::sync::atomic::AtomicBool,
    reader_handle: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}
```

**After (struct):**
```rust
pub struct BoardHandle {
    cmd_tx: std::sync::Mutex<Option<std::sync::mpsc::Sender<BoardCommand>>>,
    connected: std::sync::atomic::AtomicBool,
    reader_running: std::sync::atomic::AtomicBool,
    reader_handle: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}
```

- [ ] **Step 3.1: Write failing tests for the new BoardHandle API**

Add to the `#[cfg(test)]` module at the bottom of `base.rs`:

```rust
#[cfg(test)]
mod board_handle_tests {
    use super::*;

    #[test]
    fn new_board_handle_is_not_connected() {
        let handle = BoardHandle::new();
        assert!(!handle.is_connected());
    }

    #[test]
    fn send_command_returns_err_when_not_connected() {
        let handle = BoardHandle::new();
        let result = handle.send_command(BoardCommand::ResetAllReporting);
        assert!(result.is_err(), "send_command must fail when not connected");
        assert!(result.unwrap_err().contains("not connected"));
    }
}
```

- [ ] **Step 3.2: Run tests to confirm they fail**

```bash
cd apps/web/src-tauri && cargo test board_handle 2>&1 | tail -20
```

Expected: FAIL (no `send_command` method, `is_connected` wrong behavior for old impl)

- [ ] **Step 3.3: Replace `BoardHandle` struct and all its methods**

Replace the entire `BoardHandle` impl block in `apps/web/src-tauri/src/runtime/base.rs` (lines 192–313):

```rust
/// Handle to the Firmata board.
///
/// The reader thread owns `BoardConnection` exclusively — no shared mutex on the hot path.
/// All write operations are sent via `send_command()` and processed between read cycles.
pub struct BoardHandle {
    /// Channel to send commands to the reader thread
    cmd_tx: std::sync::Mutex<Option<std::sync::mpsc::Sender<BoardCommand>>>,
    /// Whether the board is currently connected (cheap atomic check)
    connected: std::sync::atomic::AtomicBool,
    /// Flag to signal the reader thread to stop
    reader_running: std::sync::atomic::AtomicBool,
    /// Handle to the reader thread for joining on stop
    reader_handle: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl BoardHandle {
    pub fn new() -> Self {
        Self {
            cmd_tx: std::sync::Mutex::new(None),
            connected: std::sync::atomic::AtomicBool::new(false),
            reader_running: std::sync::atomic::AtomicBool::new(false),
            reader_handle: std::sync::Mutex::new(None),
        }
    }

    /// Connect a board and immediately start the reader thread.
    /// The reader thread takes exclusive ownership of `connection`.
    pub fn connect(self: &Arc<Self>, connection: BoardConnection) {
        // Stop any existing reader first
        self.stop_reader();

        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<BoardCommand>();
        *self.cmd_tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(cmd_tx);
        self.connected.store(true, std::sync::atomic::Ordering::Release);
        self.reader_running.store(true, std::sync::atomic::Ordering::Release);

        let handle_clone = Arc::clone(self);
        let thread_handle = std::thread::spawn(move || {
            log::info!("Firmata reader thread started (exclusive ownership)");
            let mut conn = connection;

            loop {
                // 1. Drain all pending commands (non-blocking)
                loop {
                    match cmd_rx.try_recv() {
                        Ok(BoardCommand::Stop) => {
                            log::info!("Firmata reader thread: Stop received");
                            return;
                        }
                        Ok(BoardCommand::SetPinMode { pin, mode }) => {
                            let _ = conn.set_pin_mode(pin, mode);
                        }
                        Ok(BoardCommand::DigitalWrite { pin, value }) => {
                            let _ = conn.digital_write(pin, value);
                        }
                        Ok(BoardCommand::AnalogWrite { pin, value }) => {
                            let _ = conn.analog_write(pin, value);
                        }
                        Ok(BoardCommand::EnableAnalogReporting { pin }) => {
                            let _ = conn.enable_analog_reporting(pin);
                        }
                        Ok(BoardCommand::DisableAnalogReporting { pin }) => {
                            let _ = conn.disable_analog_reporting(pin);
                        }
                        Ok(BoardCommand::EnableDigitalReporting { pin }) => {
                            let _ = conn.set_reporting(pin, true);
                        }
                        Ok(BoardCommand::DisableDigitalReporting { pin }) => {
                            let _ = conn.set_reporting(pin, false);
                        }
                        Ok(BoardCommand::ResetAllReporting) => {
                            let _ = conn.reset_all_reporting();
                        }
                        Ok(BoardCommand::SetPinChangeCallback { callback }) => {
                            conn.set_pin_change_callback(callback);
                        }
                        Ok(BoardCommand::ClearPinCache) => {
                            conn.clear_pin_cache();
                        }
                        Err(std::sync::mpsc::TryRecvError::Empty) => break,
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                            log::info!("Firmata reader: command channel closed, stopping");
                            return;
                        }
                    }
                }

                // 2. Check stop flag
                if !handle_clone.reader_running.load(std::sync::atomic::Ordering::Acquire) {
                    break;
                }

                // 3. Read one Firmata message
                match conn.board.read_and_decode() {
                    Ok(_) => {
                        conn.detect_and_emit_changes();
                    }
                    Err(e) => {
                        let err_str = format!("{}", e);
                        if err_str.contains("timed out") || err_str.contains("timeout") {
                            // Normal: no data available. Small sleep to avoid busy-wait.
                            std::thread::sleep(std::time::Duration::from_millis(1));
                        } else {
                            log::warn!("Firmata reader: I/O error: {}", err_str);
                            handle_clone.connected.store(false, std::sync::atomic::Ordering::Release);
                            break;
                        }
                    }
                }
            }

            log::info!("Firmata reader thread stopped");
        });

        *self.reader_handle.lock().unwrap_or_else(|e| e.into_inner()) = Some(thread_handle);
    }

    pub fn disconnect(&self) {
        self.stop_reader();
        self.connected.store(false, std::sync::atomic::Ordering::Release);
        *self.cmd_tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(std::sync::atomic::Ordering::Acquire)
    }

    /// Send a command to the reader thread. Fire-and-forget, never blocks.
    pub fn send_command(&self, cmd: BoardCommand) -> Result<(), String> {
        match self.cmd_tx.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            Some(tx) => tx.send(cmd).map_err(|_| "Board command channel closed".to_string()),
            None => Err("Board not connected".to_string()),
        }
    }

    /// Stop the reader thread and wait for clean exit.
    pub fn stop_reader(&self) {
        self.reader_running.store(false, std::sync::atomic::Ordering::Release);
        // Send Stop command to unblock the thread from its read loop
        if let Some(tx) = self.cmd_tx.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = tx.send(BoardCommand::Stop);
        }
        if let Some(handle) = self.reader_handle.lock().unwrap_or_else(|e| e.into_inner()).take() {
            match handle.join() {
                Ok(_) => log::info!("Reader thread stopped cleanly"),
                Err(_) => log::warn!("Reader thread panicked during shutdown"),
            }
        }
    }
}

impl Default for BoardHandle {
    fn default() -> Self {
        Self::new()
    }
}
```

Also simplify `BoardConnection::reset_all_reporting` to remove the blocking sleep and drain loop (sequence numbers handle staleness now):

```rust
/// Disable all reporting and clear state. Called inside the reader thread — no sleep needed.
pub fn reset_all_reporting(&mut self) -> Result<(), String> {
    log::info!("Resetting all pin reporting");
    self.pin_values.clear();
    for channel in 0..16 {
        let _ = self.board.report_analog(channel, 0);
    }
    for port in 0..13 {
        let _ = self.board.report_digital(port, 0);
    }
    Ok(())
}
```

- [ ] **Step 3.4: Run tests to confirm new BoardHandle tests pass**

```bash
cd apps/web/src-tauri && cargo test board_handle 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 3.5: Compile check — Task 3 must compile cleanly before proceeding**

The new `BoardHandle` still has the old `with_board` method present (it will be deleted at the END of Task 4, after all callers are migrated). At this point the build must be green.

```bash
cd apps/web/src-tauri && cargo build 2>&1 | tail -5
```

Expected: `Finished` — no errors.

---

### Task 4: Update all `with_board` callers to use `send_command`

**Files to modify** (all `with_board` callers):
- `apps/web/src-tauri/src/runtime/output/led.rs`
- `apps/web/src-tauri/src/runtime/output/relay.rs`
- `apps/web/src-tauri/src/runtime/output/rgb.rs`
- `apps/web/src-tauri/src/runtime/output/piezo.rs`
- `apps/web/src-tauri/src/runtime/output/servo.rs`
- `apps/web/src-tauri/src/runtime/input/button.rs`
- `apps/web/src-tauri/src/runtime/input/sensor.rs`
- `apps/web/src-tauri/src/runtime/input/motion.rs`
- `apps/web/src-tauri/src/runtime/input/proximity.rs`
- `apps/web/src-tauri/src/hardware/board.rs`
- `apps/web/src-tauri/src/runtime/mod.rs`

> **NOTE — `firmata.rs` is NOT in this list.** `apps/web/src-tauri/src/hardware/firmata.rs:47` calls `board_handle.connect(connection)` directly — this is how the connection is handed to the `BoardHandle`, not a `with_board` write call. Do NOT change it to `send_command`.

**Pattern for output components** — every `board.with_board(|conn| conn.X(...))` becomes `board.send_command(BoardCommand::X { ... })?`:

```rust
// BEFORE — led.rs turn_on()
board.with_board(|conn| conn.digital_write(self.config.pin, true))?;

// AFTER
board.send_command(BoardCommand::DigitalWrite { pin: self.config.pin, value: true })?;
```

```rust
// BEFORE — led.rs brightness()
board.with_board(|conn| {
    conn.set_pin_mode(self.config.pin, pin_mode::PWM)?;
    conn.analog_write(self.config.pin, value as u16)
})?;

// AFTER — two sequential commands (FIFO channel preserves order)
board.send_command(BoardCommand::SetPinMode { pin: self.config.pin, mode: pin_mode::PWM })?;
board.send_command(BoardCommand::AnalogWrite { pin: self.config.pin, value: value as u16 })?;
```

```rust
// BEFORE — led.rs initialize()
board.with_board(|conn| {
    conn.set_pin_mode(self.config.pin, pin_mode::OUTPUT)?;
    conn.digital_write(self.config.pin, false)
})?;

// AFTER
board.send_command(BoardCommand::SetPinMode { pin: self.config.pin, mode: pin_mode::OUTPUT })?;
board.send_command(BoardCommand::DigitalWrite { pin: self.config.pin, value: false })?;
```

**Pattern for input components initialize():**

```rust
// BEFORE — button.rs initialize()
board.with_board(|conn| {
    conn.set_pin_mode(self.config.pin, mode)?;
    conn.set_reporting(self.config.pin, true)
})?;

// AFTER
board.send_command(BoardCommand::SetPinMode { pin: self.config.pin, mode })?;
board.send_command(BoardCommand::EnableDigitalReporting { pin: self.config.pin })?;
```

```rust
// BEFORE — sensor.rs initialize()
board.with_board(|conn| {
    conn.set_pin_mode(pin, pin_mode::ANALOG)?;
    conn.enable_analog_reporting(pin)
})?;

// AFTER
board.send_command(BoardCommand::SetPinMode { pin, mode: pin_mode::ANALOG })?;
board.send_command(BoardCommand::EnableAnalogReporting { pin })?;
```

**Pattern for input component destroy():**

```rust
// BEFORE — button.rs destroy()
let _ = board.with_board(|conn| conn.disable_digital_reporting(self.config.pin));

// AFTER
let _ = board.send_command(BoardCommand::DisableDigitalReporting { pin: self.config.pin });
```

```rust
// BEFORE — sensor.rs destroy()
let _ = board.with_board(|conn| conn.disable_analog_reporting(pin));

// AFTER
let _ = board.send_command(BoardCommand::DisableAnalogReporting { pin });
```

**Remove synchronous `read_state` calls from input components** — these called `digital_read`/`analog_read` synchronously. With pin-change callbacks driving reads, these are dead code. Change the `"read"` method branch to return the cached value:

```rust
// BEFORE — button.rs call_method "read"
"read" => { let state = self.read_state()?; self.process_state(state); Ok(()) }

// AFTER — return cached value; real updates come via pin_change
"read" => {
    // Pin changes arrive via _pin_change callback; polling path is no-op
    Ok(())
}
```

```rust
// BEFORE — sensor.rs call_method "read"
"read" => { let v = self.read_value()?; self.process_reading(v); Ok(()) }

// AFTER
"read" => Ok(()),
```

**Remove `read_state()` / `read_value()` methods entirely** from button.rs, sensor.rs, motion.rs, proximity.rs (they called `with_board` and are now dead code).

**Pattern for servo.rs** — servo calls `conn.board.analog_write()` directly:

```rust
// BEFORE — servo.rs
board.with_board(|conn| conn.board.analog_write(self.config.pin as i32, clamped as i32)
    .map_err(|e| format!("Failed to write servo: {}", e)))?;

// AFTER
board.send_command(BoardCommand::AnalogWrite { pin: self.config.pin, value: clamped as u16 })?;
```

**Pattern for BoardManager::poll()** — delete this method, it will become unreachable:

```rust
// BEFORE — board.rs
pub fn poll(&self) -> Result<(), String> {
    self.handle.with_board(|conn| conn.read_all())
}
```

Delete the `poll()` method entirely from `BoardManager`.

**Pattern for FlowRuntime::install_pin_change_callback()** in `mod.rs`:

```rust
// BEFORE — mod.rs:173-178
let _ = self.board_handle().with_board(|conn| {
    conn.clear_pin_cache();
    conn.set_pin_change_callback(Arc::new(callback));
    Ok(())
});

// AFTER — commands are processed in order by the reader thread
let board = self.board_handle();
let _ = board.send_command(BoardCommand::ClearPinCache);
let _ = board.send_command(BoardCommand::SetPinChangeCallback { callback: Arc::new(callback) });
```

**Pattern for FlowRuntime::update_flow()** in `mod.rs`:

```rust
// BEFORE — mod.rs:211
let _ = board_handle.with_board(|conn| conn.reset_all_reporting());

// AFTER
let _ = board_handle.send_command(BoardCommand::ResetAllReporting);
```

- [ ] **Step 4.1: Apply all changes described above across all affected files**

Work through each file systematically. After each file, run:

```bash
cd apps/web/src-tauri && cargo check 2>&1 | grep "error\[" | head -20
```

Continue until no errors remain.

- [ ] **Step 4.2: Final compile check — zero errors**

```bash
cd apps/web/src-tauri && cargo build 2>&1 | tail -5
```

Expected: `Finished` with zero errors.

- [ ] **Step 4.3: Run full test suite**

```bash
cd apps/web/src-tauri && cargo test 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 4.4: Delete `with_board` from `BoardHandle` and remove `start_reader()` call sites**

All callers are now migrated. Delete the `with_board` method from `BoardHandle` in `base.rs`. Also remove the public `start_reader()` method (connection now starts the reader automatically via `connect()`). Remove all `start_reader()` call sites in `lib.rs`:

```bash
grep -n "start_reader" apps/web/src-tauri/src/lib.rs
```

Remove those lines.

- [ ] **Step 4.5: Compile and test again**

```bash
cd apps/web/src-tauri && cargo build 2>&1 | tail -5 && cargo test 2>&1 | tail -20
```

Expected: clean build, all tests pass.

- [ ] **Step 4.6: Commit**

```bash
cd apps/web/src-tauri
git add src/runtime/base.rs src/runtime/mod.rs src/hardware/board.rs \
        src/runtime/output/led.rs src/runtime/output/relay.rs \
        src/runtime/output/rgb.rs src/runtime/output/piezo.rs \
        src/runtime/output/servo.rs src/runtime/input/button.rs \
        src/runtime/input/sensor.rs src/runtime/input/motion.rs \
        src/runtime/input/proximity.rs src/lib.rs
git commit -m "feat(runtime): reader thread owns BoardConnection exclusively

Add BoardCommand channel to BoardHandle. The reader thread owns
BoardConnection and processes write commands between read cycles.
Removes Mutex held during blocking serial I/O — write operations
(digital_write, set_pin_mode, etc.) are now fire-and-forget via
send_command(), never blocking the caller.

Removes with_board() API. Updates all component callers to use
send_command(). Removes synchronous digital_read/analog_read paths
from input components (reads arrive via _pin_change callback).

Also removes the 50ms sleep in reset_all_reporting — the reader
thread processes the disable commands in-order and sequence numbers
handle any residual stale data."
```

---

## Chunk 3: Cleanup — Remove Redundant Polling and Micro-Optimizations

### Task 5: Remove the redundant 100 Hz polling loop

**Files:**
- Modify: `apps/web/src-tauri/src/lib.rs` (remove polling thread)
- Modify: `apps/web/src-tauri/src/runtime/mod.rs` (remove `poll_inputs`)
- Modify: `apps/web/src-tauri/src/runtime/executor.rs` (remove `poll_inputs`)
- Modify: `apps/web/src-tauri/src/hardware/board.rs` (already cleaned up in Task 4)

The 100Hz polling thread (every 10ms) calls `board_manager.poll()` (races the reader thread) and `executor.poll_inputs()` (calls `"read"` on input components, which is now a no-op). Both are dead paths.

- [ ] **Step 5.1: Remove polling thread from lib.rs**

In `apps/web/src-tauri/src/lib.rs`, remove the entire block (approximately lines 272–290):

```rust
// REMOVE this entire block:
// Start input polling loop
let flow_runtime_poll = Arc::clone(&flow_runtime);
let board_connected_poll = Arc::clone(&board_connected_setup);
std::thread::spawn(move || {
    loop {
        std::thread::sleep(std::time::Duration::from_millis(10));
        if !*board_connected_poll.read().unwrap() { continue; }
        if let Ok(mut runtime) = flow_runtime_poll.try_lock() {
            let _ = runtime.poll_inputs();
        }
    }
});
```

- [ ] **Step 5.2: Remove `poll_inputs` from FlowRuntime in mod.rs**

In `apps/web/src-tauri/src/runtime/mod.rs`, remove:

```rust
// REMOVE
pub fn poll_inputs(&mut self) -> Result<(), String> {
    if self.board_manager.is_connected() {
        self.board_manager.poll()?;
    }
    self.executor.poll_inputs()
}
```

- [ ] **Step 5.3: Remove `poll_inputs` from FlowExecutor in executor.rs**

In `apps/web/src-tauri/src/runtime/executor.rs`, remove the `poll_inputs` method (approximately lines 280–304).

- [ ] **Step 5.4: Compile and test**

```bash
cd apps/web/src-tauri && cargo build 2>&1 | tail -5 && cargo test 2>&1 | tail -20
```

Expected: clean build, all tests pass.

- [ ] **Step 5.5: Commit**

```bash
cd apps/web/src-tauri && git add src/lib.rs src/runtime/mod.rs src/runtime/executor.rs
git commit -m "chore(runtime): remove redundant 100Hz polling loop

The polling loop called board_manager.poll() (racing the reader thread
for the mutex) and executor.poll_inputs() (a no-op since input components
now respond to pin_change callbacks). Both paths are dead with the
reader-thread-owns-connection architecture."
```

---

### Task 6: Targeted pin scan — only check pins with listeners

**Files:**
- Modify: `apps/web/src-tauri/src/runtime/base.rs` (`BoardConnection::detect_and_emit_changes`)

Currently `detect_and_emit_changes()` iterates ALL board pins (30–70 for Arduino Mega) on every Firmata message, allocating a `Vec` each time. With pin listeners registered for at most 6 pins, this is wasteful. Pass the set of active pins explicitly.

- [ ] **Step 6.1: Note on testability and verify the fallback logic**

`detect_and_emit_changes` requires a live `BoardConnection` (real serial port) to run, so it cannot be meaningfully unit-tested without hardware. The correctness of the active-pin filtering is verified by:
1. Code review of the `if self.active_pins.is_empty()` fallback in Step 6.3
2. Manual integration testing with a connected board

Add a structural test that confirms `active_pins` tracks insertions correctly (this runs without hardware):

Add to `#[cfg(test)]` in `base.rs`:

```rust
#[test]
fn active_pins_tracking() {
    use std::collections::HashSet;
    let mut active: HashSet<u8> = HashSet::new();
    active.insert(2);
    active.insert(14);
    assert!(active.contains(&2));
    assert!(active.contains(&14));
    assert!(!active.contains(&13));
    // Clear simulates flow reset
    active.clear();
    assert!(active.is_empty(), "clear_pin_cache should reset active pins");
}
```

This test will pass immediately — it verifies the data structure semantics used by the implementation.

- [ ] **Step 6.2: Add `active_pins` HashSet to `BoardConnection`**

In `apps/web/src-tauri/src/runtime/base.rs`, add a field to `BoardConnection`:

```rust
pub struct BoardConnection {
    pub board: firmata_rs::Board<SerialPortWrapper>,
    pub port_name: String,
    pin_values: HashMap<u8, u16>,
    pin_change_callback: Option<Arc<PinChangeCallback>>,
    /// Pins that have listeners registered. Only these are checked in detect_and_emit_changes.
    /// Empty means "check all pins" (safe fallback for cases before listeners are registered).
    active_pins: std::collections::HashSet<u8>,
}
```

Update `BoardConnection::new()` to initialize `active_pins: std::collections::HashSet::new()`.

Add a new `BoardCommand` variant (add to the enum in Task 2's definition):

```rust
/// Register a pin as active so detect_and_emit_changes checks it.
/// Call once per pin that has a listener. Replaces scanning all pins.
RegisterActivePin { pin: u8 },
```

Handle it in the reader thread command loop:

```rust
Ok(BoardCommand::RegisterActivePin { pin }) => {
    conn.active_pins.insert(pin);
}
```

Also handle `ClearPinCache` to also clear `active_pins` (since `clear_pin_cache` is called on flow reset):

Update `clear_pin_cache`:
```rust
pub fn clear_pin_cache(&mut self) {
    self.pin_values.clear();
    self.active_pins.clear();
}
```

- [ ] **Step 6.3: Update `detect_and_emit_changes` to only scan active pins**

Replace the method body in `BoardConnection::detect_and_emit_changes`:

```rust
fn detect_and_emit_changes(&mut self) {
    if self.pin_change_callback.is_none() {
        return; // No callback installed yet — skip entirely
    }

    let pins = self.board.pins();
    let mut changes = Vec::new();

    // Fast path: only check pins with listeners.
    // Falls back to all pins only if no active pins registered yet.
    let indices: Box<dyn Iterator<Item = usize>> = if self.active_pins.is_empty() {
        Box::new(0..pins.len())
    } else {
        Box::new(self.active_pins.iter().map(|&p| p as usize))
    };

    for index in indices {
        let Some(pin) = pins.get(index) else { continue };
        let pin_num = index as u8;
        let current_value = pin.value as u16;
        let is_analog = pin.analog;

        let last_value = self.pin_values.get(&pin_num).copied();
        if last_value == Some(current_value) {
            continue;
        }

        let should_emit = if is_analog {
            match last_value {
                Some(last) => (current_value as i32 - last as i32).unsigned_abs() as u16 >= 1,
                None => true,
            }
        } else {
            true
        };

        if should_emit {
            self.pin_values.insert(pin_num, current_value);
            changes.push(PinChangeEvent { pin: pin_num, value: current_value, is_analog });
        }
    }

    if let Some(callback) = &self.pin_change_callback {
        for change in changes {
            callback(change);
        }
    }
}
```

- [ ] **Step 6.4: Send `RegisterActivePin` from FlowRuntime when registering listeners**

In `apps/web/src-tauri/src/runtime/mod.rs`, after `register_pin_listener(...)` is called, also send the command:

```rust
// In register_component_pin_listener(), after self.register_pin_listener(PinListener { ... }):
let board = self.board_handle();
if board.is_connected() {
    let _ = board.send_command(BoardCommand::RegisterActivePin { pin });
}
```

- [ ] **Step 6.5: Compile and test**

```bash
cd apps/web/src-tauri && cargo build 2>&1 | tail -5 && cargo test 2>&1 | tail -20
```

Expected: clean build, all tests pass.

- [ ] **Step 6.6: Commit**

```bash
cd apps/web/src-tauri && git add src/runtime/base.rs src/runtime/mod.rs
git commit -m "perf(runtime): targeted pin scan in detect_and_emit_changes

Track active pins (those with listeners) in BoardConnection.
detect_and_emit_changes now only iterates registered pins instead of
all 30-70 board pins on every Firmata message.

Falls back to full scan when no active pins are registered (safe
default before listeners are set up)."
```

---

### Task 7: Fix atomic memory ordering on reader stop flag

**Files:**
- Modify: `apps/web/src-tauri/src/runtime/base.rs` (already done in Task 3 — verify ordering used)

The `reader_running` stop flag uses `SeqCst` (full memory fence, most expensive) when `Release`/`Acquire` pairing is sufficient for a boolean stop flag communicated between two threads.

- [ ] **Step 7.1: Verify Task 3 already uses Acquire/Release**

In the new `BoardHandle::connect()` from Task 3:
- `store(true, Ordering::Release)` ✓
- `load(Ordering::Acquire)` ✓
- `store(false, Ordering::Release)` in `stop_reader()` ✓

If `SeqCst` was accidentally used anywhere in the new code, change it to `Release` (stores) or `Acquire` (loads).

```bash
grep -n "SeqCst" apps/web/src-tauri/src/runtime/base.rs
```

Expected: zero results (all `SeqCst` should have been replaced in Task 3).

If any remain, update them:
- Stores: `Ordering::Release`
- Loads: `Ordering::Acquire`

- [ ] **Step 7.2: Final full test run**

```bash
cd apps/web/src-tauri && cargo test 2>&1 | tail -30
```

Expected: all tests pass, zero warnings about unused code.

- [ ] **Step 7.3: Final commit**

```bash
cd apps/web/src-tauri && git add -p
git commit -m "chore(runtime): use Acquire/Release ordering for stop flag

SeqCst imposes a full sequential consistency barrier on every loop
iteration. The reader_running stop flag only requires Release on the
writing side and Acquire on the reading side — sufficient for
happens-before between two threads communicating via a single boolean."
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/runtime/base.rs` | Add `BoardCommand` enum; replace `BoardHandle.inner: Mutex<Option<BoardConnection>>` with `cmd_tx + connected: AtomicBool`; reader thread owns connection exclusively; simplify `reset_all_reporting` (remove 50ms sleep); targeted pin scan in `detect_and_emit_changes` |
| `src/lib.rs` | `try_lock()` → `blocking_lock()`; remove polling thread; remove `start_reader()` calls |
| `src/runtime/mod.rs` | `install_pin_change_callback` uses `send_command`; `update_flow` uses `send_command` for reset; remove `poll_inputs`; add `RegisterActivePin` dispatch |
| `src/runtime/executor.rs` | Remove `poll_inputs` method |
| `src/hardware/board.rs` | Remove `poll()` method |
| `src/runtime/output/{led,relay,rgb,piezo,servo}.rs` | `with_board` → `send_command` |
| `src/runtime/input/{button,sensor,motion,proximity}.rs` | `with_board` → `send_command`; remove synchronous `read_state`/`read_value` methods; `"read"` method becomes no-op |
