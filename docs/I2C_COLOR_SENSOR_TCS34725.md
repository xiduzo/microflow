# I2C Color Sensor (TCS34725 / CJMCU-34725) Support for Microflow

> **Date:** April 2026
> **Status:** Design & Implementation Plan
> **Scope:** TCS34725 RGB color sensor support via the existing `I2cDevice` node, with init-write enhancement and new preset
> **Depends on:** [I2C_SUPPORT.md](./I2C_SUPPORT.md)

---

## Table of Contents

1. [Overview](#overview)
2. [TCS34725 Hardware Summary](#tcs34725-hardware-summary)
3. [Current I2C Node Gap Analysis](#current-i2c-node-gap-analysis)
4. [Proposed Changes](#proposed-changes)
5. [TCS34725 Register Map](#tcs34725-register-map)
6. [Initialization Sequence](#initialization-sequence)
7. [Backend Changes](#backend-changes)
8. [Frontend Changes](#frontend-changes)
9. [Wiring](#wiring)
10. [Limitations & Constraints](#limitations--constraints)
11. [Implementation Checklist](#implementation-checklist)

---

## Overview

The CJMCU-34725 is a breakout board for the **AMS TCS34725** RGB color sensor with an integrated IR-blocking filter. It returns Red, Green, Blue, and Clear (ambient) light intensity values over I2C, making it useful for:

- **Color sorting** — detect and classify objects by color
- **Ambient light measurement** — clear channel acts as a lux sensor
- **LED color matching** — calibrate RGB LEDs to a target color
- **Art/education projects** — "what color is this?" interactive demos

The sensor communicates over I2C at address `0x29` and requires a short initialization sequence (power on + enable ADC) before it returns data. This init requirement is the main gap in the current `I2cDevice` node, which only supports simple read-after-register-write patterns.

---

## TCS34725 Hardware Summary

| Property | Value |
|----------|-------|
| Chip | AMS TCS34725 |
| Breakout board | CJMCU-34725 (also Adafruit 1334) |
| I2C address | `0x29` (fixed, not configurable) |
| Supply voltage | 3.3V (board has onboard regulator, accepts 3.3–5V) |
| Channels | Clear, Red, Green, Blue (16-bit each) |
| Integration time | 2.4ms – 614ms (configurable) |
| Gain | 1x, 4x, 16x, 60x (configurable) |
| IR filter | Integrated, on-chip |
| ID register | `0x44` or `0x4D` at register `0x92` |

### Key Difference from Simple I2C Sensors

Most I2C sensors supported by the current presets (BH1750, VL53L0X) either need no initialization or work with a single register write followed by reads. The TCS34725 requires:

1. A **power-on write** to the ENABLE register before any data is available
2. A short **stabilization delay** (~3ms) after power-on
3. An **ADC enable write** to start color conversion
4. Optionally, writes to configure integration time and gain

Only after this sequence does the sensor populate the RGBC data registers.

---

## Current I2C Node Gap Analysis

| Capability | Current I2C Node | TCS34725 Needs | Gap? |
|------------|-----------------|----------------|------|
| Set I2C address | Yes (configurable) | `0x29` | No |
| Write register then read | Yes (write-then-read in `request_read`) | Read RGBC data registers | No |
| Multi-byte read | Yes (configurable `readLength`) | 8 bytes (C+R+G+B × 2) | No |
| Raw byte output | Yes (`output: "raw"`) | 8 bytes, little-endian pairs | No |
| **Init writes on startup** | **No** | **Write ENABLE register before reads** | **Yes** |
| **Command bit (bit 7)** | No special handling | All register addresses need `0x80` OR'd | No (user enters `0x94` directly) |
| **Multi-channel parsed output** | No (raw bytes or single int) | Ideally R, G, B, C as separate values | Partial |

### The Core Gap: Init Writes

The `I2cDevice` Rust component's `initialize()` method currently:
1. Sends `I2cConfig` (bus setup)
2. Immediately starts reading from the configured register

It has no mechanism to send **setup writes** before the first read. For the TCS34725, the sensor's ADC is powered off by default — reads will return zeros until the ENABLE register is written.

---

## Proposed Changes

### Approach: Add `initWrites` to I2cDeviceConfig

Extend the I2C device config with an optional array of `(register, data)` pairs that are sent during `initialize()`, before the first read. This is a generic enhancement that benefits any I2C device requiring startup configuration (not just the TCS34725).

```
initWrites: [
  { register: 0x80, data: [0x01] },   // PON: power on internal oscillator
  { delay: 3 },                         // Wait 3ms for oscillator
  { register: 0x80, data: [0x03] },   // PON + AEN: enable RGBC ADC
  { register: 0x81, data: [0xD5] },   // ATIME: 101ms integration time
  { register: 0x8F, data: [0x01] },   // CONTROL: 4x gain
]
```

This keeps the I2C node generic while allowing presets to bundle device-specific init sequences.

---

## TCS34725 Register Map

All register addresses must have the **command bit** (bit 7) set. The values below already include it.

### Configuration Registers

| Register | Address | Address + CMD | Description |
|----------|---------|---------------|-------------|
| ENABLE | `0x00` | `0x80` | Power on / ADC enable / interrupt control |
| ATIME | `0x01` | `0x81` | Integration time (lower = shorter) |
| WTIME | `0x03` | `0x83` | Wait time between cycles |
| CONTROL | `0x0F` | `0x8F` | Gain control |
| ID | `0x12` | `0x92` | Device ID (`0x44` or `0x4D`) |
| STATUS | `0x13` | `0x93` | Interrupt status / ADC valid flag |

### ENABLE Register Bits (`0x80`)

| Bit | Name | Description |
|-----|------|-------------|
| 0 | PON | Power ON — activates internal oscillator |
| 1 | AEN | RGBC ADC Enable — starts color conversion |
| 3 | WEN | Wait Enable — inserts wait between cycles |
| 4 | AIEN | Interrupt Enable |

Typical enable value: `0x03` (PON + AEN).

### ATIME Register Values (`0x81`)

| Value | Integration Time | Max Count |
|-------|-----------------|-----------|
| `0xFF` | 2.4ms | 1024 |
| `0xF6` | 24ms | 10240 |
| `0xD5` | 101ms | 43008 |
| `0xC0` | 154ms | 65535 |
| `0x00` | 614ms | 65535 |

Default for the preset: `0xD5` (101ms) — good balance of sensitivity and speed.

### Gain Register Values (`0x8F`)

| Value | Gain |
|-------|------|
| `0x00` | 1x |
| `0x01` | 4x |
| `0x02` | 16x |
| `0x03` | 60x |

Default for the preset: `0x01` (4x) — works well for most indoor lighting.

### Data Registers (Read)

| Register | Address + CMD | Description |
|----------|---------------|-------------|
| CDATAL | `0x94` | Clear channel low byte |
| CDATAH | `0x95` | Clear channel high byte |
| RDATAL | `0x96` | Red channel low byte |
| RDATAH | `0x97` | Red channel high byte |
| GDATAL | `0x98` | Green channel low byte |
| GDATAH | `0x99` | Green channel high byte |
| BDATAL | `0x9A` | Blue channel low byte |
| BDATAH | `0x9B` | Blue channel high byte |

Reading 8 bytes starting at `0x94` returns all four channels. Each channel is a **16-bit little-endian** unsigned integer.

---

## Initialization Sequence

The following sequence must be sent via I2C writes before the sensor produces valid data:

```
Step 1: Write 0x01 to register 0x80    → Power ON (start oscillator)
Step 2: Wait ~3ms                       → Oscillator stabilization
Step 3: Write 0x03 to register 0x80    → Power ON + ADC Enable
Step 4: Write 0xD5 to register 0x81    → Integration time = 101ms
Step 5: Write 0x01 to register 0x8F    → Gain = 4x
Step 6: Wait ~101ms                     → First integration cycle completes
Step 7: Read 8 bytes from register 0x94 → CDATAL through BDATAH
```

After step 6, the sensor continuously converts and the data registers can be polled.

---

## Backend Changes

### I2cDeviceConfig Extension

Add an optional `init_writes` field to `I2cDeviceConfig` in `runtime/input/i2c_device.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct I2cInitWrite {
    pub register: u8,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct I2cDeviceConfig {
    // ... existing fields ...

    /// Optional initialization writes sent during `initialize()` before the first read.
    /// Each entry writes `data` to the device at `[register] + data`.
    #[serde(default)]
    pub init_writes: Vec<I2cInitWrite>,

    /// Delay in milliseconds after init writes, before starting reads.
    /// Allows devices like TCS34725 to stabilize after power-on.
    #[serde(default)]
    pub init_delay_ms: u32,
}
```

### Initialize Method Update

```rust
fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
    board.send_command(BoardCommand::I2cConfig { delay: 0 })?;
    self.board = Some(board.clone());
    self.initialized = true;

    // Send init writes if configured (e.g. TCS34725 power-on sequence)
    for write in &self.config.init_writes {
        let mut data = vec![write.register];
        data.extend_from_slice(&write.data);
        board.send_command(BoardCommand::I2cWrite {
            address: i32::from(self.config.address),
            data,
        })?;
    }

    // Note: init_delay_ms is handled by a short sleep or delayed first read.
    // In practice, the Firmata round-trip time (~20ms per cycle) provides
    // sufficient delay for most devices. For the TCS34725's 101ms integration
    // time, the first few reads may return zeros until the ADC completes.

    self.request_read()?;
    Ok(())
}
```

### Output Parsing for RGBC

The TCS34725 returns 8 bytes in little-endian pairs. With `output: "raw"`, the node outputs `[CL, CH, RL, RH, GL, GH, BL, BH]`. This is usable but requires downstream Calculate nodes to combine bytes.

A cleaner option is to add a new output format specifically for little-endian 16-bit channel pairs:

```rust
enum OutputFormat {
    Raw,
    UnsignedInt,
    SignedInt,
    Le16Channels,  // NEW: parse as array of little-endian 16-bit unsigned values
}
```

For the TCS34725 with `Le16Channels`, 8 bytes become `[clear, red, green, blue]` as four numbers — much more useful for downstream flow logic.

---

## Frontend Changes

### New Preset in `i2c-device.constants.ts`

```typescript
// Add to I2cPreset type:
export type I2cPreset = {
  label: string;
  address: number;
  register: number;
  readLength: number;
  output: "raw" | "unsigned_int" | "signed_int" | "le16_channels";
  description: string;
  initWrites?: Array<{ register: number; data: number[] }>;
  initDelayMs?: number;
};

// Add to I2C_PRESETS:
tcs34725: {
  label: "TCS34725 (RGBC)",
  address: 0x29,
  register: 0x94,       // CDATAL with command bit
  readLength: 8,         // C, R, G, B × 2 bytes each
  output: "le16_channels",
  description: "RGB color sensor with IR filter",
  initWrites: [
    { register: 0x80, data: [0x01] },  // PON
    { register: 0x80, data: [0x03] },  // PON + AEN
    { register: 0x81, data: [0xD5] },  // ATIME: 101ms
    { register: 0x8F, data: [0x01] },  // CONTROL: 4x gain
  ],
  initDelayMs: 105,
},
```

### Schema Extension

Add `initWrites` and `initDelayMs` as optional fields in `i2c-device.schema.ts`:

```typescript
export const dataSchema = baseDataSchema.extend({
  // ... existing fields ...
  initWrites: z.array(z.object({
    register: z.number(),
    data: z.array(z.number()),
  })).default([]),
  initDelayMs: z.number().default(0),
});
```

### Output Format Extension

Add `"le16_channels"` to the output enum in both the schema and the output options:

```typescript
output: z.enum(["raw", "unsigned_int", "signed_int", "le16_channels"]).default("unsigned_int"),
```

```typescript
export const I2C_OUTPUT_OPTIONS = {
  raw: "Raw bytes",
  unsigned_int: "Unsigned int",
  signed_int: "Signed int",
  le16_channels: "LE 16-bit channels",
} as const;
```

---

## Wiring

The CJMCU-34725 breakout has the following pins:

| Board Pin | Function | Connect to |
|-----------|----------|------------|
| VIN (or VCC) | Power | 3.3V or 5V on Arduino |
| GND | Ground | GND on Arduino |
| SDA | I2C Data | A4 on Uno/Nano, 20 on Mega |
| SCL | I2C Clock | A5 on Uno/Nano, 21 on Mega |
| LED | White LED control | Leave unconnected, or wire to a digital pin to control the onboard illumination LED |
| INT | Interrupt output | Optional, not used by Microflow |

The onboard white LED is on by default. To disable it, connect the LED pin to GND. To control it from Microflow, connect it to a digital pin and use a separate Led node.

---

## Limitations & Constraints

### TCS34725-Specific

1. **Fixed I2C address** — The TCS34725 has a hardcoded address of `0x29`. You cannot have two TCS34725 sensors on the same I2C bus without a multiplexer (e.g. TCA9548A).

2. **Address conflict with VL53L0X** — The VL53L0X distance sensor also defaults to `0x29`. If both are on the same bus, one must be reconfigured (VL53L0X supports address change, TCS34725 does not).

3. **Integration time vs speed tradeoff** — Shorter integration times (2.4ms) give faster updates but lower sensitivity and more noise. Longer times (614ms) give cleaner readings but slow update rates. The 101ms default is a reasonable middle ground.

4. **First reads may be zero** — After initialization, the sensor needs one full integration cycle before valid data appears. With 101ms integration time, the first ~100ms of reads will return zeros. This is normal.

5. **IR filter is always active** — The onboard IR-blocking filter cannot be disabled. This is generally desirable for color sensing but means the sensor is not suitable for IR detection.

6. **White LED** — The breakout board's onboard white LED illuminates the target by default. For ambient light measurement (not reflective color sensing), the LED should be disabled by grounding the LED pin.

### General I2C Constraints

See [I2C_SUPPORT.md — Limitations & Constraints](./I2C_SUPPORT.md#limitations--constraints) for bus speed, single bus, and other Firmata-level limitations.

---

## Implementation Checklist

### Phase 1: Backend — Init Writes Enhancement

- [ ] Add `I2cInitWrite` struct to `i2c_device.rs`
- [ ] Add `init_writes: Vec<I2cInitWrite>` and `init_delay_ms: u32` to `I2cDeviceConfig`
- [ ] Update `initialize()` to send init writes before first read
- [ ] Add `Le16Channels` variant to `OutputFormat` enum
- [ ] Implement `Le16Channels` conversion in `convert_bytes()`: parse pairs of little-endian bytes into 16-bit unsigned values

### Phase 2: Frontend — Preset & Schema

- [ ] Extend `I2cPreset` type with optional `initWrites` and `initDelayMs`
- [ ] Add `tcs34725` preset to `I2C_PRESETS`
- [ ] Add `"le16_channels"` to output enum in schema and constants
- [ ] Update preset `onChange` handler to also set `initWrites` and `initDelayMs`
- [ ] Add `initWrites` and `initDelayMs` to Zod schema with defaults

### Phase 3: Testing

- [ ] Verify init writes are sent in order during initialize
- [ ] Verify TCS34725 returns non-zero RGBC values after init
- [ ] Verify `le16_channels` output correctly parses `[CL, CH, RL, RH, GL, GH, BL, BH]` into `[C, R, G, B]`
- [ ] Test with real CJMCU-34725 board
- [ ] Verify VL53L0X preset still works (same address, no init writes)
- [ ] Test preset switching (TCS34725 → Custom → TCS34725) preserves/clears init writes correctly
