# ADR-0038 — Bootloader protocols live once in core; a host is a flash executor

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander

> **Decision:** STK500v1, STK500v2 and AVR109 each exist once, as a sans-IO
> `FlashDriver` in `crates/microflow-core/src/flasher/`. A host is a **flash
> executor**: it carries a driver's `FlashStep`s out on its serial transport and
> feeds back what the board answered. An executor owns only what differs per
> machine: opening and closing the port, and finding a board again after a USB
> re-enumeration. The drivers are tested against **modelled bootloaders**
> transcribed from Arduino's bootloader sources, and a real board has the last
> word.

## Context

Flashing StandardFirmata is the first thing the app does to a board without it,
so a flash that fails is a user who never gets started.

The browser already flashed through core: `microflow-firmata-wasm` wraps a
`FlashDriver` as `FlashSession`, and a Web Serial loop runs its steps. The
desktop did not. It had its own blocking implementation of the three protocols
in `src-tauri/src/flasher/protocols/` (about 900 lines), next to the core
drivers the browser ran. Every protocol was written twice, and the two copies
disagreed:

- The core STK500v2 driver left `MESSAGE_START` out of the checksum and read the
  status from the wrong byte, so a Mega's bootloader dropped every message: a
  Mega could not be flashed from the browser at all.
- The desktop STK500v1 baud fallback opened the port a second time while it
  still held it. An exclusive port refuses that, so a Nano guessed at the wrong
  baud failed with "Failed to open port" and never reached the next rate.
- A STK500v2 sign-on waited 1 s for its answer, while stk500boot listens for
  about 1 s after reset. Of five attempts only the first could land.

None of this was caught by a test: the driver tests scripted an always-OK
reply, so the only real check was a board on a desk.

[ADR-0030](0030-hardware-tested-at-the-byte-seam.md) had settled the same
problem for hardware Nodes: test at the byte seam against a model of the
firmware, and assert on the device's state.

## Decision

**D1 — A driver owns the whole protocol.** A `FlashDriver`
(`flasher/driver.rs`) is a state machine with `start()` and `advance(input)`,
each returning the next `FlashStep`: `Reset`, `SetBaud`, `FlushInput`,
`Transact`, `Delay`, `ReacquirePort`, `Progress`, `Done`, `Error`. The bytes,
the reset sequence, the sync retries and their timing, the baud fallback, the
timeouts and the decision to give up are all the driver's. `new_driver(board,
flash)` picks `Stk500v1Driver` (Uno, Nano), `Stk500v2Driver` (Mega) or
`Avr109Driver` (Leonardo, Micro) from the board's `BoardConfig`. Each cadence
constant carries the bootloader timing it is derived from.

**D2 — Two executors, one contract.** The desktop's is `executor::run`
(`apps/web/src-tauri/src/flasher/executor.rs`, blocking, over the `SerialHost`
seam in `serial.rs`); the browser's is `runFlash` behind `flashPort`
(`apps/web/src/board/web-serial.ts`, async, Web Serial). Both follow the
contract written in `driver.rs`: run every step in order; discard buffered input
at the start of every `Transact`, also one that writes nothing, unless it says
`keep_input`, in which case read on in the input as it is; time a `Transact`'s
read with one deadline for the whole step, `timeout_ms` after its bytes were
written, which bytes that arrive do not extend; report a short read as the
bytes that did arrive and let the driver judge it; close the port before
opening it again. A driver therefore asks for a command's whole answer in the
`Transact` that writes the command. The browser executor takes its environment
(`FlashEnv`: where a re-enumerated bootloader is found, and the clock its waits
run on), so a test runs it on a fake Web Serial port and a fake clock through
the compiled drivers.

**D3 — An executor owns the machine, not the protocol.** What stays in a host:
opening and closing the port (the desktop waits 100 ms after a close and tries
the reopen up to five times, because closing returns before every serial driver
has let go), the DTR/RTS writes of a `Reset`, how a read waits within the
step's one deadline, and
`ReacquirePort`: after AVR109's 1200-baud touch the board comes back as its
bootloader on the same port name or another. The desktop polls the port list for
it; the browser takes an already granted port or asks for one. A host adds no
retry, no fixed sleep and no protocol byte of its own.

**D4 — Everything else about a flash is core's too.** The Intel-HEX parser
(`flasher/hex.rs`), the board catalogue and USB identification (`BoardConfig`,
[ADR-0031](0031-positive-identification-before-auto-flash.md)), the embedded
StandardFirmata images (`flasher/firmware/*.hex`, through
`firmware::standard_firmata_hex`) and the error type. A `FlashError` crosses the
wire as its text, so both hosts show the same sentence for the same failure
("Failed to sync with bootloader", "Communication error: …").

**D5 — Drivers are proven against modelled bootloaders.** `SimBootloader`
(`flasher/sim.rs`, compiled only under `cfg(test)` or the `sim-board` feature)
consumes what a flasher writes, answers as the real bootloader would, and keeps
the chip's flash. There are four models, each transcribed from the bootloader in
the Arduino AVR core: Optiboot (Uno, newer Nano), ATmegaBOOT (older Nano,
Duemilanove), stk500boot (Mega 2560) and Caterina (Leonardo, Micro). Each runs
its own deadlines on a virtual clock, so a flasher that dawdles finds the sketch
running. A test flashes an image and asserts on what was programmed
(`flasher/driver_tests.rs`); something a real bootloader would choke on or drop
is recorded as a violation. The desktop executor is tested the same way through
`SimSerial` (`sim_serial.rs`), a modelled board behind a port that also models
exclusive opens, a port that stays busy after a close, and re-enumeration.

**D6 — Hardware has the last word.** A model can be wrong; where it departs from
a real board, the board wins and the model is corrected. `sim.rs` lists the
known differences. The [Hardware smoke suite](../../CONTEXT.md#hardware-smoke-suite)
has an opt-in flash check (`flasher/hardware_smoke.rs`): with
`MICROFLOW_HW_PORT` and `MICROFLOW_HW_FLASH=<board id>` both set, it flashes
StandardFirmata and then asks the board for Firmata. It never picks a port or a
board itself.

**D7 — A driver keeps listening through a sync, and bounds it by counting
waits.** A board just reset is asked again and again until it answers, and over
a slow link (a slow USB-serial bridge, a hub, a busy machine, Web Serial) the
answer to one attempt can arrive after the next went out. So the repeats of a
sign-on, sync or identify, and the first command after them, keep their input
(`keep_input`): any answer ends the phase whenever it comes in, and the answers
to the other attempts are read past ahead of the answer to the next command, by
sequence number on STK500v2 and by count and shape on STK500v1 and AVR109.
Nothing is taken for an answer that is not one. A driver has no clock, so the
time it gives a board that never answers is counted in waits, and rests on the
one deadline per step: a wait asks for just the answer until the first byte at
that baud that is no answer, the attempt that byte came in for listens on once,
and every later wait reads its whole period. Bytes that are no answer (a sketch
still printing, a bootloader at another baud) therefore buy no time. A board
that never answers is given up on after at most nine periods per baud on
STK500v1 (5.3 s) and six periods on STK500v2.

## Considered options

- **Keep the desktop's blocking protocols and fix them.** They were what
  released desktop builds had been flashing boards with, but every fix would
  have to be made twice and kept alike by hand.
- **Run the browser's executor on the desktop through the webview.** One
  executor, but flashing would then need Web Serial inside the desktop webview,
  and the desktop's board link flashes before any page asks.
- **Test the drivers against recorded transcripts from real boards.** A
  transcript pins the bytes one flash happened to send, not whether another
  sequence would also program the chip, and it cannot answer a retry it was not
  recorded with.

## Consequences

- A protocol fix is made once and reaches both hosts. A Mega flashes from the
  browser and the desktop.
- A new board on an existing protocol is a `BoardConfig` row and an image. A new
  protocol is a driver and a model; no executor changes unless it needs a new
  kind of step.
- The models are transcriptions, with the error rate of any transcription. A
  chip's start-up time, page-write latency, bytes at the wrong baud and a blank
  chip are modelled loosely or not at all. A green test run means the driver agrees with
  the model, which is weaker than agreeing with a board.
- The flash check needs a board per protocol and a person to plug it in, so it
  does not run in CI. One board each of STK500v1, STK500v2 and AVR109 covers the
  drivers.
- A board that talks instead of answering is given up on at most one listening
  period per baud later than a silent one.
- The browser's re-acquire is the weakest step: it takes the last granted port,
  and asking for a new one needs a user gesture that a flash in progress may not
  have.
- `apps/web/src-tauri/src/flasher/hex/` is not what gets flashed. It holds the
  source of Microflow's StandardFirmata (`hex/StandardFirmata/`), which the
  manual-flash guide links to, beside images that are not embedded.

## What this does NOT decide

- Which devices may be flashed without asking. That is
  [ADR-0031](0031-positive-identification-before-auto-flash.md).
- When a flash happens. That is the [Board Bring-Up](../../CONTEXT.md#board-bring-up)
  machine.
- Verification by read-back, enforcing the chip signature, a bound on the
  image size, flashing a user's own sketch from the app, or any non-AVR board.
- How the StandardFirmata images are built and refreshed.

## References

- `crates/microflow-core/src/flasher/mod.rs` — `new_driver`, `BoardConfig`, `FlashError`.
- `crates/microflow-core/src/flasher/driver.rs` — `FlashDriver`, `FlashStep`, the executor contract.
- `crates/microflow-core/src/flasher/stk500v1.rs`, `stk500v2.rs`, `avr109.rs` — the drivers.
- `crates/microflow-core/src/flasher/sim.rs`, `driver_tests.rs` — `SimBootloader` and the driver tests.
- `apps/web/src-tauri/src/flasher/executor.rs`, `serial.rs`, `sim_serial.rs`, `tests.rs` — the desktop executor, its seam and its tests.
- `apps/web/src/board/web-serial.ts` — `flashPort`, `runFlash`; `crates/microflow-firmata-wasm/src/lib.rs` — `FlashSession`.
- `apps/web/src-tauri/src/flasher/hardware_smoke.rs` — the flash check.
- [ADR-0030](0030-hardware-tested-at-the-byte-seam.md) — the same discipline for hardware Nodes.
- `CONTEXT.md` § Flash driver, Flash executor, Modelled bootloader, Hardware smoke suite.
