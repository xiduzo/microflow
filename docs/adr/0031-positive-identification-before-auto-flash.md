# ADR-0031 — Flash automatically only a positively identified board; offer the rest

- **Status:** accepted (2026-11-13)
- **Date:** 2026-11-13
- **Deciders:** sander

> **Decision:** a host flashes StandardFirmata without asking only when the
> device's USB vendor and product id **positively identify** an official Arduino
> board. A device on a generic USB-serial chip (CH340, CP210x, FTDI) whose
> product id clones commonly use is a **bridge-chip guess**: it is probed, it
> connects if Firmata answers, and otherwise the user gets a "Flash as <board> on
> <port>" offer. Nothing is flashed until they confirm. A device with no
> recognised vendor is never offered.

## Context

Flashing replaces whatever firmware is on a device, so a wrong flash destroys
someone's work on an unrelated device. Detection used to fall back to matching
on the product id alone, which covers the common bridge chips: `1A86:7523`
(CH340), `10C4:EA60` (CP210x) and `0403:6001` (FTDI). Those chips are on most
Arduino clones, but also on ESP32 development boards, GPS modules and plain
USB-serial adapters. Any of them plugged into a machine running the desktop app
could be auto-flashed as an Uno or a Nano. The browser flashed any port the
user picked.

Clone boards still have to work. They are what most students have, so a
policy that left a CH340 Nano unflashable would fail the people the app is for.

## Decision

**D1 — Identification is a three-way answer.** `BoardConfig::identify_usb(vid, pid)`
(`crates/microflow-core/src/flasher/mod.rs`) returns:

- `UsbMatch::Identified(board)` — Arduino's own vendor ids (`0x2341`,
  `0x2A03`) with a known product id (Uno, Mega, Leonardo, Micro);
- `UsbMatch::BridgeChip { board, chip }` — a bridge-chip vendor with a product id
  clones of `board` use;
- `None` — anything else.

`detect_from_usb` returns a board only for `Identified`, and that is the only
value hosts pass as `auto_flash` to [Board Bring-Up](../../CONTEXT.md#board-bring-up).
In the browser, auto-flash is further limited to a port the user just picked.

**D2 — The offer is a bring-up phase, shared by both hosts.** When the probe
finds no Firmata on a bridge-chip guess the user is watching, the machine enters
`Phase::ConfirmFlash { board }` and emits no flash action. The user's answer
comes back as `FlashConfirmed` or `FlashDeclined`, and either is ignored unless
an offer is open. One prompt module (`apps/web/src/board/flash-offer.ts`) shows
the offer on both hosts; only the answer's route differs: the browser feeds its
own controller, and the desktop invokes `confirm_board_flash` /
`decline_board_flash`, which the monitor thread drains on its next tick.

**D3 — An open offer is stable and names its device.** While an offer is open,
other ports wait and quiet retries hold, so the prompt the user is reading is
not replaced or withdrawn from under them. The offer carries `{ port, board,
vid, pid }`, and an answer names the offer it answers, so a stale click cannot
act on another device. The desktop re-checks the device behind the port path
right before flashing. Unplugging the device withdraws the offer. USB serial
numbers are not available on these paths, so identity is the port path plus the
USB ids plus that re-check.

## Considered options

- **Keep matching by product id, behind a setting.** The default would still
  flash strangers' devices, and the people who need the setting are the ones
  least likely to know it exists.
- **Never auto-flash; always ask.** Safe, but it adds a prompt for every
  official board, where the identification is certain.
- **Trust more vendors now.** SparkFun (`0x1B4F`) and others ship boards under
  their own vendor id and are candidates for positive identification. They are
  not trusted yet; a generic bridge-chip vendor never will be.

## Consequences

- An official Arduino without Firmata is still flashed with no prompt.
- A clone that already runs Firmata connects with no prompt, on first connect
  and on reconnect.
- A clone without Firmata takes one click. So does a genuine board on an FTDI
  chip (an older Nano, a Duemilanove), because its USB ids cannot be told apart
  from an FTDI adapter's.
- A bridge-chip guess names one board per product id (a CH340 is offered as a
  Nano). A clone with a different bootloader can fail to flash from the offer
  and must be flashed manually.

## References

- `crates/microflow-core/src/flasher/mod.rs` — `identify_usb`, `UsbMatch`, `BridgeChip`.
- `crates/microflow-core/src/bringup.rs` — `Phase::ConfirmFlash`, `FlashConfirmed`, `FlashDeclined`, `is_offering`.
- `apps/web/src/board/flash-offer.ts` — the shared prompt.
- `apps/web/src-tauri/src/hardware/board_link.rs` — `OfferId`, `FlashAnswer`, the desktop re-check.
- `CONTEXT.md` § Positively identified board, Bridge-chip guess.
