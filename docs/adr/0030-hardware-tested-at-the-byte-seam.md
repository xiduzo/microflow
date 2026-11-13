# ADR-0030 — Hardware Nodes are tested at the byte seam, against a simulated board

- **Status:** accepted (2026-11-13)
- **Date:** 2026-11-13
- **Deciders:** sander

> **Decision:** a hardware Node is tested by running the real runtime against a
> simulated StandardFirmata board, `SimBoard` (`crates/microflow-core/src/firmata/sim/`),
> joined to it by `SimRig`. The test drives inputs into the board and asserts on
> the board's state. It does not assert on a fake `BoardWriter`'s calls or on
> raw outbound bytes. The codec, the board reconcile planner and the runtime
> turn all run inside the test.

## Context

The runtime reaches a board only through bytes ([ADR-0006](0006-rehost-runtime-on-core.md)):
the `BoardWriter` encodes into `Effects.outbound_bytes`, and `feed_bytes`
decodes what comes back. Until this decision the only thing on the far side of
that seam was real hardware, so the hardware Nodes had almost no tests, and the
few that existed asserted that a Node *called* the right writer method.

That kind of test cannot catch the bugs that matter here, because they live in
how the firmware *reacts* to correct-looking bytes:

- StandardFirmata ignores a digital write to a pin in PWM mode, so a Led that
  had been dimmed stopped answering on/off.
- The AccelStepper sysex reads step counts as sign-magnitude, so a negative
  move sent as two's complement became about −268 million steps.
- A pull-up button reads HIGH at rest, so a runtime that did not invert it
  showed the button pressed.
- `"A0"` resolved to pin 0 (serial RX) instead of the board's first analog pin.

Each of these passes a writer-call test and fails against the firmware.

## Decision

**D1 — The second adapter at the byte seam is a modelled board.** `SimBoard`
consumes the host's bytes and answers with the bytes StandardFirmata would,
modelled on its callbacks and main loop, including quirks such as
`I2C_STOP_READING`. It answers the handshake for a **board layout** (Uno, Mega
2560, Leonardo: pins, capabilities, analog mapping), and exposes state, not
bytes: "pin 9 is PWM at 128", the I2C bus, a MAX7219 chain, a WS2812 strip,
AccelStepper motors. A write the firmware would silently ignore is recorded as a
**firmware violation**, so a test can fail on it. Inputs are driven the way a
user would: a digital level, an analog reading, an I2C device's registers.

**D2 — Faults are scriptable.** The board can reset and re-announce
mid-session, drop outbound bytes, cut a sysex frame short, NACK an I2C address,
and refuse the non-stock sysex extensions (Pixel, AccelStepper) unless enabled.
These are the faults the host and runtime must survive (the re-announce, sysex
resync, missing firmware features), and they are now tested rather than hoped
for.

**D3 — The rig is an honest host.** `SimRig` handshakes with its own codec and
seeds the runtime like the real hosts do ([ADR-0018](0018-two-firmata-decoders.md)
D3), and applies each turn through `Effects::apply` on a virtual clock
([ADR-0008](0008-effects-apply-policy.md)). A Node test reads: build a flow,
attach the board, inject an input, run a turn, assert board state.

**D4 — Test-only, in core.** The sim lives next to the codec it exercises,
compiled under `cfg(test)` or the `sim-board` feature, and never into a release
or wasm build.

## Considered options

- **A fake `BoardWriter`.** Cheap, and blind to everything above: the writer
  calls were right in every one of those bugs.
- **Golden byte streams.** They catch a change but not a wrong answer, and they
  must be re-blessed whenever an encoding legitimately changes.
- **Hardware-in-the-loop CI.** The real thing, and the final word on timing and
  electrical behaviour, but slow, flaky and not available to contributors. The
  sim does not replace hardware checks; it makes them rare.

## Consequences

- The hardware Nodes (all but the PN532 reader, which has no model yet) have
  tests that fail on firmware-level bugs, and a new hardware Node is expected to
  come with one.
- The sim is a model, and a model can be wrong. Where it departs from a real
  board, the hardware wins and the sim is corrected. Behaviour that depends on
  electrical effects (brown-outs, DTR resets on a given OS) still needs a real
  board to confirm.
- The sim does not drive the desktop or wasm hosts' own
  I/O; those hosts are tested through their own seams (`LinkIo`, the browser
  link fakes).

## References

- `crates/microflow-core/src/firmata/sim/` — `SimBoard`, `BoardLayout`, peripherals, `rig.rs`.
- `crates/microflow-core/src/nodes/*/runtime.rs` — the Node tests that use it.
- `CONTEXT.md` § Sim board.
