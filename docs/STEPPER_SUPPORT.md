# Stepper Motor Support for Microflow

> **Date:** April 2026
> **Status:** Design & Implementation Plan
> **Scope:** New `Stepper` node type for controlling stepper motors via Firmata's AccelStepper protocol

---

## Table of Contents

1. [Overview](#overview)
2. [Why Stepper Motors](#why-stepper-motors)
3. [Architecture](#architecture)
4. [Firmata AccelStepper Protocol](#firmata-accelstepper-protocol)
5. [Rust Backend Component](#rust-backend-component)
6. [Frontend Node Component](#frontend-node-component)
7. [Integration Points](#integration-points)
8. [Supported Driver Boards](#supported-driver-boards)
9. [Limitations & Constraints](#limitations--constraints)
10. [Implementation Checklist](#implementation-checklist)

---

## Overview

Stepper motors provide precise, repeatable positioning by dividing a full rotation into discrete steps. Unlike servos (limited to 180° or continuous rotation without position feedback), steppers can rotate any number of degrees in either direction with exact step counting.

Adding stepper support to Microflow unlocks use cases like:

- **CNC/pen plotters** — precise X/Y positioning
- **Camera sliders** — smooth, repeatable motion
- **3D printer extruders** — controlled material feed
- **Turntables and rotary stages** — exact angular positioning
- **Automated blinds/curtains** — position-based control

The implementation uses Firmata's **AccelStepper protocol** (sysex command `0x62`), which wraps the AccelStepper library and supports acceleration, deceleration, and multiple driver types.

### Design Principles

1. **Driver-board focused** — The most common maker setup is a step/direction driver board (A4988, DRV8825, TMC2209). The node defaults to this interface while supporting 2-wire and 4-wire H-bridge configurations.
2. **Sysex-based** — All communication uses `BoardCommand::Sysex` with the AccelStepper command byte (`0x62`), keeping the board handle interface unchanged.
3. **Position-aware** — The node tracks absolute position (in steps) and reports it back to the flow via the output handle.
4. **Move-complete events** — The Firmata board sends a `MOVE_COMPLETE` sysex reply when a move finishes, which the node emits as an event for downstream flow logic.

---

## Why Stepper Motors

The existing Microflow motor support covers only servos:

| Motor Type | Node | Control | Positioning |
|------------|------|---------|-------------|
| Servo (standard) | Servo | PWM angle (0–180°) | Absolute, limited range |
| Servo (continuous) | Servo | PWM speed/direction | No position feedback |
| **Stepper** | **Stepper (new)** | **Step/direction pulses** | **Absolute, unlimited range** |

Steppers fill the gap for **precise, multi-revolution positioning** that servos cannot provide. With a driver board, a stepper motor needs only two digital pins (step + direction) and can be controlled with acceleration curves for smooth motion.

---

## Architecture

### Data Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│ Frontend (React)                                                     │
│                                                                      │
│  ┌─────────────┐    useNodeValue()     ┌──────────────────────────┐  │
│  │ Stepper     │◄─────────────────────│ node-data store          │  │
│  │ Node (.tsx) │                       │ (Zustand)                │  │
│  │             │    useNodeControls()  └──────────────────────────┘  │
│  │ Settings:   │──────────────────────►  Yjs sync → flow_update     │
│  │  stepPin    │                                                     │
│  │  dirPin     │                                                     │
│  │  stepsPerRev│                                                     │
│  │  speed      │                                                     │
│  │  accel      │                                                     │
│  └─────────────┘                                                     │
└──────────────────────────────────────────────────────────────────────┘
         │ flow_update                          ▲ component-event
         ▼                                      │
┌──────────────────────────────────────────────────────────────────────┐
│ Rust Backend (Tauri)                                                 │
│                                                                      │
│  ┌──────────────────┐                                                │
│  │ ComponentRegistry │─── creates ──► Stepper component              │
│  └──────────────────┘                                                │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Stepper (Rust component)                                      │    │
│  │                                                               │    │
│  │  initialize():                                                │    │
│  │    1. Sysex: ACCELSTEPPER config (device, interface, pins)    │    │
│  │    2. Sysex: ACCELSTEPPER set speed                           │    │
│  │    3. Sysex: ACCELSTEPPER set acceleration                    │    │
│  │                                                               │    │
│  │  call_method("value", steps):                                 │    │
│  │    → Sysex: ACCELSTEPPER step (relative move)                 │    │
│  │                                                               │    │
│  │  call_method("to", position):                                 │    │
│  │    → Sysex: ACCELSTEPPER to (absolute move)                   │    │
│  │                                                               │    │
│  │  call_method("stop", _):                                      │    │
│  │    → Sysex: ACCELSTEPPER stop                                 │    │
│  │                                                               │    │
│  │  call_method("zero", _):                                      │    │
│  │    → Sysex: ACCELSTEPPER zero (reset position)                │    │
│  │                                                               │    │
│  │  on MOVE_COMPLETE sysex reply:                                │    │
│  │    → base.set_value(position) + base.emit("position")         │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Reader Thread                                                 │    │
│  │                                                               │    │
│  │  Receives sysex 0x62 replies (move complete, position report) │    │
│  │  Routes to Stepper component via stepper_listeners map        │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```


### Key Insight: Sysex Reply Routing

The AccelStepper protocol sends replies back via sysex (`0x62`) for two events:
- **Move complete** (`0x0A`) — includes the final position as a 32-bit signed long
- **Position report** (`0x06`) — response to a position query, same format

The reader thread must detect sysex messages with command byte `0x62`, extract the device number (byte index 1 of the data), and route to the correct Stepper component. This uses the same pattern as I2C reply routing but keyed on device number (0–9) instead of I2C address.

---

## Firmata AccelStepper Protocol

The AccelStepper protocol uses sysex command byte `0x62`. All messages are prefixed with `START_SYSEX (0xF0)`, the command byte, a sub-command, and terminated with `END_SYSEX (0xF7)`.

### Custom Float Format

Speed and acceleration values use a custom float encoding: 23-bit significand + 4-bit exponent (biased -11) + 1-bit sign, packed into 4 bytes of 7-bit data.

### Key Commands Used

| Sub-command | Byte | Description |
|-------------|------|-------------|
| Config | `0x00` | Configure stepper (pins, interface type) |
| Zero | `0x01` | Reset position counter to zero |
| Step | `0x02` | Relative move (signed 32-bit step count) |
| To | `0x03` | Absolute move (signed 32-bit position) |
| Enable | `0x04` | Enable/disable driver |
| Stop | `0x05` | Stop motor (decelerates if accel is set) |
| Report Position | `0x06` | Request/receive current position |
| Set Acceleration | `0x08` | Set accel/decel in steps/sec² |
| Set Speed | `0x09` | Set max speed in steps/sec |
| Move Complete | `0x0A` | Reply: move finished + final position |

### Interface Byte Encoding

The interface byte (byte 4 of config) encodes the driver type:

| Interface | Upper 3 bits | Value | Description |
|-----------|-------------|-------|-------------|
| Driver (step/dir) | `001` | `0b0010000` = `0x10` | A4988, DRV8825, TMC2209, EasyDriver |
| Two wire | `010` | `0b0100000` = `0x20` | H-bridge, 2 coil wires |
| Four wire | `100` | `0b1000000` = `0x40` | Full H-bridge, 4 coil wires |

Lower bits encode step size (microstepping) and enable pin presence.

---

## Rust Backend Component

### New File

```
apps/web/src-tauri/src/runtime/output/stepper.rs
```

### StepperConfig

```rust
struct StepperConfig {
    step_pin: u8,          // Step pulse pin (driver mode)
    dir_pin: u8,           // Direction pin (driver mode)
    steps_per_rev: u16,    // Steps per full revolution (e.g. 200 for 1.8° motor)
    speed: f32,            // Max speed in steps/sec
    acceleration: f32,     // Acceleration in steps/sec²
    device_num: u8,        // Firmata device number (0–9)
    interface: String,     // "driver", "two_wire", "four_wire"
    enable_pin: Option<u8>,// Optional enable pin
}
```

### Component Lifecycle

1. **`initialize(board)`**
   - Send config sysex: device number, interface type, pins
   - Send set speed sysex
   - Send set acceleration sysex (if non-zero)

2. **`call_method("value", steps)`** — Relative move by N steps
3. **`call_method("to", position)`** — Absolute move to position
4. **`call_method("stop", _)`** — Stop with deceleration
5. **`call_method("zero", _)`** — Reset position to zero
6. **`call_method("enable", state)`** — Enable/disable driver
7. **`call_method("stepper_reply", data)`** — Handle move complete / position report from reader thread

8. **`destroy()`** — Stop motor, disable driver

---

## Frontend Node Component

### New Files

```
apps/web/src/components/flow/nodes/stepper/
├── stepper.schema.ts    # Zod schema
└── stepper.tsx           # React component
```

### Handles

| Side | ID | Type | Description |
|------|----|------|-------------|
| Left (input) | `value` | value | Relative move: number of steps (positive = CW, negative = CCW) |
| Left (input) | `to` | value | Absolute move: target position in steps |
| Left (input) | `stop` | command | Stop the motor |
| Left (input) | `zero` | command | Reset position counter to zero |
| Right (output) | `position` | value | Current position after move completes |
| Right (output) | `complete` | event | Fires when a move finishes |

### Settings

- **Step pin** — digital pin for step pulses
- **Direction pin** — digital pin for direction signal
- **Steps/rev** — steps per revolution (default: 200 for a standard 1.8° motor)
- **Speed** — max speed in steps/sec (default: 200)
- **Acceleration** — steps/sec² (default: 100, 0 = no acceleration)

---

## Integration Points

### Files to Modify

| File | Change |
|------|--------|
| `_base/_base.types.ts` | Add `"Stepper"` to `COMPONENT_TYPES` |
| `_TYPES.ts` | Import and add `Stepper` to `NODE_TYPES` |
| `runtime/output/mod.rs` | Add `mod stepper; pub use stepper::{Stepper, StepperConfig};` |
| `runtime/registry.rs` | Register `"Stepper"` as hardware component |

### Files to Create

| File | Purpose |
|------|---------|
| `nodes/stepper/stepper.schema.ts` | Zod schema for node data |
| `nodes/stepper/stepper.tsx` | React component |
| `runtime/output/stepper.rs` | Rust component |
| `fumadocs/.../express/stepper.mdx` | Documentation page |

---

## Supported Driver Boards

The node supports any step/direction driver board. Common options:

| Driver | Motor Current | Microstepping | Notes |
|--------|--------------|---------------|-------|
| A4988 | Up to 2A | 1/16 | Most common, cheap |
| DRV8825 | Up to 2.5A | 1/32 | Higher current, finer microstepping |
| TMC2209 | Up to 2.8A | 1/256 | Silent (StealthChop), UART config |
| EasyDriver | Up to 750mA | 1/8 | Simple, good for small motors |
| TB6600 | Up to 4A | 1/32 | External box driver, higher power |

All of these use the same step/direction interface — the node works identically with any of them.

---

## Limitations & Constraints

### Firmata Protocol Limitations

1. **Max 10 steppers** — The AccelStepper protocol supports device numbers 0–9. Microflow assigns device numbers automatically starting from 0.
2. **Custom float precision** — Speed and acceleration use a 23-bit significand, limiting precision to ~6-7 significant digits. This is more than sufficient for stepper control.
3. **No continuous rotation mode** — Unlike servos, the AccelStepper protocol only supports move-to-position and move-by-steps. Continuous spinning requires repeated step commands.
4. **Requires ConfigurableFirmata** — StandardFirmata does not include AccelStepper support. The Arduino must be flashed with ConfigurableFirmata + AccelStepperFirmata feature enabled.

### Microflow-Specific Constraints

5. **Device number assignment** — Each Stepper node gets a unique device number (0–9). If more than 10 stepper nodes are added, the extras will fail to initialize.
6. **No microstepping configuration via Firmata** — Microstepping is set physically on the driver board (jumpers/solder bridges). The Firmata protocol has step-size bits in the interface byte, but the AccelStepperFirmata implementation ignores them for driver-type interfaces. Users should configure microstepping on the driver board directly.
7. **Sysex reply routing** — Move complete and position report replies arrive as raw sysex. The reader thread must parse the `0x62` command byte and route by device number.

---

## Implementation Checklist

### Phase 1: Backend (Rust)

- [ ] Create `runtime/output/stepper.rs` with `Stepper` component
- [ ] Implement AccelStepper sysex encoding (config, step, to, speed, accel, stop, zero, enable)
- [ ] Implement custom float encoding for speed/acceleration values
- [ ] Implement 32-bit signed long encoding for step counts/positions
- [ ] Handle `stepper_reply` method for move complete / position report
- [ ] Export from `runtime/output/mod.rs`
- [ ] Register in `ComponentRegistry`

### Phase 2: Frontend (React + TypeScript)

- [ ] Add `"Stepper"` to `COMPONENT_TYPES` in `_base.types.ts`
- [ ] Create `stepper.schema.ts` with Zod schema
- [ ] Create `stepper.tsx` with React component, handles, and settings
- [ ] Import and add to `NODE_TYPES` in `_TYPES.ts`

### Phase 3: Documentation

- [ ] Create `fumadocs/.../express/stepper.mdx` with wiring guide and usage docs
- [ ] Add `"stepper"` to express `meta.json` pages list

### Phase 4: Testing

- [ ] Verify config sysex is sent correctly on initialize
- [ ] Verify step/to commands move the motor
- [ ] Verify speed and acceleration are encoded in custom float format
- [ ] Verify move complete events propagate through the flow
- [ ] Test with real stepper + A4988/DRV8825 driver board
- [ ] Test stop command (with and without acceleration)
- [ ] Test zero command resets position
