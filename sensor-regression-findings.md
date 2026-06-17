# Sensor-data regression on `feat/runtime-wasm` — findings

**Date:** 2026-06-17 · **Branch:** `feat/runtime-wasm` · **HEAD:** `31f7ed5`

> **UPDATE (after hardware logs): see ["Live hardware logs — two real bugs at HEAD"](#live-hardware-logs--two-real-bugs-at-head) at the bottom.**
> The "stale build" theory below is **superseded** — the logs are from a fresh build and reveal two genuine
> runtime bugs that the core unit tests do not cover (a port-granularity digital-reporting reconcile bug, and
> a `pins[N].analog == false` detection bug). The architecture/causal story below is still accurate.

## TL;DR

The WASM work did **not** introduce a new bug into the Rust runtime. It **replaced**
the desktop's runtime: the flow engine was lifted out of `apps/web/src-tauri/src/lib.rs`
(gutted, ~291 lines mostly deleted) into a shared sans-IO crate `crates/microflow-core`,
which the desktop now drives through a new single-threaded **actor** (`src-tauri/src/runtime/host.rs`)
and the browser drives through `crates/microflow-runtime-wasm` (Web Serial).

Both hosts now share **one Firmata codec + one runtime**. Re-implementing sensor handling
in that shared core surfaced **two latent bugs that the old desktop code also had** but never
exercised end-to-end. Both are **already fixed at HEAD**, and an end-to-end test proves the
A0 analog loop works. If hardware still looks dead, the most likely cause is a **stale build**,
not a source bug.

## The data path (what "over the line" means)

Board → serial → `host.rs::pump_port` `port.read()` (host.rs ~L426) → `FlowRuntime::feed_bytes`
(mod.rs:309) → Firmata codec `feed` decodes (firmata/mod.rs) → `detect_pin_changes` (mod.rs ~L463)
diffs `pins[]` vs last values → pushes `_pin_change` to listening components → drain →
`Effects { outbound_bytes, component_events, … }` → actor `apply()` (host.rs:447) writes bytes to
the port **and** `app.emit("component-event", …)` to the webview.

Setup direction: `ActorMsg::FlowUpdate` → `update_flow` (mod.rs:171) reconciles reporting from each
component's `listener_wiring()` → emits `set_pin_mode` + `REPORT_ANALOG` bytes → `apply()` writes them.
On `Connect` the actor rebuilds a fresh runtime, `seed_pins`, **then re-applies `last_flow`** so a board
plugged in after the flow loads still gets its reporting enabled.

## Root causes (both pre-existing, exposed by the shared codec)

### 1. Analog pin vs. analog channel — `a4ef958`
`SensorConfig::analog_pin()` (input/sensor.rs) stripped the `"A"` and returned the bare **channel**
(`"A0"` → 0). But the codec decodes analog as `pin = channel + 14`, and pin-mode / `REPORT_ANALOG` /
change-detection all key off the **Firmata pin number**. Net effect for the default `"A0"` sensor:
- pin-mode set on pin 0 (RX),
- `REPORT_ANALOG` rejected (pin 0 isn't analog),
- value decoded into `pins[14]` while detection scanned `pins[0]`.

A fully dead analog path — every pot/LDR on the default `"A0"` was dead, **desktop and web alike**.
Fix: `"A{n}" → 14 + n` (`ANALOG_PIN_BASE = 14`).

### 2. Digital decode dropped `INPUT_PULLUP` — `9edafb3`
The digital-message decoder (firmata/mod.rs ~L331) only updated a pin whose mode was exactly
`MODE_INPUT (0)`, ignoring `MODE_PULLUP (11)`. A normal pull-up button therefore never updated →
the Button/Switch node looked dead/unstable on **both** builds. Fix: accept `MODE_INPUT | MODE_PULLUP`
(still excludes OUTPUT/PWM so a write echo can't clobber cached state).

Plus two button-debounce fixes: `6580530`, `31f7ed5`.

## Why HEAD is sound (verified by reading, not assumed)

- `update_flow` builds `pin_listeners` / `active_pins` keyed by **pin** (14), from the sensor's
  `listener_wiring()`, which uses the fixed `analog_pin()`. (mod.rs:217-280)
- `seed_pins` (mod.rs:145) field `analogChannel` (`#[serde(rename = "analogChannel")]`, L149) **matches**
  the producer `PinInfo` in `src-tauri/src/hardware/types.rs` (`#[serde(rename_all = "camelCase")]`).
  Desktop `pins_json` is built in `hardware/firmata.rs:53` with `analog_channel: if pin.analog { index } else { -1 }`.
  → no serde seam mismatch.
- End-to-end test (commit `5a0c727`, mod.rs ~L929-988): seeds Uno pins, asserts setup emits
  `set_pin_mode(14, ANALOG)` + `REPORT_ANALOG` on **channel 0** (never pin 14), then feeds a real
  `0xE0` channel-0 frame and asserts the `"pot"` sensor emits `Number(612)`. `cargo test -p microflow-core`: 344 pass.

## Most likely reason it still *looks* broken: stale build

The generated wasm is **untracked build output** (`git ls-files …/generated` is empty), produced by
`bun run build:wasm` → `wasm-pack build …` (`apps/web/package.json:10-12`). `bun dev` / `bun build`
run `build:wasm` first (L7-8), **but a dev server already running before the fixes will not rebuild on
its own**. The Tauri desktop likewise needs a `cargo` / app rebuild.

### Do this first
1. **Desktop:** stop the running app, rebuild: `cargo build -p microflow` (or `bun tauri dev` fresh).
2. **Browser:** stop the dev server, then `cd apps/web && bun run build:wasm` and restart `bun dev`
   (the committed `.wasm` in `src/lib/runtime/generated` and `src/lib/firmata/generated` is local-only
   and may predate the Jun-1 fixes).
3. Confirm source is green: `cargo test -p microflow-core --features runtime`.

## Residual things to sanity-check on real hardware (not covered by tests)

- **Chunked serial framing.** `pump_port` feeds raw 256-byte reads to `feed_bytes`; a 3-byte analog
  frame split across two reads must be reassembled by the codec's `rx` state machine. Pre-existing
  codec logic, but the unit tests feed whole frames — worth one hardware check.
- **Non-A0 analog channels.** `board.rs::analog_channel_for` (mod.rs board path) vs the old desktop's
  count-analog-pins-before-N approach: identical on a standard Uno (`pin-14 == channel`), could differ
  on boards with non-contiguous analog pins. The default/tested case (A0) is fine.
- **Event-driven vs polled sensor.** Sensor `freq` polling was dropped; updates are now driven by
  inbound frames (`feed_bytes`). Behavior change, not a breakage.

## Dead code to be aware of
The old desktop runtime still compiles but is unused (kept as rollback per `892934c`):
`apps/web/src-tauri/src/runtime/board/connection.rs` (`detect_and_emit_changes`, `analog_channel_for`,
`enable_analog_reporting`). Don't edit it expecting live effect — the actor drives `microflow_core`.

---

# Live hardware logs — two real bugs at HEAD

Hardware run (Nano on `/dev/cu.usbserial-2110`, StandardFirmata 2.5, "Found 23 pins") shows the build is
**fresh** (logs come from `microflow_core::runtime`), so this is **not** a stale artifact. Two distinct
genuine bugs, both in the new shared core, both invisible to the unit tests:

```
[WARN] microflow_core::runtime  enable analog reporting failed for pin 14: Hardware error: Pin 14 does not support mode 2
[INFO] microflow_core::runtime::input::button  [Button …] init pin=2 mode=0 (is_pullup=false)
[INFO] microflow_core::runtime::input::button  [Button …] init pin=3 mode=0 (is_pullup=false)
```

## Bug A — Buttons dead after a pin move (port-granularity reporting reconcile) — CONFIRMED

**Symptom:** "button on both pin 2 and 3 do not trigger anything."

**Root cause.** Digital reporting is a **per-port** resource — `REPORT_DIGITAL(port)` covers 8 pins —
but `update_flow`'s reconcile (`crates/microflow-core/src/runtime/mod.rs` §5, ~L246-275) tracks needs
**per pin** in `report_set: HashMap<u8,bool>` and reconciles per pin with no port-sibling guard:

```rust
for (&pin, &is_analog) in &report {                 // enable newly-needed
    if !self.report_set.contains_key(&pin) { writer.enable_digital_reporting(pin) /* port = pin/8 */ }
}
for (&pin, &is_analog) in &self.report_set {         // disable vanished
    if !report.contains_key(&pin) { writer.disable_digital_reporting(pin) /* port = pin/8 */ }
}
self.report_set = report;                            // mod.rs:283 — prior turn persisted
```

`enable_digital_reporting`/`disable_digital_reporting` (`runtime/board.rs`) both do `let port = pin / 8`.
Pins 2, 3, 6 **all map to port 0**. Moving the button 6→2→3 each turn:
- prior `report_set = {6}`, new `report = {2}`
- enable loop: 2 ∉ {6} → `REPORT_DIGITAL(port 0, true)`
- disable loop: 6 ∉ {2} → `REPORT_DIGITAL(port 0, false)` ← **clobbers the enable** (enables run first)
- net: port 0 reporting OFF → board streams nothing for pins 0-7 → button dead.

A fresh single-button flow works once (report_set empty → enable, no disable); the **next pin change within
the same port disables it** and nothing re-enables. Classic per-port resource managed by per-pin add/remove
without refcounting.

**Fix (recommended).** Reconcile **digital reporting at port granularity**; keep analog per channel.
Derive `needed_ports = {pin/8 for digital pins in report}` and `prev_ports` from the old set, then
enable/disable on the **port-set** difference. Minimal alternative: in the disable loop, skip
`disable_digital_reporting(pin)` when any pin still in `report` (digital) satisfies `p/8 == pin/8`.

**Why tests miss it.** The digital tests seed pins and add one listener; none removes/moves a digital pin
that shares a port with another, so the disable-clobbers-port path is never exercised.

## Bug B — Analog sensor dead: `pins[14].analog == false` — root cause confirmed, sub-cause open

`enable_analog_reporting(14)` (`runtime/board.rs`) bails **before** sending `REPORT_ANALOG`:

```rust
let is_analog = self.client.pins.get(pin as usize)?.analog;
if !is_analog { return Err(HardwareError::UnsupportedPinMode { pin, mode: pin_mode::ANALOG }.into()); }
```

So the warning text "does not support mode 2" is misleading — the only thing checked is the codec's
`pin.analog` **flag**, which is **false for pin 14** on this board. The desktop detection round-trips that
flag verbatim (`hardware/firmata.rs` ~L259): `analog_channel: if pin.analog { index } else { -1 }`, and
`seed_pins` sets `pin.analog = analog_channel >= 0`. So the flag is false because the **codec's
capability / ANALOG_MAPPING parse never marked pin 14 analog** during detection.

Two candidate sub-causes (need one more data point to pick):
1. **Detection timing.** Capabilities + analog-mapping are queried, then only `CAPABILITY_READ_ITERATIONS = 10`
   `pump_into` reads drain *both* responses. For 23 pins the CAPABILITY_RESPONSE is large; if the
   ANALOG_MAPPING_RESPONSE arrives after the 10-read window, no pin gets `.analog = true` → every analog
   sensor fails this check. (Would also explain it being board/timing-dependent.)
2. **Pin-numbering mismatch.** `a4ef958` hardcoded `analog_pin("A0") = 14` (`ANALOG_PIN_BASE`) and the codec
   decode hardcodes `pin = channel + 14`. If this board's analog mapping puts A0 at a different pin index,
   pin 14 is digital → flag false, and the hardcoded 14 is simply wrong for it.

**Inconsistency to resolve either way:** resolution + decode assume `A0 ≡ pin 14` *unconditionally*, but
the reporting-enable trusts the *detected* `.analog` flag. They must agree.

**Next data point:** log the `pins_json` handed to `seed_pins` on connect (host.rs Connect arm) — look at
pin 14's `analogChannel` and which pins report analog. That instantly distinguishes "mapping never parsed"
(no pins analog) from "A0 is not pin 14 on this board" (some other pin analog).

### RESOLVED — sub-cause was the lost ANALOG_MAPPING_RESPONSE

Hardware `pins_json` (Nano, 23 pins) confirmed it: **every** pin came back `"analogChannel":-1`, yet pins
14–21 listed mode `2` (ANALOG) in `supportedModes`. So the CAPABILITY_RESPONSE parsed fine but the
ANALOG_MAPPING_RESPONSE was never applied (it trails the large capability dump and the detection read
window missed it) → no pin got `.analog = true` → analog reporting refused for every analog pin, and the
UI fell back to raw pin numbers (frontend labels A0..An from `analogChannel`, `pin.ts`).

**Key insight:** the analog-mapping *channel value* is never used — `BufferBoardWriter::analog_channel_for`
derives the channel by *counting* `.analog` pins. The mapping response's only job was to set the `.analog`
bool, and `supportedModes` (reliably parsed) already carries that signal (mode `2`).

**Fix (`crates/microflow-core/src/firmata/mod.rs`, CAPABILITY_RESPONSE handler):** set `pin.analog = true`
when a pin advertises `MODE_ANALOG`. Now `.analog` is derived from the capability alone — robust to the
mapping response being missed or arriving out of order (the mapping handler still runs when present; it sets
the same flag). Detection then emits `analogChannel = index` for analog pins, so `seed_pins` flags them and
the frontend labels A0..An — both symptoms fixed by one core change. Regression test:
`capability_response_flags_analog_pins_without_analog_mapping`. `cargo test -p microflow-core --features
runtime`: 349 passed. Shared core → desktop (rebuild) and browser (`bun run build:wasm`) both.
