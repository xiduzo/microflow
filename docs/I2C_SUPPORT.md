# I2C Device Support for Microflow

> **Date:** April 2026  
> **Status:** Design & Implementation Plan  
> **Scope:** New `I2cDevice` node type for reading/writing I2C peripherals via Firmata

---

## Table of Contents

1. [Overview](#overview)
2. [Why I2C](#why-i2c)
3. [Architecture](#architecture)
4. [Firmata I2C Protocol](#firmata-i2c-protocol)
5. [Rust Backend Component](#rust-backend-component)
6. [Frontend Node Component](#frontend-node-component)
7. [Integration Points](#integration-points)
8. [Device Presets](#device-presets)
9. [Limitations & Constraints](#limitations--constraints)
10. [Implementation Checklist](#implementation-checklist)

---

## Overview

I2C (Inter-Integrated Circuit) is a two-wire serial bus used by hundreds of sensors, displays, and peripherals in the Arduino/maker ecosystem. Adding I2C support to Microflow unlocks devices like:

- **Sensors:** BME280 (temp/humidity/pressure), MPU6050 (accelerometer/gyro), BH1750 (light), VL53L0X (distance)
- **ADCs:** ADS1115 (16-bit analog-to-digital converter)

The implementation adds a single generic `I2cDevice` node that can communicate with any I2C device by address and register, with optional presets for popular devices.

### Design Principles

1. **Generic first** — The node works with any I2C address/register, not just preset devices
2. **Read-centric** — Most I2C use cases in Microflow are sensor reads (polling), with write used for configuration
3. **Sysex-based** — Uses the existing `BoardCommand::Sysex` path, not new BoardCommand variants, keeping the board handle interface unchanged
4. **Callback-driven reads** — I2C replies arrive asynchronously via `firmata_rs::Board::i2c_data()` after `read_and_decode()`, requiring a new routing mechanism in the reader thread

---

## Why I2C

The existing Microflow node set covers:

| Protocol | Nodes | Examples |
|----------|-------|---------|
| Digital I/O | Button, Led, Switch, Relay, Motion | On/off signals |
| Analog I/O | Sensor, Proximity, Potentiometer | 0–1023 range values |
| PWM | Led, Rgb, Servo | 0–255 duty cycle |
| Shift Register | Matrix | SPI-like bit-banging |
| Custom Sysex | Pixel | WS2812 NeoPixel protocol |

I2C fills the gap for **multi-byte, register-addressed peripherals** that can't be read with simple analog/digital pins. A single I2C bus (2 wires: SDA + SCL) can address up to 127 devices simultaneously.

---

## Architecture

### Data Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│ Frontend (React)                                                     │
│                                                                      │
│  ┌─────────────┐    useNodeValue()     ┌──────────────────────────┐  │
│  │ I2cDevice   │◄─────────────────────│ node-data store          │  │
│  │ Node (.tsx) │                       │ (Zustand)                │  │
│  │             │    useNodeControls()  └──────────────────────────┘  │
│  │ Settings:   │──────────────────────►  Yjs sync → flow_update     │
│  │  address    │                                                     │
│  │  register   │                                                     │
│  │  readLength │                                                     │
│  │  freq       │                                                     │
│  └─────────────┘                                                     │
└──────────────────────────────────────────────────────────────────────┘
         │ flow_update                          ▲ component-event
         ▼                                      │
┌──────────────────────────────────────────────────────────────────────┐
│ Rust Backend (Tauri)                                                 │
│                                                                      │
│  ┌──────────────────┐                                                │
│  │ ComponentRegistry │─── creates ──► I2cDevice component            │
│  └──────────────────┘                                                │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ I2cDevice (Rust component)                                    │    │
│  │                                                               │    │
│  │  initialize():                                                │    │
│  │    1. BoardCommand::Sysex { I2C_CONFIG }                      │    │
│  │    2. If register write needed: BoardCommand::Sysex { I2C_REQ │    │
│  │    3. Start polling: BoardCommand::Sysex { I2C_REQUEST read } │    │
│  │                                                               │    │
│  │  call_method("i2c_reply", data):                              │    │
│  │    1. Parse reply bytes                                       │    │
│  │    2. Apply conversion (raw → meaningful value)               │    │
│  │    3. base.set_value() + base.emit("value")                   │    │
│  │                                                               │    │
│  │  call_method("write", value):                                 │    │
│  │    1. Encode value to bytes                                   │    │
│  │    2. BoardCommand::Sysex { I2C_REQUEST write }               │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Reader Thread (in BoardHandle.connect)                        │    │
│  │                                                               │    │
│  │  loop {                                                       │    │
│  │    board.read_and_decode() → Message::I2CReply                │    │
│  │    drain board.i2c_data() → route to I2cDevice via event_tx   │    │
│  │  }                                                            │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

### Key Insight: I2C Reply Routing

Unlike pin-based components (Sensor, Button) that use `PinChangeCallback`, I2C replies arrive as sysex messages parsed by `firmata_rs::Board::read_and_decode()` into `board.i2c_data: Vec<I2CReply>`. The reader thread must:

1. After each `read_and_decode()`, check `board.i2c_data` for new replies
2. Drain the replies and route them to the correct `I2cDevice` component via the event channel
3. Match replies to components by I2C address (since each component has a unique address)

This requires a new **I2C listener map** (similar to `pin_listeners`) that maps `address → component_id`.

---

## Firmata I2C Protocol

The Firmata protocol defines three I2C sysex messages. The `firmata-rs` crate (v0.4.3) implements all three:

### I2C_CONFIG (0x78)

Configures the I2C bus delay. Must be sent once before any I2C operations.

```
firmata_rs API:  board.i2c_config(delay_microseconds)
Wire format:     [0xF0, 0x78, delay_lsb, delay_msb, 0xF7]
```

### I2C_REQUEST (0x76)

Reads or writes data to an I2C device.

```
firmata_rs API:  board.i2c_read(address, num_bytes)
                 board.i2c_write(address, &data)

Read wire format:
  [0xF0, 0x76, address, mode_read<<3, size_lsb, size_msb, 0xF7]

Write wire format:
  [0xF0, 0x76, address, mode_write<<3, data0_lsb, data0_msb, ..., 0xF7]
```

Mode bits (bits 3-4 of the mode byte):
- `0b00` = Write
- `0b01` = Read once
- `0b10` = Read continuously
- `0b11` = Stop reading

### I2C_REPLY (0x77)

Response from the board after an I2C read request. Parsed automatically by `board.read_and_decode()`.

```
firmata_rs struct:
  I2CReply {
    address: i32,    // 7-bit I2C address
    register: i32,   // Register that was read
    data: Vec<u8>,   // Raw bytes received
  }

Wire format:
  [0xF0, 0x77, addr_lsb, addr_msb, reg_lsb, reg_msb, data0_lsb, data0_msb, ..., 0xF7]
```

### Using firmata-rs Directly vs Raw Sysex

The `firmata-rs` crate provides `i2c_config()`, `i2c_read()`, and `i2c_write()` methods on the `Board` struct. However, the current Microflow architecture sends all commands through `BoardCommand` variants processed on the reader thread. Two approaches:

**Option A: New BoardCommand variants (cleaner)**
```rust
BoardCommand::I2cConfig { delay: i32 }
BoardCommand::I2cRead { address: i32, size: i32 }
BoardCommand::I2cWrite { address: i32, data: Vec<u8> }
```

**Option B: Use existing Sysex variant (no board handle changes)**
```rust
// Already exists:
BoardCommand::Sysex { command: u8, data: Vec<u8> }
```

We go with **Option A** because:
- It's type-safe (can't accidentally send malformed I2C sysex)
- It uses the `firmata_rs` API directly, which handles 7-bit encoding correctly
- It's consistent with how other protocols would be added in the future
- The reader thread can call `board.i2c_read()` / `board.i2c_write()` directly

---

## Rust Backend Component

### New Files

```
apps/web/src-tauri/src/runtime/
├── input/
│   ├── mod.rs              # Add: mod i2c_device; pub use ...
│   └── i2c_device.rs       # NEW: I2cDevice component
```

### I2cDevice Component Design

```rust
// runtime/input/i2c_device.rs

/// Configuration from the frontend node data
struct I2cDeviceConfig {
    address: u8,          // 7-bit I2C address (0x00–0x7F)
    register: u8,         // Register to read from (0x00–0xFF)
    read_length: u8,      // Number of bytes to read (1–32)
    freq: u32,            // Polling frequency in ms (default: 100)
    device: String,       // Device preset name or "custom"
    output: OutputFormat,  // How to interpret raw bytes
}

enum OutputFormat {
    Raw,          // Output raw byte array as ComponentValue::Array
    UnsignedInt,  // Combine bytes into unsigned integer (big-endian)
    SignedInt,    // Combine bytes into signed integer (big-endian, two's complement)
    Float,        // For devices that return IEEE 754 floats
}

struct I2cDevice {
    base: ComponentBase,
    config: I2cDeviceConfig,
    board: Option<Arc<BoardHandle>>,
}
```

### Component Lifecycle

1. **`initialize(board)`**
   - Send `BoardCommand::I2cConfig { delay: 0 }` (configure bus)
   - Store board handle
   - The reader thread will handle polling via `BoardCommand::I2cRead`

2. **`call_method("i2c_reply", value)`**
   - Called by the reader thread when an I2C reply arrives for this address
   - Parse raw bytes according to `output` format
   - `base.set_value()` with the converted value
   - `base.emit("value")` to propagate through edges

3. **`call_method("write", value)`**
   - Called when a value arrives on the "write" input handle
   - Convert `ComponentValue` to bytes
   - Send `BoardCommand::I2cWrite { address, data }`

4. **`call_method("trigger", _)`**
   - Called when a command arrives on the "trigger" input handle
   - Send a one-shot `BoardCommand::I2cRead { address, size }`

5. **`destroy()`**
   - Send `BoardCommand::I2cStopReading { address }` to stop continuous reads
   - Release board handle

### Reader Thread Changes

The reader thread in `BoardHandle::connect()` needs to drain I2C replies after each `read_and_decode()`:

```rust
// In the reader thread loop, after conn.detect_and_emit_changes():
// Drain I2C replies
let i2c_replies: Vec<I2CReply> = conn.board.i2c_data.drain(..).collect();
for reply in i2c_replies {
    // Route to the correct component via i2c_listeners
    if let Some(listeners) = i2c_listeners.lock().ok().and_then(|l| l.get(&(reply.address as u8)).cloned()) {
        for component_id in &listeners {
            let data_values: Vec<ComponentValue> = reply.data.iter()
                .map(|&b| ComponentValue::Number(f64::from(b)))
                .collect();
            let _ = event_tx_clone.send(ComponentEvent {
                source: Arc::clone(component_id),
                source_handle: Arc::from("_i2c_reply"),
                value: ComponentValue::Array(data_values),
                edge_id: None,
                sequence,
            });
        }
    }
}
```

### New BoardCommand Variants

```rust
// Added to BoardCommand enum in base.rs:
I2cConfig { delay: i32 },
I2cRead { address: i32, size: i32 },
I2cWrite { address: i32, data: Vec<u8> },
I2cStopReading { address: i32 },
```

Handled in the reader thread:
```rust
Ok(BoardCommand::I2cConfig { delay }) => {
    let _ = conn.board.i2c_config(delay);
}
Ok(BoardCommand::I2cRead { address, size }) => {
    let _ = conn.board.i2c_read(address, size);
}
Ok(BoardCommand::I2cWrite { address, data }) => {
    let _ = conn.board.i2c_write(address, &data);
}
Ok(BoardCommand::I2cStopReading { address }) => {
    // Send I2C stop reading mode (mode bits = 0b11)
    let mode_byte = 0b11 << 3; // stop reading
    let _ = conn.board.connection.write_all(&[
        0xF0, 0x76, address as u8, mode_byte, 0xF7
    ]);
    let _ = conn.board.connection.flush();
}
```

### I2C Listener Map

Similar to `pin_listeners`, a new `i2c_listeners` map routes I2C replies to components:

```rust
// In FlowRuntime:
i2c_listeners: Arc<Mutex<HashMap<u8, Vec<Arc<str>>>>>,
// Maps I2C address → list of component IDs listening on that address
```

### Polling Strategy

I2C reads are request/response — the host must explicitly ask for data. Two approaches:

**Continuous read mode (chosen):** Firmata supports `I2C_MODE_READ_CONTINUOUSLY` (mode bits `0b10`). After one `i2c_read()` call, the board automatically sends replies at the Firmata sampling interval (~19ms). This is efficient and requires no polling timer on the Rust side.

The component sends a single `I2cRead` during `initialize()`, and the reader thread continuously receives `I2CReply` messages. On `destroy()`, it sends `I2cStopReading` to stop the continuous reads.

For one-shot reads (triggered by the "trigger" handle), the component sends a standard `I2cRead` which uses read-once mode.

---

## Frontend Node Component

### New Files

```
apps/web/src/components/flow/nodes/i2c-device/
├── i2c-device.schema.ts    # Zod schema
├── i2c-device.tsx           # React component
└── i2c-device.constants.ts  # Device presets and I2C addresses
```

### Schema

```typescript
// i2c-device.schema.ts
import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.union([z.number(), z.array(z.number())]);
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("I2cDevice").default("I2cDevice"),
  address: z.number().min(0).max(127).default(0x48),
  register: z.number().min(0).max(255).default(0x00),
  readLength: z.number().min(1).max(32).default(2),
  freq: z.number().min(10).default(100),
  device: z.string().default("custom"),
  output: z.enum(["raw", "unsigned_int", "signed_int"]).default("unsigned_int"),
});

export type Data = z.infer<typeof dataSchema>;
```

### React Component

```tsx
// i2c-device.tsx
export function I2cDevice(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="write" handleType="value" hint="write bytes" offset={-0.5} />
      <Handle type="target" position="left" id="trigger" handleType="command" hint="one-shot read" offset={0.5} />
      <Handle type="source" position="right" id="value" handleType="value" />
    </NodeContainer>
  );
}
```

### Settings Panel

The settings panel uses `useNodeControls` (Leva) with:
- **device** — Dropdown of presets ("Custom", "BME280", "MPU6050", etc.)
- **address** — Hex input (0x00–0x7F), auto-filled by preset
- **register** — Hex input (0x00–0xFF), auto-filled by preset
- **readLength** — Number of bytes to read (1–32)
- **output** — How to interpret bytes ("Raw Array", "Unsigned Int", "Signed Int")

When a preset is selected, address/register/readLength/output are auto-populated but remain editable.

---

## Integration Points

### Files to Modify

| File | Change |
|------|--------|
| `apps/web/src/components/flow/nodes/_base/_base.types.ts` | Add `"I2cDevice"` to `COMPONENT_TYPES` array |
| `apps/web/src/components/flow/nodes/_TYPES.ts` | Import and add `I2cDevice` to `NODE_TYPES` |
| `apps/web/src-tauri/src/runtime/base.rs` | Add `I2cConfig`, `I2cRead`, `I2cWrite`, `I2cStopReading` to `BoardCommand` enum; add `I2C` to `pin_mode` module; handle new commands in reader thread |
| `apps/web/src-tauri/src/runtime/input/mod.rs` | Add `mod i2c_device; pub use i2c_device::{I2cDevice, I2cDeviceConfig};` |
| `apps/web/src-tauri/src/runtime/registry.rs` | Register `"I2cDevice"` as hardware component |
| `apps/web/src-tauri/src/runtime/mod.rs` | Add `i2c_listeners` map, `register_i2c_listener()`, install I2C reply callback, handle `"I2cDevice"` in `register_component_pin_listener()` |

### Files to Create

| File | Purpose |
|------|---------|
| `apps/web/src/components/flow/nodes/i2c-device/i2c-device.schema.ts` | Zod schema for node data |
| `apps/web/src/components/flow/nodes/i2c-device/i2c-device.tsx` | React component |
| `apps/web/src/components/flow/nodes/i2c-device/i2c-device.constants.ts` | Device presets |
| `apps/web/src-tauri/src/runtime/input/i2c_device.rs` | Rust component |

---

## Device Presets

Presets auto-fill the address, register, read length, and output format for popular I2C devices. The user can always override these values.

The **Startup init** column is what the runtime writes once, before the first read, so the sensor actually produces live data (see [Startup sequences](#startup-sequences) below). Presets marked with a plain init are fully handled; **VL53L0X** is the one exception that needs an external driver.

| Device | Address | Register | Read Length | Output | Startup init | Description |
|--------|---------|----------|-------------|--------|--------------|-------------|
| Custom | 0x48 | 0x00 | 2 | unsigned_int | none | Manual configuration |
| ADS1115 | 0x48 | 0x00 | 2 | signed_int | config → continuous (AIN0, ±4.096V) | 16-bit ADC |
| BH1750 | 0x23 | 0x10 | 2 | unsigned_int | power-on | Light sensor (lux) |
| BME280 (temp) | 0x76 | 0xFA | 3 | unsigned_int | wake → normal mode | Temperature (raw ADC) |
| BME280 (humidity) | 0x76 | 0xFD | 2 | unsigned_int | wake → normal mode | Humidity (raw ADC) |
| BMP280 (temp) | 0x76 | 0xFA | 3 | unsigned_int | wake → normal mode | Temperature (raw ADC) |
| BMP280 (pressure) | 0x76 | 0xF7 | 3 | unsigned_int | wake → normal mode | Pressure (raw ADC) |
| SHT21/HTU21 (temp) | 0x40 | 0xF3 | 2 | unsigned_int | 11-bit res + read-delay | Temperature (raw 16-bit) |
| SHT21/HTU21 (humidity) | 0x40 | 0xF5 | 2 | unsigned_int | 11-bit res + read-delay | Humidity (raw 16-bit) |
| MPU6050 | 0x68 | 0x3B | 6 | raw | wake from sleep | Accelerometer/Gyro XYZ |
| TCS34725 | 0x29 | 0xB4 | 8 | raw | enable ADC | RGB colour (raw C,R,G,B) |
| VL53L0X | 0x29 | 0x14 | 2 | unsigned_int | ⚠️ needs external init | Distance (mm) |

### Startup sequences

Many I2C sensors power up in a dormant state — asleep, in single-shot mode, or at a reset value — and return a constant (usually `0`) until they are configured. The runtime writes a small, per-device **startup sequence** once in `initialize()` before arming the continuous read, so the very first reply already carries live data. These live in one place — `crates/microflow-core/src/config/i2c_device.rs::device_init_writes` — and are shared by both the live runtime and the Arduino codegen so an exported sketch behaves identically.

| Device | What the startup write does |
|--------|-----------------------------|
| MPU6050 | Clears the `SLEEP` bit (`PWR_MGMT_1` 0x6B = 0x00); asleep it reads 0 on every axis. |
| BME280 / BMP280 | Leaves SLEEP → NORMAL mode. BME280 also sets humidity oversampling (`ctrl_hum`); BMP280 has no humidity register, so that write is omitted. |
| ADS1115 | Writes the config register to **continuous** mode (default is single-shot, which never refreshes the conversion register). Defaults to single-ended AIN0 at ±4.096V — other channels/ranges need a `Custom` node. |
| BH1750 | Sends `Power On` (0x01) so it is awake before the continuous-measurement command. |
| SHT21 / HTU21 | Drops to 11-bit resolution and adds a read-delay so the no-hold measurement lands after conversion (also remaps a stale hold-master register to the no-hold one, which would otherwise hang the AVR bus). |
| TCS34725 | Sets `PON \| AEN` to power the colour ADC; without it every colour channel reads 0. |
| **VL53L0X** | **Not handled.** Ranging needs ST's full stateful init (tuning blob + reference-SPAD/temperature calibration + start-measurement), which can't be expressed as a static list of register writes. The preset reads the range register, but the sensor must be brought up by an external/dedicated driver. |

> **Raw ADC note (BME280 / BMP280):** the preset reads the raw, *uncompensated* ADC registers. Converting them to real °C / %RH / hPa needs the per-chip factory calibration and Bosch's compensation formulas, applied downstream — the startup sequence only makes the registers responsive, not calibrated.

---

## Limitations & Constraints

### Firmata Protocol Limitations

1. **No register-addressed reads in standard Firmata** — The standard Firmata I2C implementation sends a read request without specifying a register. To read a specific register, you must first write the register address, then read. This is a two-step operation:
   ```
   i2c_write(address, &[register])  // Set register pointer
   i2c_read(address, num_bytes)     // Read from current pointer
   ```

2. **7-bit data encoding** — All sysex data is 7-bit encoded. The `firmata-rs` crate handles this transparently for `i2c_read`/`i2c_write`, but raw sysex would need manual encoding.

3. **Bus speed** — StandardFirmata uses the default Wire library speed (100kHz). Some devices need 400kHz. This can't be changed via Firmata protocol without custom firmware.

4. **Single bus** — Arduino Uno/Nano have one I2C bus (A4=SDA, A5=SCL). Mega has an additional bus but Firmata only exposes one.

### Microflow-Specific Constraints

5. **Reader thread ownership** — The `BoardConnection` is exclusively owned by the reader thread. I2C reads/writes must go through `BoardCommand` channel, and replies come back through the event channel. There's no synchronous request/response path.

6. **Address collision** — Multiple `I2cDevice` nodes with the same address will both receive all replies for that address. This is by design (some devices have multiple registers worth reading), but the user should be aware.

7. **No I2C bus scanning** — Firmata doesn't support I2C bus scanning. The user must know the device address. Presets help with this.

8. **Initialization order** — Some I2C devices require a specific startup sequence (write config registers before reading). This is handled by the per-device `device_init_writes` table (see [Startup sequences](#startup-sequences)): the runtime replays it once in `initialize()` before arming the read, and the same table drives the Arduino codegen. The model is a flat list of `[register, value…]` writes with **no inter-write delay**, so a device whose bring-up needs timed, stateful, or read-modify-write steps — notably the **VL53L0X**, which wants ST's tuning-blob + calibration sequence — cannot be expressed here and needs a dedicated driver instead.

---

## Implementation Checklist

### Phase 1: Backend (Rust)

- [ ] Add `I2cConfig`, `I2cRead`, `I2cWrite`, `I2cStopReading` to `BoardCommand` enum
- [ ] Add `I2C` constant to `pin_mode` module
- [ ] Handle new `BoardCommand` variants in reader thread
- [ ] Add I2C reply draining in reader thread (after `read_and_decode()`)
- [ ] Add `i2c_listeners` map to `FlowRuntime`
- [ ] Add `register_i2c_listener()` and `clear_i2c_listeners()` methods
- [ ] Install I2C reply callback alongside pin change callback
- [ ] Handle `"I2cDevice"` in `register_component_pin_listener()`
- [ ] Create `runtime/input/i2c_device.rs` with `I2cDevice` component
- [ ] Export from `runtime/input/mod.rs`
- [ ] Register in `ComponentRegistry`

### Phase 2: Frontend (React + TypeScript)

- [ ] Add `"I2cDevice"` to `COMPONENT_TYPES` in `_base.types.ts`
- [ ] Create `i2c-device.constants.ts` with device presets
- [ ] Create `i2c-device.schema.ts` with Zod schema
- [ ] Create `i2c-device.tsx` with React component
- [ ] Import and add to `NODE_TYPES` in `_TYPES.ts`

### Phase 3: Testing

- [ ] Verify I2C config sysex is sent on initialize
- [ ] Verify I2C read requests are sent
- [ ] Verify I2C replies are routed to correct component
- [ ] Verify write handle sends I2C write commands
- [ ] Verify destroy sends stop reading command
- [ ] Test with real I2C device (e.g., BH1750 light sensor)
- [ ] Test multiple I2C devices on same bus
- [ ] Test preset auto-fill behavior
