# Pin Lifecycle & Hot-Swap Architecture

## Overview

This document describes how Microflow manages Firmata pin reporting during component lifecycle events, particularly during hot-swapping (changing pins while the flow is running).

## The Problem

When a user changes a component's pin assignment in the flow editor, the runtime must:

1. Stop receiving data from the old pin
2. Start receiving data from the new pin
3. Clear any stale data in the serial buffer

Without proper cleanup, Firmata continues reporting on old pins, causing:
- Doubled readings (old + new pins both reporting)
- Delayed data (~30 seconds) as the serial buffer fills
- Incorrect values routed to components

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         FLOW UPDATE                                  │
│                                                                      │
│  1. Frontend sends flow_update command                              │
│  2. FlowRuntime.update_flow() called                                │
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ CLEANUP PHASE                                                    ││
│  │                                                                  ││
│  │  executor.clear()                                                ││
│  │       │                                                          ││
│  │       ▼                                                          ││
│  │  For each component:                                             ││
│  │       component.destroy()                                        ││
│  │           │                                                      ││
│  │           ├─► Sensor: disable_analog_reporting(pin)             ││
│  │           ├─► Button: disable_digital_reporting(pin)            ││
│  │           ├─► Motion: disable_digital_reporting(pin)            ││
│  │           └─► Proximity: disable_analog_reporting(pin)          ││
│  │                                                                  ││
│  │  clear_pin_listeners()                                           ││
│  │  reset_all_reporting()  ◄── Nuclear option: disable ALL pins    ││
│  │       │                                                          ││
│  │       ├─► report_analog(0..15, 0)                               ││
│  │       ├─► report_digital(0..12, 0)                              ││
│  │       └─► Flush serial buffer                                   ││
│  └─────────────────────────────────────────────────────────────────┘│
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ CREATION PHASE                                                   ││
│  │                                                                  ││
│  │  For each node:                                                  ││
│  │       registry.create(component)                                 ││
│  │           │                                                      ││
│  │           ▼                                                      ││
│  │       component.initialize(board_handle)                         ││
│  │           │                                                      ││
│  │           ├─► Sensor: enable_analog_reporting(pin)              ││
│  │           ├─► Button: set_reporting(pin, true)                  ││
│  │           ├─► Motion: set_reporting(pin, true)                  ││
│  │           └─► Proximity: enable_analog_reporting(pin)           ││
│  │                                                                  ││
│  │       register_pin_listener(component_id, pin)                   ││
│  └─────────────────────────────────────────────────────────────────┘│
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ CALLBACK INSTALLATION                                            ││
│  │                                                                  ││
│  │  install_pin_change_callback()                                   ││
│  │       │                                                          ││
│  │       ├─► Clear pin value cache                                 ││
│  │       └─► Set callback on BoardConnection                       ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

## Key Components

### BoardConnection (`runtime/base.rs`)

Wraps the firmata-rs Board with pin state tracking:

```rust
pub struct BoardConnection {
    board: firmata_rs::Board<SerialPortWrapper>,
    pin_values: HashMap<u8, u16>,           // Cached values for change detection
    pin_change_callback: Option<Arc<PinChangeCallback>>,
}
```

**Critical Methods:**

| Method | Purpose |
|--------|---------|
| `enable_analog_reporting(pin)` | Tell Firmata to start sending analog data |
| `disable_analog_reporting(pin)` | Tell Firmata to stop sending analog data |
| `disable_digital_reporting(pin)` | Tell Firmata to stop sending digital port data |
| `reset_all_reporting()` | Disable ALL reporting + flush serial buffer |
| `clear_pin_cache()` | Reset change detection state |

### Component Lifecycle

Each input component follows this pattern:

```rust
impl Component for Sensor {
    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String> {
        board.with_board(|conn| {
            conn.set_pin_mode(pin, pin_mode::ANALOG)?;
            conn.enable_analog_reporting(pin)  // Start receiving data
        })?;
        self.board = Some(board);
        Ok(())
    }

    fn destroy(&mut self) {
        if let Some(board) = &self.board {
            // CRITICAL: Disable reporting before releasing board
            let _ = board.with_board(|conn| conn.disable_analog_reporting(pin));
        }
        self.board = None;
    }
}
```

### Pin Listeners (`runtime/mod.rs`)

Maps pins to components for event routing:

```rust
pub struct PinListener {
    pub component_id: String,
    pub pin: u8,
    pub is_analog: bool,
    pub threshold: u16,
}

// Stored in FlowRuntime
pin_listeners: Arc<Mutex<HashMap<u8, Vec<PinListener>>>>
```

When Firmata reports a pin change:
1. `BoardConnection.detect_and_emit_changes()` fires callback
2. Callback looks up listeners for that pin
3. Emits `ComponentEvent` with `source_handle: "_pin_change"`
4. Executor routes to component's `call_method("pin_change", value)`

## Three Layers of Defense

The hot-swap fix uses defense in depth:

### Layer 1: Component-Level Cleanup
Each component disables its own pin reporting in `destroy()`. This is the most targeted approach.

### Layer 2: Global Reset
`reset_all_reporting()` disables ALL pins at the start of every flow update. This catches any edge cases where component cleanup might fail.

### Layer 3: Buffer Flush
After disabling reporting, we read until timeout to clear any in-flight data from the serial buffer.

```rust
pub fn reset_all_reporting(&mut self) -> Result<(), String> {
    self.pin_values.clear();
    
    // Disable all analog channels
    for channel in 0..16 {
        let _ = self.board.report_analog(channel, 0);
    }
    
    // Disable all digital ports
    for port in 0..13 {
        let _ = self.board.report_digital(port, 0);
    }
    
    // Let board process disable commands
    std::thread::sleep(Duration::from_millis(50));
    
    // Flush serial buffer
    loop {
        match self.board.read_and_decode() {
            Ok(_) => continue,
            Err(_) => break,  // Timeout = buffer clear
        }
    }
    
    Ok(())
}
```

## Firmata Protocol Details

### Analog Reporting
```
report_analog(channel, 1)  // Enable: 0xC0 | channel, 1
report_analog(channel, 0)  // Disable: 0xC0 | channel, 0
```

Channels are 0-indexed (A0 = channel 0, A1 = channel 1, etc.)

### Digital Reporting
```
report_digital(port, 1)  // Enable: 0xD0 | port, 1
report_digital(port, 0)  // Disable: 0xD0 | port, 0
```

Ports group 8 pins (port 0 = pins 0-7, port 1 = pins 8-15, etc.)

**Note:** Disabling a digital port affects all 8 pins in that port. This is a Firmata limitation.

## Debugging

Enable logging to trace pin lifecycle:

```
RUST_LOG=info cargo tauri dev
```

Look for:
```
Sensor sensor_1 destroy: disabling analog reporting for pin 14
Resetting all Firmata reporting for clean flow update
Disabling analog reporting: pin=14, analog_channel=0
Enabling analog reporting: pin=15, analog_channel=1
Pin change callback installed (cache cleared)
```

## Common Issues

### Doubled Readings
**Symptom:** Values appear twice or from wrong component
**Cause:** Old pin still reporting after swap
**Fix:** Ensure `destroy()` calls `disable_*_reporting()`

### 30-Second Delay
**Symptom:** Readings are correct but delayed
**Cause:** Serial buffer full of stale data
**Fix:** `reset_all_reporting()` flushes buffer

### Missing Readings After Swap
**Symptom:** New pin doesn't report
**Cause:** `initialize()` not called or failed
**Fix:** Check logs for initialization errors

## Related Files

- `apps/web/src-tauri/src/runtime/base.rs` - BoardConnection, Component trait
- `apps/web/src-tauri/src/runtime/mod.rs` - FlowRuntime, pin listeners
- `apps/web/src-tauri/src/runtime/input/*.rs` - Input component implementations
- `apps/web/src-tauri/src/runtime/commands.rs` - flow_update command
