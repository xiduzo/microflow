# Handle System: Uniform Vocabulary

This document defines a **minimal, learnable** handle vocabulary. Users learn once, transfer everywhere.

---

## 1. The problem

The current system uses too many synonyms:

| Concept              | Current names (confusing)                                                |
| -------------------- | ------------------------------------------------------------------------ |
| "Data out"           | `change`, `output`, `message`, `to`, `bang`                              |
| "Something happened" | `active`, `inactive`, `pressed`, `released`, `motionstart`, `motionend`  |
| "Do something"       | `invoke`, `play`, `buzz`, `publish`, `hide`, `move`, `turnOn`, `turnOff` |
| "Data in"            | `signal`, `input`, `from`, `check`, `debug`, `show`, `color`             |
| "Boolean condition"  | `open`, `close`, `true`, `false`                                         |

Users can't build intuition because every node speaks a different dialect.

---

## 2. Four handle types

Every handle has exactly one type:

| Type        | Glyph | Meaning                        | Direction       |
| ----------- | ----- | ------------------------------ | --------------- |
| **value**   | ●     | Data flows here                | input or output |
| **event**   | ◆     | Something happened (momentary) | usually output  |
| **command** | ▶     | Do this action                 | input only      |
| **state**   | ■     | Current boolean condition      | usually output  |

**Rule:** Shape tells you the type. Type tells you what to expect.

---

## 3. Minimal vocabulary (15 names total)

### Outputs (right side) — 5 names

| Name    | Type  | When to use                                  |
| ------- | ----- | -------------------------------------------- |
| `value` | value | Data output (analog, count, result, message) |
| `event` | event | Something happened (tick, press, threshold)  |
| `true`  | state | Boolean condition is true                    |
| `false` | state | Boolean condition is false                   |
| `hold`  | event | Special: button held gesture                 |

**That's it.** No more `change`, `output`, `bang`, `message`, `active`, `inactive`, `motionstart`, `motionend`, `open`, `close`, `pressed`, `released`.

### Inputs (left side) — 10 names

| Name      | Type    | When to use                   |
| --------- | ------- | ----------------------------- |
| `value`   | value   | Data input (single data feed) |
| `trigger` | command | Do the main action            |
| `set`     | command | Set a value                   |
| `reset`   | command | Reset to initial state        |
| `start`   | command | Start continuous behavior     |
| `stop`    | command | Stop continuous behavior      |
| `true`    | command | Turn on / set true            |
| `false`   | command | Turn off / set false          |
| `toggle`  | command | Toggle boolean state          |
| `+` / `-` | command | Increment / decrement         |

**That's it.** No more `invoke`, `play`, `buzz`, `publish`, `signal`, `input`, `check`, `debug`, `turnOn`, `turnOff`, `open`, `close`, `increment`, `decrement`.

---

## 4. Named slots (when a node has multiple values)

Some nodes need **multiple value inputs** (e.g., RGB color, servo bounds). Use **semantic slot names** with a colon prefix to show they're named values:

| Pattern           | Example handles                 | Type  |
| ----------------- | ------------------------------- | ----- |
| Color channels    | `red`, `green`, `blue`, `alpha` | value |
| Position bounds   | `min`, `max`                    | value |
| LLM template vars | `{{name}}`, `{{context}}`       | value |

These are still **value type** — the name just identifies the slot.

**Rule:** If there's only one value input, call it `value`. If there are multiple, give them semantic names.

---

## 5. Node patterns (what users learn)

Once users know these patterns, they can predict any node:

### Sensors (Button, Switch, Motion, Sensor, Proximity, etc.)

| Output           | Type  | Meaning                        |
| ---------------- | ----- | ------------------------------ |
| `value`          | value | Analog reading (if applicable) |
| `event`          | event | State changed                  |
| `true` / `false` | state | Current boolean state          |
| `hold`           | event | Gesture (button only)          |

**Before:** Button had `active`, `change`, `inactive`, `hold`  
**After:** Button has `event`, `true`, `false`, `hold`

### Generators (Constant, Interval, Oscillator, Counter)

| Input     | Type              | Output  | Type                        |
| --------- | ----------------- | ------- | --------------------------- |
| `start`   | command           | `value` | value                       |
| `stop`    | command           | `event` | event (optional, for ticks) |
| `reset`   | command           |         |                             |
| `+` / `-` | command (counter) |         |                             |
| `set`     | command (counter) |         |                             |

**Before:** Interval had `change` output  
**After:** Interval has `event` output (it ticks, it doesn't have continuous value)

**Before:** Oscillator had `change` output  
**After:** Oscillator has `value` output (it produces continuous waveform data)

### Shape nodes (Calculate, RangeMap, Smooth, Trigger)

| Input   | Type  | Output  | Type  |
| ------- | ----- | ------- | ----- |
| `value` | value | `value` | value |

Pure data pipes. That's it.

**Before:** RangeMap had `from` → `to`  
**After:** RangeMap has `value` → `value`

**Before:** Trigger had `signal` → `bang`  
**After:** Trigger has `value` → `event`

### Decide nodes (Compare, Gate)

| Input   | Type  | Output  | Type  |
| ------- | ----- | ------- | ----- |
| `value` | value | `true`  | state |
|         |       | `false` | state |

**Before:** Compare had `check` input, `true`/`change`/`false` outputs  
**After:** Compare has `value` input, `true`/`false` outputs (drop `change` — derive downstream if needed)

### Express nodes (Led, Relay, Servo, Rgb, Pixel, Matrix, Piezo, Llm, Mqtt)

| Input                       | Type    | Output  | Type             |
| --------------------------- | ------- | ------- | ---------------- |
| `true` / `false` / `toggle` | command | `event` | event (optional) |
| `trigger`                   | command |         |                  |
| `value` or named slots      | value   |         |                  |
| `stop`                      | command |         |                  |

**Before:** Led had `turnOn`, `toggle`, `turnOff`, `change`  
**After:** Led has `true`, `toggle`, `false`, `event`

**Before:** Piezo had `buzz` or `play`, `stop`  
**After:** Piezo has `trigger`, `stop`

**Before:** Llm had `invoke`, `output`  
**After:** Llm has `trigger`, `value`

### Monitor

| Input   | Type  | Output | Type |
| ------- | ----- | ------ | ---- |
| `value` | value | —      | —    |

**Before:** Monitor had `debug`  
**After:** Monitor has `value`

---

## 6. Visual system

| Type    | Shape      | Color (suggested) |
| ------- | ---------- | ----------------- |
| value   | ● Circle   | Blue              |
| event   | ◇ Diamond  | Yellow/Orange     |
| command | ▷ Triangle | Green             |
| state   | ■ Square   | Purple            |

Users learn: **"Circles carry data, diamonds trigger, triangles are actions, squares are conditions."**

---

## 7. Migration: old → new

### Output handles

| Old name      | New name | Type  | Nodes affected                                                  |
| ------------- | -------- | ----- | --------------------------------------------------------------- |
| `change`      | `value`  | value | Calculate, Counter, Oscillator, Sensor, Smooth, Proximity, etc. |
| `change`      | `event`  | event | Button, Interval, Led, Matrix, Pixel, Rgb, Servo, Switch        |
| `output`      | `value`  | value | Constant, Llm                                                   |
| `bang`        | `event`  | event | Delay, Trigger                                                  |
| `message`     | `value`  | value | Mqtt                                                            |
| `to`          | `value`  | value | RangeMap                                                        |
| `active`      | `event`  | event | Button                                                          |
| `inactive`    | `event`  | event | Button                                                          |
| `pressed`     | `event`  | event | Hotkey                                                          |
| `released`    | `event`  | event | Hotkey                                                          |
| `motionstart` | `event`  | event | Motion                                                          |
| `motionend`   | `event`  | event | Motion                                                          |
| `open`        | `true`   | state | Switch                                                          |
| `close`       | `false`  | state | Switch                                                          |

### Input handles

| Old name    | New name  | Type    | Nodes affected                |
| ----------- | --------- | ------- | ----------------------------- |
| `signal`    | `value`   | value   | Delay, Smooth, Trigger        |
| `input`     | `value`   | value   | Calculate                     |
| `from`      | `value`   | value   | RangeMap                      |
| `check`     | `value`   | value   | Compare, Gate                 |
| `debug`     | `value`   | value   | Monitor                       |
| `show`      | `value`   | value   | Matrix, Pixel                 |
| `color`     | `value`   | value   | Pixel (or keep as named slot) |
| `invoke`    | `trigger` | command | Llm                           |
| `play`      | `trigger` | command | AudioPlayer, Piezo            |
| `buzz`      | `trigger` | command | Piezo                         |
| `publish`   | `trigger` | command | Mqtt                          |
| `hide`      | `trigger` | command | Matrix                        |
| `move`      | `trigger` | command | Pixel                         |
| `turnOn`    | `true`    | command | Led                           |
| `turnOff`   | `false`   | command | Led, Pixel                    |
| `open`      | `true`    | command | Relay                         |
| `close`     | `false`   | command | Relay                         |
| `increment` | `+`       | command | Counter                       |
| `decrement` | `-`       | command | Counter                       |

### Handles to keep as-is

| Name                            | Type          | Reason                                     |
| ------------------------------- | ------------- | ------------------------------------------ |
| `true` / `false`                | state/command | Already canonical                          |
| `toggle`                        | command       | Already canonical                          |
| `start` / `stop`                | command       | Already canonical                          |
| `set` / `reset`                 | command       | Already canonical                          |
| `hold`                          | event         | Unique gesture, no synonym                 |
| `red`, `green`, `blue`, `alpha` | value         | Named slots for RGB                        |
| `min`, `max`                    | value         | Named slots for Servo bounds               |
| `rotate`                        | value         | Servo continuous mode (consider → `value`) |
| `to`                            | value         | Servo position (consider → `value`)        |

---

## 8. Resulting node specs

### AudioPlayer

- **Inputs:** `trigger` (command), `stop` (command)
- **Outputs:** —

### Button

- **Inputs:** —
- **Outputs:** `event` (event), `true` (state), `false` (state), `hold` (event)

### Calculate

- **Inputs:** `value` (value)
- **Outputs:** `value` (value)

### Compare

- **Inputs:** `value` (value)
- **Outputs:** `true` (state), `false` (state)

### Constant

- **Inputs:** —
- **Outputs:** `value` (value)

### Counter

- **Inputs:** `+` (command), `-` (command), `set` (command), `reset` (command)
- **Outputs:** `value` (value)

### Delay

- **Inputs:** `trigger` (command)
- **Outputs:** `event` (event)

### Gate

- **Inputs:** `value` (value)
- **Outputs:** `true` (state), `false` (state)

### Hotkey

- **Inputs:** —
- **Outputs:** `event` (event) × 2 (pressed, released — or merge into one?)

### Interval

- **Inputs:** `start` (command), `stop` (command)
- **Outputs:** `event` (event)

### Led

- **Inputs:** `true` (command), `toggle` (command), `false` (command)
- **Outputs:** `event` (event)

### Llm

- **Inputs:** `trigger` (command), named slots from `{{var}}` (value)
- **Outputs:** `value` (value)

### Matrix

- **Inputs:** `value` (value, shape #), `trigger` (command, hide)
- **Outputs:** `event` (event)

### Monitor

- **Inputs:** `value` (value)
- **Outputs:** —

### Motion

- **Inputs:** —
- **Outputs:** `event` (event, start), `event` (event, end), `true`/`false` (state)

### Mqtt

- **Inputs:** `trigger` (command, publish mode)
- **Outputs:** `value` (value, subscribe mode)

### Oscillator

- **Inputs:** `start` (command), `stop` (command), `reset` (command)
- **Outputs:** `value` (value)

### Piezo

- **Inputs:** `trigger` (command), `stop` (command)
- **Outputs:** —

### Pixel

- **Inputs:** `value` (value, preset #), `value` (value, color array), `trigger` (command, move), `false` (command, off)
- **Outputs:** `event` (event)

### Proximity / Sensor / Force / HallEffect / Ldr / Potentiometer / Tilt

- **Inputs:** —
- **Outputs:** `value` (value)

### RangeMap

- **Inputs:** `value` (value)
- **Outputs:** `value` (value)

### Relay

- **Inputs:** `true` (command), `toggle` (command), `false` (command)
- **Outputs:** —

### Rgb

- **Inputs:** `red` (value), `green` (value), `blue` (value), `alpha` (value)
- **Outputs:** `event` (event)

### Servo (standard)

- **Inputs:** `min` (value), `value` (value), `max` (value)
- **Outputs:** `event` (event)

### Servo (continuous)

- **Inputs:** `value` (value), `stop` (command)
- **Outputs:** `event` (event)

### Smooth

- **Inputs:** `value` (value)
- **Outputs:** `value` (value)

### Switch

- **Inputs:** —
- **Outputs:** `event` (event), `true` (state), `false` (state)

### Trigger

- **Inputs:** `value` (value)
- **Outputs:** `event` (event)

---

## 9. Implementation approach

1. **Create a handle alias map** in code that maps old ids to new canonical names
2. **Existing flows keep working** — the runtime uses the map to resolve handles
3. **UI shows canonical names** — tooltips and labels use the new vocabulary
4. **New connections use canonical ids** — gradually migrate the codebase
5. **Handle component uses shapes** — ● ◆ ▶ ■ based on type

```typescript
// Example alias map
const HANDLE_ALIASES: Record<string, { canonical: string; type: HandleType }> =
  {
    // Outputs
    change: { canonical: "value", type: "value" }, // or "event" depending on node
    output: { canonical: "value", type: "value" },
    bang: { canonical: "event", type: "event" },
    message: { canonical: "value", type: "value" },
    active: { canonical: "event", type: "event" },
    inactive: { canonical: "event", type: "event" },
    open: { canonical: "true", type: "state" },
    close: { canonical: "false", type: "state" },
    // Inputs
    signal: { canonical: "value", type: "value" },
    input: { canonical: "value", type: "value" },
    from: { canonical: "value", type: "value" },
    check: { canonical: "value", type: "value" },
    debug: { canonical: "value", type: "value" },
    invoke: { canonical: "trigger", type: "command" },
    play: { canonical: "trigger", type: "command" },
    buzz: { canonical: "trigger", type: "command" },
    publish: { canonical: "trigger", type: "command" },
    turnOn: { canonical: "true", type: "command" },
    turnOff: { canonical: "false", type: "command" },
    increment: { canonical: "+", type: "command" },
    decrement: { canonical: "-", type: "command" },
  };
```

---

## 10. The result

**Before:** 40+ different handle names across nodes.  
**After:** 15 canonical names that work everywhere.

Users learn:

- **Outputs:** `value`, `event`, `true`, `false`, `hold`
- **Inputs:** `value`, `trigger`, `set`, `reset`, `start`, `stop`, `true`, `false`, `toggle`, `+`, `-`

Plus a few **named slots** for multi-value nodes (RGB channels, servo bounds).

**The editor becomes a language, not a collection of dialects.**
