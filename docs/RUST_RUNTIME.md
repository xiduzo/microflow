# Rust Runtime Architecture

> **Last Updated:** February 2026  
> **Author:** Senior Rust Consultant  
> **Status:** Assessment Complete, Improvements Planned

This document provides a comprehensive overview of the Tauri/Rust backend that powers Microflow's desktop application. It covers architecture, data flow, component patterns, and known issues with recommended fixes.

---

## Table of Contents

1. [Overview](#overview)
2. [Module Architecture](#module-architecture)
3. [Data Flow](#data-flow)
4. [Component System](#component-system)
5. [Hardware Integration](#hardware-integration)
6. [MQTT Subsystem](#mqtt-subsystem)
7. [Flasher Module](#flasher-module)
8. [Threading Model](#threading-model)
9. [Known Issues & Technical Debt](#known-issues--technical-debt)
10. [Development Guide](#development-guide)

---

## Overview

The Rust runtime is a Tauri 2.x application that provides:

- **Flow Execution Engine** — Runs visual flows with hardware I/O
- **Hardware Abstraction** — Firmata protocol over serial for Arduino boards
- **Firmware Flashing** — Auto-flash StandardFirmata to supported boards
- **MQTT Connectivity** — IoT broker integration for pub/sub messaging

### Key Files

```
apps/web/src-tauri/
├── Cargo.toml           # Dependencies and build config
├── src/
│   ├── main.rs          # Entry point (minimal)
│   ├── lib.rs           # Application setup, state, Tauri wiring
│   ├── runtime/         # Flow execution engine
│   ├── hardware/        # Serial port & Firmata management
│   ├── mqtt/            # MQTT broker connections
│   └── flasher/         # Arduino firmware flashing
```

### Dependencies

| Crate | Version | Purpose |
|-------|---------|---------|
| `tauri` | 2.9.5 | Desktop app framework |
| `firmata-rs` | 0.4.3 | Firmata protocol implementation |
| `serialport` | 4.x | Serial port access |
| `tokio` | 1.x | Async runtime |
| `mqtt-endpoint-tokio` | 0.6 | MQTT client |
| `serde` / `serde_json` | 1.x | Serialization |

---

## Module Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         lib.rs                                   │
│  - AppState (shared state)                                       │
│  - Tauri setup & plugin registration                            │
│  - Event forwarding threads                                      │
└─────────────────────────────────────────────────────────────────┘
           │                    │                    │
           ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│    runtime/     │  │   hardware/     │  │     mqtt/       │
│                 │  │                 │  │                 │
│ - FlowRuntime   │  │ - HardwareService│ │ - MqttManager   │
│ - FlowExecutor  │  │ - PortMonitor   │  │ - MqttBroker    │
│ - Components    │  │ - BoardHandle   │  │ - Subscriptions │
│ - Registry      │  │ - Firmata       │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │    flasher/     │
                     │                 │
                     │ - STK500v1/v2   │
                     │ - AVR109        │
                     │ - Hex Parser    │
                     └─────────────────┘
```

### Module Responsibilities

| Module | Single Responsibility |
|--------|----------------------|
| `runtime/` | Execute flow graphs, manage component lifecycle |
| `hardware/` | Detect ports, establish Firmata connections, emit hardware events |
| `mqtt/` | Manage broker connections, route pub/sub messages |
| `flasher/` | Flash firmware to Arduino boards via bootloader protocols |

---

## Data Flow

### Flow Update Lifecycle

```
Frontend (React)                    Backend (Rust)
      │                                  │
      │  flow_update command             │
      │ ─────────────────────────────────▶
      │  {nodes: [...], edges: [...]}    │
      │                                  │
      │                          ┌───────▼───────┐
      │                          │ Check board   │
      │                          │ connected?    │
      │                          └───────┬───────┘
      │                                  │
      │                    ┌─────────────┴─────────────┐
      │                    │                           │
      │              Connected                   Not Connected
      │                    │                           │
      │                    ▼                           ▼
      │           ┌────────────────┐         ┌────────────────┐
      │           │ Clear existing │         │ Store as       │
      │           │ components     │         │ pending_flow   │
      │           └────────┬───────┘         └────────────────┘
      │                    │
      │                    ▼
      │           ┌────────────────┐
      │           │ Create new     │
      │           │ components via │
      │           │ Registry       │
      │           └────────┬───────┘
      │                    │
      │                    ▼
      │           ┌────────────────┐
      │           │ Wire edges     │
      │           │ (edge_map)     │
      │           └────────┬───────┘
      │                    │
      │                    ▼
      │           ┌────────────────┐
      │           │ Install pin    │
      │           │ change callback│
      │           └────────────────┘
```

### Event Propagation

```
Hardware Pin Change
        │
        ▼
┌───────────────────┐
│ BoardConnection   │
│ detect_and_emit() │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ PinChangeCallback │
│ (closure)         │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐     ┌───────────────────┐
│ event_tx.send()   │────▶│ Event Forwarding  │
│ ComponentEvent    │     │ Thread            │
└───────────────────┘     └─────────┬─────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
          ┌─────────────────┐            ┌─────────────────┐
          │ Internal event  │            │ Emit to Tauri   │
          │ (_pin_change)   │            │ "component-event"│
          │ Route to source │            └─────────────────┘
          └────────┬────────┘
                   │
                   ▼
          ┌─────────────────┐
          │ FlowExecutor    │
          │ process_event() │
          └────────┬────────┘
                   │
                   ▼
          ┌─────────────────┐
          │ Route via       │
          │ edge_map to     │
          │ target.call()   │
          └─────────────────┘
```

---

## Component System

### Component Trait

All flow nodes implement the `Component` trait defined in `runtime/base.rs`:

```rust
pub trait Component: Send + Sync {
    // Identity
    fn id(&self) -> &str;
    fn component_type(&self) -> &'static str;
    
    // Value management
    fn value(&self) -> ComponentValue;
    fn set_value(&mut self, value: ComponentValue);
    
    // Lifecycle
    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String>;
    fn destroy(&mut self);
    
    // Method dispatch (called by edges)
    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String>;
    
    // Event emission
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>>;
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>);
    
    // Optional overrides
    fn aggregates_inputs(&self) -> bool { false }
    fn requires_hardware(&self) -> bool { false }
}
```

### Component Categories

| Category | Components | Hardware Required |
|----------|------------|-------------------|
| **Input** | Button, Sensor, Motion, Proximity | Yes |
| **Output** | Led, Rgb, Servo, Relay, Piezo, Monitor | Yes (except Monitor) |
| **Control** | Counter, Delay, Trigger | No |
| **Generator** | Constant, Interval, Oscillator | No |
| **Transformation** | Calculate, Compare, Gate, RangeMap, Smooth | No |
| **External** | Mqtt | No |

### Adding a New Component

1. Create the component file in the appropriate category folder:

```rust
// runtime/output/buzzer.rs
use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuzzerConfig {
    #[serde(default = "default_pin")]
    pub pin: u8,
    #[serde(default)]
    pub frequency: u32,
}

fn default_pin() -> u8 { 9 }

impl Default for BuzzerConfig {
    fn default() -> Self {
        Self { pin: default_pin(), frequency: 440 }
    }
}

pub struct Buzzer {
    base: ComponentBase,
    config: BuzzerConfig,
    board: Option<Arc<BoardHandle>>,
}

impl Buzzer {
    pub fn new(id: String, config: BuzzerConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            board: None,
        }
    }
    
    pub fn beep(&mut self) -> Result<(), String> {
        // Implementation
        Ok(())
    }
}

impl Component for Buzzer {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Buzzer" }
    fn requires_hardware(&self) -> bool { true }
    
    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), String> {
        // Set pin mode, etc.
        self.board = Some(board);
        Ok(())
    }
    
    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "beep" => self.beep(),
            "trigger" => self.beep(),
            _ => Err(format!("Unknown method: {}", method)),
        }
    }
    
    fn destroy(&mut self) {
        self.board = None;
    }
    
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> {
        self.base.event_sender.clone()
    }
    
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) {
        self.base.event_sender = Some(sender);
    }
}
```

2. Export from the category's `mod.rs`:

```rust
// runtime/output/mod.rs
mod buzzer;
pub use buzzer::{Buzzer, BuzzerConfig};
```

3. Register in `ComponentRegistry`:

```rust
// runtime/registry.rs
self.register_hardware("Buzzer", |id, data| {
    let config: BuzzerConfig = serde_json::from_value(data.clone()).unwrap_or_default();
    Box::new(Buzzer::new(id, config))
});
```

4. Add corresponding React node in `apps/web/src/components/flow/nodes/`

---

## Hardware Integration

### Connection Lifecycle

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Detect    │────▶│   Flash     │────▶│  Connect    │
│   USB Port  │     │  Firmata    │     │  Firmata    │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       │                   │                   │
       ▼                   ▼                   ▼
  PortMonitor         Flasher            BoardHandle
  get_ports()      flash_standard_     connect()
                      firmata()
```

### BoardHandle

The `BoardHandle` is the thread-safe interface for components to access hardware:

```rust
// Shared across all components
let board_handle: Arc<BoardHandle> = runtime.board_handle();

// Components use it like this:
board_handle.with_board(|conn| {
    conn.digital_write(pin, true)?;
    Ok(())
})?;
```

### Pin Modes (Firmata)

```rust
pub mod pin_mode {
    pub const INPUT: u8 = 0;
    pub const OUTPUT: u8 = 1;
    pub const ANALOG: u8 = 2;
    pub const PWM: u8 = 3;
    pub const SERVO: u8 = 4;
    pub const PULLUP: u8 = 11;
}
```

### Reader Thread

A dedicated thread continuously reads Firmata messages:

```rust
// Started when board connects
board_handle.start_reader();

// The reader thread:
// 1. Calls board.read_and_decode() in a loop
// 2. Detects pin value changes
// 3. Invokes pin_change_callback for registered pins
// 4. Stops when reader_running flag is set to false
```

---

## MQTT Subsystem

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     MqttManager                          │
│  - Manages multiple broker connections                   │
│  - Connection pooling (one connection per broker)        │
└─────────────────────────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
     ┌─────────────────┐       ┌─────────────────┐
     │   MqttBroker    │       │   MqttBroker    │
     │   (broker-1)    │       │   (broker-2)    │
     └─────────────────┘       └─────────────────┘
```

### Supported Protocols

| URL Scheme | Transport | Default Port |
|------------|-----------|--------------|
| `mqtt://` | TCP | 1883 |
| `mqtts://` | TLS | 8883 |
| `ws://` | WebSocket | 80 |
| `wss://` | WebSocket + TLS | 443 |

### Flow Integration

MQTT nodes in flows work via special event handling:

1. **Subscribe nodes** register callbacks via `MqttManager.subscribe()`
2. **Publish nodes** emit `_mqtt_publish` events with JSON payload
3. The event forwarding thread intercepts these and calls `MqttManager.publish()`

---

## Flasher Module

### Supported Boards

| Board | Protocol | USB VID:PID |
|-------|----------|-------------|
| Arduino Uno | STK500v1 | 2341:0043 |
| Arduino Nano | STK500v1 | — |
| Arduino Mega | STK500v2 | 2341:0042 |
| Arduino Leonardo | AVR109 | 2341:8036 |
| Arduino Micro | AVR109 | 2341:8037 |

### Flash Process

```
1. Detect board by USB VID/PID
2. Select appropriate protocol
3. Reset board into bootloader mode
4. Sync with bootloader
5. Erase flash memory
6. Write hex data in pages
7. Verify written data
8. Exit bootloader (board resets)
```

### Hex Files

Pre-compiled StandardFirmata hex files are embedded in the binary:

```
flasher/hex/
├── uno/StandardFirmata.cpp.hex
├── nano/StandardFirmata.cpp.hex
├── mega/StandardFirmata.cpp.hex
├── leonardo/StandardFirmata.cpp.hex
└── ...
```

---

## Threading Model

### Thread Overview

| Thread | Purpose | Lifetime |
|--------|---------|----------|
| Main (Tauri) | UI events, command handlers | App lifetime |
| Event Forwarding | Route ComponentEvents to frontend & executor | App lifetime |
| MQTT Publish Handler | Process publish requests | App lifetime |
| Hardware Monitor | Detect port changes, auto-flash | App lifetime |
| Firmata Reader | Read serial data, detect pin changes | While board connected |
| Input Polling | Poll input components at 100Hz | App lifetime |

### Synchronization Primitives

```rust
// Shared state in AppState
pub struct AppState {
    pub hardware_service: Arc<Mutex<HardwareService>>,      // std::sync::Mutex
    pub flow_runtime: Arc<Mutex<FlowRuntime>>,              // std::sync::Mutex
    pub pending_flow: Arc<RwLock<Option<FlowUpdate>>>,      // std::sync::RwLock
    pub board_connected: Arc<RwLock<bool>>,                 // std::sync::RwLock
    pub mqtt_manager: MqttManager,                          // Internal tokio::sync
    pub mqtt_publish_tx: mpsc::UnboundedSender<...>,        // tokio::sync::mpsc
}
```

### ⚠️ Known Threading Issues

1. **Blocking locks in async context** — `std::sync::Mutex` used where `tokio::sync::Mutex` should be
2. **Reader thread not properly joined** — Can cause resource leaks
3. **No lock timeouts** — Potential for deadlocks under contention

---

## Known Issues & Technical Debt

### Critical (P0)

| Issue | Location | Impact | Recommended Fix |
|-------|----------|--------|-----------------|
| Reader thread not joined | `base.rs:stop_reader()` | Resource leaks, undefined behavior | Implement proper cancellation token |
| Blocking mutex in async | `lib.rs`, `commands.rs` | Can block Tokio runtime | Use `tokio::sync::Mutex` |
| Race condition on flow update | `mod.rs:update_flow()` | Stale pin events | Add sequence numbers to events |

### High (P1)

| Issue | Location | Impact | Recommended Fix |
|-------|----------|--------|-----------------|
| No MQTT reconnection | `broker.rs` | Lost connections stay dead | Add exponential backoff retry |
| Inconsistent error handling | Throughout | Hard to debug failures | Unified `RuntimeError` type |
| No tests | — | Regressions go unnoticed | Add unit & integration tests |

### Medium (P2)

| Issue | Location | Impact | Recommended Fix |
|-------|----------|--------|-----------------|
| Excessive cloning | Throughout | Memory pressure | Use `Arc<str>`, `Cow` |
| Magic numbers | Various | Hard to tune | Centralize in config module |
| Mixed async/sync | `control/delay.rs` | Confusing, potential panics | Clear async boundaries |

---

## Development Guide

### Building

```bash
# From apps/web directory
cd apps/web

# Development build
bun run desktop:dev

# Production build
bun run desktop:build
```

### Debugging

1. **Enable logging:**
```rust
// In lib.rs, logging is enabled in debug builds
tauri_plugin_log::Builder::default()
    .level(log::LevelFilter::Info)  // Change to Debug or Trace
    .build()
```

2. **View logs:**
   - macOS: `~/Library/Logs/com.microflow.app/`
   - Linux: `~/.local/share/com.microflow.app/logs/`
   - Windows: `%APPDATA%\com.microflow.app\logs\`

3. **Serial port debugging:**
```bash
# List ports
ls /dev/cu.* /dev/tty.*

# Monitor serial (macOS)
screen /dev/cu.usbmodem14101 57600
```

### Testing Hardware Without Hardware

For development without physical Arduino:

1. Use a virtual serial port pair (e.g., `socat`)
2. Run a Firmata simulator
3. Or use the Monitor component which doesn't require hardware

### Code Style

- Run `cargo clippy` before committing
- Format with `cargo fmt`
- Follow existing patterns for new components
- Add doc comments for public APIs

---

## Appendix: Tauri Commands

| Command | Parameters | Description |
|---------|------------|-------------|
| `flow_update` | `flow: FlowUpdate, brokers?: BrokerConfig[]` | Update the running flow |
| `component_call` | `component_id, method, args` | Call a method on a component |
| `get_available_serial_ports` | — | List detected serial ports |
| `flash_firmware` | `port, board_type, hex_content` | Flash custom firmware |
| `flash_standard_firmata` | `port, board_type` | Flash StandardFirmata |
| `auto_flash_firmata` | `port, vid, pid` | Auto-detect and flash |
| `get_supported_boards` | — | List supported board types |
| `mqtt_connect` | `config: BrokerConfig` | Connect to MQTT broker |
| `mqtt_disconnect` | `broker_id` | Disconnect from broker |
| `mqtt_subscribe` | `broker_id, topic` | Subscribe to topic |
| `mqtt_unsubscribe` | `broker_id, topic` | Unsubscribe from topic |
| `mqtt_publish` | `broker_id, topic, payload, retain` | Publish message |
| `mqtt_status` | `broker_id` | Get connection status |
| `mqtt_connected_brokers` | — | List connected brokers |
| `mqtt_all_statuses` | — | Get all broker statuses |

---

## Appendix: ComponentValue Types

```rust
pub enum ComponentValue {
    Bool(bool),
    Number(f64),
    String(String),
    Rgba { r: u8, g: u8, b: u8, a: f64 },
    Array(Vec<ComponentValue>),
}
```

Conversion helpers:
- `as_bool()` — Truthy check (numbers: non-zero, strings: non-empty)
- `as_number()` — Extract f64 (bools convert to 0.0/1.0)
- `as_u8()` — Clamped to 0-255
- `is_truthy()` — Convenience for `as_bool().unwrap_or(false)`

---

## Contact

For questions about this codebase, reach out to the engineering team or consult the broader project documentation in `/docs`.
