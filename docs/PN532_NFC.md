# PN532 NFC Reader — Design Proposal

> **Status: proposal, not implemented.** This document plans a dedicated `Pn532`
> node so the approach can be reviewed before any code is written. Nothing here
> ships yet. It is written against the current runtime APIs (verified) and the
> PN532 protocol (NXP UM0701-02).

## Why the PN532 is not an I2C preset

Every device preset in the I2C node (SHT21, BME/BMP280, MPU6050, BH1750, TCS34725)
is **register-mapped**: point at a register, read _N_ bytes, decode. The preset
system is exactly `address + register + readLength + a few one-time init writes`,
and the board then **streams** that register on its sampling interval.

The PN532 is an **NFC controller with a command/response frame protocol**, not a
register-mapped sensor. There is no register to stream. Getting one card UID means:
build a checksummed command frame → write it → handle the PN532's acknowledge →
poll a ready byte → read the response frame → verify its checksum → parse the UID →
re-issue the command for the next read. None of that fits `address + register +
readLength`, so it needs a **dedicated component with its own state machine** — the
same conclusion as the VL53L0X, but more so (the VL53L0X at least has a range
register; the PN532 has none).

## The PN532 frame protocol

### Normal information frame

```
00 | 00 FF | LEN | LCS | TFI | PD0 … PDn | DCS | 00
└┬─┘ └─┬──┘ └─┬─┘ └─┬─┘ └─┬─┘ └────┬────┘ └─┬─┘ └┬┘
preamble start  len  lcs  tfi   payload    dcs  postamble
```

- **LEN** = number of bytes in `TFI + PD` = `1 + n`.
- **LCS** (length checksum): `(LEN + LCS) & 0xFF == 0` → `LCS = (0x100 - LEN) & 0xFF`.
- **TFI**: `0xD4` host→PN532, `0xD5` PN532→host.
- **DCS** (data checksum): `(TFI + ΣPD + DCS) & 0xFF == 0` → `DCS = (0x100 - (TFI + ΣPD)) & 0xFF`.

### ACK / NACK frames

- **ACK** (PN532 → host, "command received"): `00 00 FF 00 FF 00`
- **NACK**: `00 00 FF FF 00 00`

### I2C specifics

- 7-bit address **0x24** (the V3 board's DIP switches must select I2C, not SPI/HSU).
- **Every read is prefixed by a status/RDY byte.** The host reads `1 + framelen`
  bytes; `byte[0] & 0x01 == 1` means the PN532 has data ready. If bit 0 is clear,
  the rest of the read is meaningless — back off and re-read. This RDY-poll is the
  PN532's way of avoiding long clock-stretches (see [Risks](#firmata-risks--fallbacks)).

## Reading a UID — the command sequence

Two commands, precomputed as exact byte frames:

| Step | Command | Frame (hex) |
|------|---------|-------------|
| 1 | **SAMConfiguration** — wake/normal mode, `mode=01 timeout=14 irq=01` | `00 00 FF 05 FB D4 14 01 14 01 02 00` |
| 2 | **InListPassiveTarget** — 1 target, 106 kbps ISO14443-A (`MaxTg=01 BrTy=00`) | `00 00 FF 04 FC D4 4A 01 00 E1 00` |

**Response** to step 2 when a card is present (TFI `D5`, response code `4B`):

```
D5 4B NbTg Tg  SENS_RES(2)  SEL_RES  IDLen  NFCID1[IDLen] …
```

e.g. a Mifare Classic 1K (4-byte UID): `D5 4B 01 01 00 04 08 04 <U0 U1 U2 U3>`.
The **UID** is `NFCID1`, `IDLen` bytes long (4 for Classic/Mifare, **7** for
NTAG/Ultralight — the parser must honour `IDLen`, not assume 4). `NbTg == 0` means
no card in field.

## Proposed architecture in this codebase

A new `Pn532` runtime component driven by **two clocks**:

- **`schedule_wakeup` ticks** issue the next I2C operation (write a frame, or request
  a read).
- **`on_i2c_reply` deliveries** feed returned bytes into the state machine, which
  decides the next step.

This is the same wakeup facility the `Interval`/`Oscillator` nodes use
(`runtime/context.rs`), applied to a protocol driver instead of a signal generator.

### Board primitives (verified — `runtime/board.rs::BoardWriter`, via `ctx.board()`)

```rust
fn i2c_write(&mut self, address: i32, data: &[u8]) -> Result<(), RuntimeError>;  // send a frame
fn i2c_read(&mut self, address: i32, size: i32)   -> Result<(), RuntimeError>;   // one-shot read
fn i2c_config(&mut self, delay: i32)              -> Result<(), RuntimeError>;   // bus enable
```

- Send a command: `ctx.board().i2c_write(0x24, &FRAME)`.
- Request a read: `ctx.board().i2c_read(0x24, n)` — the reply arrives asynchronously.
- **Continuous read is deliberately NOT used** (it re-writes a register each cycle;
  the PN532 has no register).

### Wakeups (verified — `runtime/context.rs`)

```rust
ctx.schedule_wakeup("_tick", delay_ms);  // one-shot; re-arm inside the handler
ctx.cancel_wakeup("_tick");
ctx.now_ms();                            // host clock for timeouts
```

The wakeup fires back into `fn dispatch_internal(&mut self, method /* "tick" */, …)`
(the leading `_` is stripped by the runtime's internal-event routing). `on_start`
arms the first tick, exactly like `generator/interval.rs`.

### Receiving replies (verified — `runtime/mod.rs::drain_i2c_replies`)

The component registers a listener via
`Component::listener_wiring() -> ListenerWiring::I2cAddress { address: 0x24, register: 0 }`,
and reply bytes arrive at `HardwareComponent::on_i2c_reply(value: Array<u8>, ctx)`.

**Demux caveat:** replies are routed by address, then demultiplexed by the register
the board echoes. A one-shot `i2c_read` sends no register, so the reply's register is
`0`/unspecified. Registering the listener at `register: 0` matches it; and the
existing **fallback** (if no listener on the address matches the reply's register,
deliver to every listener on that address — `runtime/mod.rs`) guarantees delivery
even if the echoed register is unexpected. The command/response PN532 is an awkward
fit for a demux built for register-per-stream, but the fallback makes it safe.

### State machine

Polling UID reader (ACK-skipping variant — see [open decisions](#open-decisions)):

| State | On entry (tick issues op) | On `on_i2c_reply` (bytes) → next |
|-------|---------------------------|----------------------------------|
| `Start` | `i2c_write(SAMConfiguration)`; arm tick | — |
| `SamSettle` | tick: `i2c_read(0x24, 7)` (RDY + 6-byte ACK) | ACK ok → `Poll`; else retry `Start` |
| `Poll` | `i2c_write(InListPassiveTarget)`; arm tick | — |
| `AwaitResp` | tick: `i2c_read(0x24, 24)` (RDY + response) | `byte0&1`? parse frame → below |
| parse | | `D5 4B` & `NbTg≥1` → **emit UID**, re-arm `Poll`; `NbTg==0` or `!RDY` → re-arm `AwaitResp` (until timeout → `Poll`) |

Timeouts use `ctx.now_ms()`; every wait is a **short read + retry**, never a blocking
read that waits on the device (which is what protects the bus — see risks).

## Firmata risks & fallbacks

1. **Clock stretching → AVR bus hang (top risk).** The PN532 can hold SCL while it
   processes. On a classic AVR (`Wire` has *no* clock-stretch timeout) this is the
   exact failure mode that once wedged the whole bus for the SHT21 hold-master read
   (see `[[project_i2c_streaming]]` / the SHT saga). **Mitigation:** the design never
   issues a blocking "wait for the device" read — it RDY-polls with short reads and
   backs off, so the device is never given a reason to stretch for long. The robust
   firmware fix (`Wire.setWireTimeout`) is *not* available cheaply: the flasher ships
   a prebuilt `nano.hex`, and regenerating it needs an AVR toolchain that isn't on
   this machine. **This risk can only be cleared on hardware.**
2. **ACK/RDY sequencing over async Firmata.** StandardFirmata I2C is fire-and-reply;
   there is no atomic "write-then-read." The state machine sequences across async
   replies, so one UID read is ~4–6 round trips ≈ a few hundred ms. Fine for NFC (a
   card lingers in the field), not instant.
3. **Latency vs. sampling interval.** Reads are paced by ticks; a fast poll competes
   with other I2C nodes' streaming on the one global sampling interval.
4. **Variable UID length.** Honour `IDLen` (4 vs 7 bytes); don't hard-code 4.
5. **Bus speed / pull-ups.** StandardFirmata Wire is 100 kHz (PN532 is fine); the
   module needs proper pull-ups on the shared SDA/SCL.
6. **Same-address collision.** Unlikely at 0x24, but the [shared-address warning](./I2C_SUPPORT.md)
   already added to the I2C node applies to any two nodes on one address.

## Codegen: the Arduino path is *easier* than the live one

The generated **Arduino sketch** can use the `Adafruit_PN532` library directly —
`nfc.begin(); nfc.SAMConfig(); nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid,
&len)` — which is blocking, synchronous, and battle-tested. So codegen is the *simple*
half; the risky half is the **live runtime over Firmata**. Two options:
- **Runtime-only first:** the codegen dispatch falls back to `placeholder::emit` (a
  `// unsupported Node` comment) with no extra work — the node runs live but Arduino
  export omits it. Ship this first.
- **Full codegen later:** emit an `Adafruit_PN532` sketch (adds a library dependency
  to the export).

## Emit shape & config (proposed)

- **Emits:** `uid` (value handle) — the card UID as a hex string (e.g. `"04A2B1C3"`)
  when a card is read; fires on change, so a card held still won't re-fire. Optional
  second emit `present` (bool) for entered/left field.
- **Config (`config/pn532.rs`):** `address: u8` (default `0x24`), `pollIntervalMs:
  u32` (default ~300), and later `uidFormat` (hex-string vs. raw bytes).

## New files & registration (verified checklist)

~5 new files + 6 registration edits + one codegen/bless run.

**Runtime**
- new `crates/microflow-core/src/runtime/input/pn532.rs` (impl `Component` +
  `HardwareComponent` + `ComponentBuilder`; model on `runtime/input/i2c_device.rs`).
- `runtime/input/mod.rs` — add `pub mod pn532;`.
- `runtime/registry.rs` — in `register_all`: `self.register::<input::pn532::Pn532>("Pn532");`.

**Config**
- new `crates/microflow-core/src/config/pn532.rs` (POD, `#[serde(rename_all = "camelCase")]`, ungated).
- `config/mod.rs` — add `pub mod pn532;`; the runtime file re-exports `pub use crate::config::pn532::Pn532Config;`.

**Codegen** (optional — falls back to placeholder)
- new `crates/microflow-core/src/codegen/input/pn532.rs`; `codegen/input/mod.rs` +`pub mod pn532;`;
  two dispatch arms in `codegen/mod.rs` (`emit` match + `value_var` match). Skippable via the
  existing `_ => placeholder::emit(node)` fallback.

**Wire / TS bindings**
- `apps/web/node-components.json` — add to `entries[]` `{"name":"Pn532","impl":"Pn532"}` and to
  `impls[]` `{"name":"Pn532","category":"input","requiresHardware":true}`.
- regenerate + bless: **`bun run catalog:sync`** (blesses `catalog_parity.rs` and runs
  `bun run codegen`, which rewrites the generated `_REGISTRY.ts` and the `ComponentType`
  union — do not hand-edit those).

**Frontend**
- new `apps/web/src/components/flow/nodes/pn532/{pn532.tsx, pn532.schema.ts, pn532.constants.ts}`
  (schema must export `dataSchema` + `defaults` with `group: "sense"`; model on `i2c-device/`).
  The node palette picks it up automatically by `group`.

## Open decisions (for you)

1. **Scope of V1** — read **UID only** (recommended), or also read/write NDEF / Mifare
   blocks / authentication (much larger; a follow-up).
2. **Codegen now or later** — runtime-only first (placeholder in export) vs. full
   `Adafruit_PN532` sketch immediately.
3. **ACK handling** — skip ACK verification and just poll for the response
   (recommended: fewer round trips, simpler machine) vs. verify each ACK.
4. **Emit shape** — UID as hex string (recommended) vs. raw byte array; add a
   `present` boolean?
5. **Poll rate** — default ~300 ms; capped by the shared global sampling interval.

## What I can and can't verify

- **Software-testable (I will unit-test):** frame construction, LCS/DCS checksums,
  ACK recognition, RDY handling, response parsing incl. 4- and 7-byte UIDs, and every
  state-machine transition (driven by fed reply bytes, like
  `same_address_replies_demux_by_register`).
- **Not verifiable without hardware:** real I2C timing, whether the PN532
  clock-stretches enough to wedge an AVR bus, and whether StandardFirmata's async
  read/write actually sequences the handshake in practice. **This is the make-or-break
  unknown and needs a physical board.**
