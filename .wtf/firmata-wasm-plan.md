# Firmata over WASM — plan

Goal: run the Firmata board protocol in the browser via the Web Serial API,
sharing one protocol implementation with the desktop (single source of truth),
mirroring the codegen→WASM migration.

## Key constraint

`firmata-rs::Board` needs a **synchronous `Read + Write`**. The Web Serial API
is **async** (Promises) and WASM is single-threaded with no blocking — you
cannot block on a Promise. So the protocol must be **sans-IO**: a codec that
encodes commands to bytes and parses incoming bytes, with the transport (and
its async loop) living *outside* the core, per platform.

## Decisions (locked)

- **Single source of truth**: desktop migrates onto the new core codec; drop
  `firmata-rs`.
- **Scope**: runtime Firmata **and** flashing (stk500/avr109) over Web Serial.
- **Non-Chromium browsers** (no Web Serial — Firefox/Safari): feature-detect
  `navigator.serial`, disable connect, nudge to the desktop app download.

## Phases

- [x] **A — sans-IO Firmata codec in `microflow-core`** (`firmata` module).
  Encoders return bytes; `feed(&[u8])` parses incrementally. Faithful port of
  `firmata-rs` value/sysex semantics, stricter (length-aware) framing. 17 wire
  tests, clippy-pedantic clean, wasm32-clean. No desktop change yet.
- [ ] **B — migrate desktop runtime onto the core codec.** `BoardConnection`
  wraps `FirmataClient` + serialport; `read_and_decode` becomes read→`feed`.
  Keep `BoardHandle` async API identical → frontend untouched. Remove
  `firmata-rs` dep. Update `hardware/firmata.rs` probe + detection.
- [x] **D — `microflow-firmata-wasm` wrapper crate.** Stateful `FirmataSession`:
  encoders → `Uint8Array`; `feed(bytes)` → JSON of pin changes / I2C replies /
  firmware+capability flags; pin/firmware accessors. 4 host tests, pedantic
  clean, 46 KB wasm. `build:wasm:firmata` wired into `bun run build`.
- [x] **C — flasher (all three protocols).** Pure core (HEX parser, board
  configs/USB detection, `BoardType`/`Protocol`/`FlashError`) **plus** sans-IO
  `FlashDriver` step machines for stk500v1, stk500v2, avr109 + embedded
  StandardFirmata hex, all in `microflow-core`. `microflow-firmata-wasm` exposes
  `FlashSession` (start/advance→JSON steps), `standardFirmataHex`, `flashBaud`,
  `parseHex`, `detectBoardFromUsb`. Browser executor (`web-serial.ts`
  `flashStandardFirmata` + `runFlash`) drives the steps over Web Serial; a
  "Flash firmware" button in `NavMicrocontroller` detects the board from USB,
  picks firmware, flashes with a sonner progress toast. avr109 re-enumeration
  handled best-effort via `reacquirePort` (getPorts → else requestPort).
  14 core + driver tests; happy paths scripted per protocol.

  Superseded note (was partial): **Done:** moved the pure pieces to
  `microflow-core::flasher` — Intel-HEX parser, `BoardType`/`Protocol`,
  `FlashError`, `BoardConfig` + USB detection. Desktop re-exports them (single
  definition, behavior unchanged); browser gets `parseHex` + `detectBoardFromUsb`
  via wasm. 10 core + 2 wasm tests. **Deferred (hardware-gated):** the bootloader
  I/O *orchestration* as a sans-IO action driver (DTR/RTS reset timing, sync
  retry, baud fallback, page programming) + embedded firmware hex. It is
  timing-critical and board-bricking-risky to rewrite without a board to test
  on; AVR109 (Leonardo/Micro) additionally does a 1200-baud-touch + USB
  **re-enumeration** that Web Serial models very differently (permission-gated
  `requestPort()`, no port names) — so only stk500v1/v2 (same-port DTR/RTS
  reset) port cleanly. Best built alongside the browser executor with hardware
  in the loop.
- [~] **E — browser connect (transport slice done).** Web Serial transport
  (`lib/firmata/web-serial.ts`) + wasm loader (`lib/firmata/wasm.ts`) +
  `useWebSerialBoard` hook + a "Connect board" entry point in
  `NavMicrocontroller` (web only; Firefox/Safari get the desktop nudge). Click →
  `requestPort()` → DTR reset → firmware/capability handshake via `FirmataSession`
  → populates `useBoardStore` (firmware + pins, "connected"). **Still missing:**
  live *flow execution* — the runtime below.
- [ ] **E (rest) — browser live flow execution.** **Big epic:** the live
  board runtime (`FlowExecutor`, `Component` impls, router, `BoardHandle`
  scheduling) is entirely Rust in `app_lib`, async (tokio) + thread-based
  (reader loop), surfaced to the browser only as Tauri `board-state` /
  `component-event` events. The browser has **no** flow engine. A Web Serial +
  `FirmataSession` bridge alone connects to a board but has nothing to drive
  it. Making the browser run a flow on hardware requires porting the async
  runtime to **single-threaded wasm** (replace `std::thread` reader loop +
  tokio rt with a `setTimeout`/Promise-driven reactor, timers via the event
  loop, `wasm-bindgen-futures`). This is a major epic and a real architecture
  decision — not a wrapper. Codec foundation (A/B/D) is the prerequisite and is
  done.
- [ ] **F — CI.** Build firmata-wasm; lint/test full workspace.

## Status

A, B, D shipped: one Firmata protocol implementation, desktop migrated onto it
(firmata-rs dropped), browser can speak the protocol via wasm. The hard,
unblocked-by-codec remainder is the **runtime port** (E) and the **flasher**
(C). Both are large; E needs a decision on the wasm async model before code.
