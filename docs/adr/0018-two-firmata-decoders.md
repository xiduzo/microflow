# ADR-0018 — Two Firmata decoders on one stream: the handshake's and the flow's

- **Status:** accepted (2026-08-26); amended (2026-11-13)
- **Date:** 2026-08-26
- **Deciders:** sander

> **Decision:** the browser decodes each inbound Web Serial chunk twice, with two
> instances of the same `microflow-core` codec. `FirmataSession` decodes to answer
> the **handshake** — is there Firmata here, what firmware, which pins. The wasm
> `FlowRuntime` decodes to run the **flow**. They are kept consistent by
> construction: the board link hands both the identical chunk sequence,
> unfiltered, and `FlowReactor.attach` seeds the runtime from the link's pin
> seed for the bytes that arrived before it existed. Merging them is not on the table until something
> other than the handshake needs the session's decode.

## Context

`pumpReader` in `apps/web/src/board/board-link.ts` is the browser's one
inbound serial loop. Per chunk it calls `session.feed(value)` (the
`microflow-firmata-wasm` `FirmataSession`) and then hands the chunk on to the
link's inbound sink, which the board controller wires to `reactor.feedBytes`
(the `microflow-runtime-wasm` `FlowRuntime`). Two Firmata parsers and two pin
tables per chunk.

This reads like accidental duplication, and the obvious response — one decoder,
its pin observations carried to the flow as `Effects` — is a large change with a
cost this ADR records so it is not re-proposed on the strength of the shape alone.

Three facts constrain the answer.

**The two decoders are the same decoder.** `FirmataSession` and the runtime both
wrap `microflow_core::firmata::FirmataClient`
(`crates/microflow-core/src/firmata/mod.rs`). Same parser, same `Pin` struct, same
handling of `CAPABILITY_RESPONSE` / `ANALOG_MAPPING_RESPONSE`. Fed the same bytes
they reach the same state, so "two pin tables" is two copies of one derivation,
not two opinions.

**The handshake needs a decoder before a runtime can exist.** The probe
(`probeBoard` in `board-link.ts`) writes `encodeQueryFirmware` and then polls
`session.firmwareName()` until the board answers; on success it writes the
capability + analog-mapping queries and polls `pinCount(session)`. Those polls only advance because the pump is feeding
the session. There is no `FlowReactor` yet — `FlowReactor.attach` runs from the
bring-up machine's `connected` phase, after the probe returns a connection. A
single-decoder design must therefore still start with this one; the duplication
exists only after a board is up.

**Only one of the two decodes feeds anything.** The runtime's decode drives the
flow: `feed_bytes` → `detect_pin_changes` → pin-change events → node values and
edge signals on the canvas. The session's steady-state decode feeds no browser
surface. `connectedState` takes a one-shot `pinsJson` snapshot at connect for the
board store, and `FlowReactor.attach` takes one for the seed; nothing re-reads the
session afterwards. So the crossing is not "one stream, two consumers" — it is one
consumer plus a decoder whose job (the handshake) is already done and whose state
stays current for a snapshot that is not retaken.

## Decision

**D1 — The runtime owns the pin table the flow runs on; the session owns the
handshake.** These are the two questions asked of the inbound stream and they have
different lifetimes: the handshake's answer is needed before the runtime exists
and is read at connect; the flow's answer is needed on every chunk for as long as
the board is attached. One decoder each.

**D2 — Consistency comes from an identical stream, not from synchronisation.**
The board link gives both decoders every chunk, in order, with no filter. The
session gets each chunk as it arrives; chunks that arrive between the handshake
and the runtime attaching wait in the link's inbound queue and are replayed to
the runtime in order once the first flow is applied. Any state either derives from the wire, the other derives too. The
one asymmetry is deliberate: the runtime records pin *modes* as it encodes
`PIN_MODE` writes, so it correctly ignores digital port reports for pins it drives
as outputs, while the session — which writes nothing after the handshake — keeps
every pin at the default `MODE_INPUT` and tracks the board's reported level.

`apps/web/src/board/inbound-stream.test.ts` pins the property: both receive the
same chunks in the same order.

**D3 — `setPins` is a one-shot catch-up, and one shot is enough.**
`FlowReactor.attach` calls `setPins(connection.pinSeed)` once. The seed is
`link.pinSeed`: the session's pin table as `PinInfo[]`, snapshotted in the same
synchronous step that starts the inbound queue, so seed plus replayed queue is
exactly the stream the session saw. Its job is the bytes the runtime was not
alive for — the capability response the session consumed during the handshake.
Everything after the snapshot reaches the runtime on the shared stream, so a
capability or analog-mapping response that lands late is parsed by *both*
codecs and the runtime converges without a re-seed. Nothing re-queries
capabilities mid-session: `encodeQueryCapabilities` is written only by the
probe, before a reactor exists. A board that re-enumerates (native-USB boards
on reset) ends the reader; the link reports the loss, the bring-up machine
hears `connectionLost` ([ADR-0017](0017-wasm-fault-seam.md)) and closes the
port, which disposes the reactor, and the next probe builds a fresh session, a
fresh runtime and a fresh seed. A board that reboots *without* re-enumerating
is a re-announce, which the runtime handles from its own decode (see the
amendment). There is no path on which the session's pin table advances past
the runtime's.

Accordingly `FeedResult.capabilitiesUpdated` and `firmwareUpdated` have no host
consumer. They are the codec reporting what it saw; the host does not act on them,
because the only actor that would care is the runtime, which saw the same bytes.

**D4 — The session's per-chunk report is not decoded.** `pumpReader` calls
`session.feed(value)` for its state effect and ignores the returned JSON. Parsing
a `FeedResult` per chunk to dispatch pin observations no reader consumes was the
part that made this look like two competing pin readouts. The `feed` call itself
stays: it is what makes `firmwareName()` and `pinsJson()` answer, and stopping it
after the handshake would add lifecycle state to `pumpReader` to save a fraction
of a microsecond per chunk.

**D5 — Cost is not the reason to act, and is not a reason to act.** The whole wasm
boundary measures ~1.5 µs per three-event turn against a 19 ms sampling interval
([WASM_BOUNDARY_AUDIT.md](../audits/WASM_BOUNDARY_AUDIT.md)). The second decode is a
rounding error in both directions: it buys nothing to remove and costs nothing to
keep. Any argument for merging has to be about correctness or clarity.

## What would make merging worth it

Merging means one decoder — the runtime's — and the session's answers arriving
from it. Reach for it when one of these becomes true:

- **A browser surface needs live pin values.** Today none does; the canvas gets
  them as component events. A pin monitor would want them from the decoder that
  owns the pin table, i.e. the runtime, and that means a new `Effects` field.
- **The handshake stops needing its own codec** — a probe that answers from
  something other than a live Firmata conversation.

The bill in each case is the same, and is why "the shape is duplicated" alone does
not pay it: pin observations become an `Effects` field, and `Effects` is exhaustive
over both hosts ([ADR-0008](0008-effects-apply-policy.md)). The desktop
`EffectsSink` (`apps/web/src-tauri/src/runtime/host.rs`) would have to handle a
field it has no use for — it reads pin state through its own hardware monitor —
and the handshake would have to be restructured to run on a runtime that does not
exist yet.

## Consequences

**Positive**

- Each decoder answers one question, at one lifetime, for one reader. The
  handshake cannot be broken by a change to how the flow reads pins, or the
  reverse.
- Consistency is a property of the loop (one stream, both consumers, no filter)
  and is testable without wasm.
- `Effects` stays free of a field only one host wants.

**Negative**

- Every chunk is parsed twice. Accepted per D5: the measured cost is negligible
  and the alternative is a cross-host seam change.
- The session keeps decoding after its answers have been read. Accepted per D4:
  the alternative is lifecycle state in the read loop.

**Neutral**

- `FeedResult` still reports `pinChanges`, `i2cReplies`, `firmwareUpdated` and
  `capabilitiesUpdated`. The browser host reads none of them; they are the codec's
  full report. The re-announce is read from the runtime's decode, not from
  `firmwareUpdated` (see the amendment).

## Glossary

Terms for `CONTEXT.md`:

- **Detection codec** — the `FirmataSession` instance the probe drives. Answers
  the handshake (firmware, capabilities) and supplies the runtime's pin seed.
- **Pin seed** — the one-shot `setPins` at `FlowReactor.attach` that gives the
  runtime the capability response it was not alive to decode.

## References

- `apps/web/src/board/board-link.ts` — `probeBoard` (the handshake), `pumpReader` (the fan-out), `pinSeed` and `attachInbound` (the seed and the inbound queue).
- `apps/web/src/runtime/flow-reactor.ts` — `attach`: the pin seed; `feedBytes`: the flow's decode.
- `apps/web/src/board/board-controller-core.ts` — attaches the reactor, applies the flow, then `link.attachInbound(reactor.feedBytes)`.
- `crates/microflow-core/src/firmata/profile.rs` — `PinProfile`, `PinInfo`: the one pin model both decoders and both hosts share.
- `crates/microflow-core/src/runtime/session.rs` — the re-announce.
- `crates/microflow-core/src/firmata/mod.rs` — the one codec both instances wrap.
- `crates/microflow-core/src/runtime/mod.rs` — `seed_pins`, `feed_bytes`, `detect_pin_changes`.
- `apps/web/src/board/inbound-stream.test.ts` — both decoders get the same chunks.
- [ADR-0008](0008-effects-apply-policy.md) — the `Effects` seam a merge would have to widen.
- [ADR-0017](0017-wasm-fault-seam.md) — `onClosed` means the reader ended; per-chunk fault containment.

---

## Amendment (2026-11-13): one pin profile, the re-announce, and sysex resync

**The seed is a `PinProfile`, carried as `PinInfo[]`.** What each pin of the
board can do — its capability response and its analog-mapping response — is one
type in core, `PinProfile` (`firmata/profile.rs`). The codec decodes an analog
report onto the pin its channel maps to and encodes analog reporting by channel
through it; the `BoardWriter`, a node resolving `"A<n>"`, the live pin check and
the safe state all ask it. Both hosts project it into the seed as `PinInfo[]`
(`{ pin, supportedModes, analogChannel }`, ts-rs generated): the browser's
`link.pinSeed`, the desktop probe's `pins_json`. The runtime rebuilds the
profile from that seed, modes included, so the two decoders and the two hosts
share one model of the board instead of each guessing (an Uno-shaped `14 + n`
for `A<n>` is now only the fallback when no board has described itself).

**The re-announce is read from the runtime's decode.** A board can reboot
without its port closing — a reset over an external USB-serial chip, a DTR
pulse, a brown-out — and come back having forgotten its pin modes, reporting
and I2C queries. It announces itself again with `REPORT_FIRMWARE`. The detection
codec saw its own answer during the handshake, before the runtime existed, so a
`REPORT_FIRMWARE` in the runtime's decode can only be the board announcing
itself again. The runtime (`runtime/session.rs`) then resets what it believed
about the pins, rebuilds every hardware node, replays the board setup against an
empty board and restores the outputs that are safe to restore. The session's
`firmwareUpdated` is not used: that would put the detection codec back in the
steady-state path for a decision only the runtime can carry out. This is the
case listed above as a reason to merge the decoders; it landed without merging,
and `Effects` gained no field for it. Three re-announces within 30 s are a
**reset storm**: the flow is still re-applied, but restored outputs are held at
the safe state until the board is quiet for 30 s or the flow changes, so an
output that browns the board out does not reset it forever.

**A sysex ends at a status byte.** Both decoders end a sysex frame at the next
byte with its high bit set, not only at `END_SYSEX`. A frame cut short — by a
reset mid-sysex, or line noise — then costs that frame only, and the frame after
it (the boot announcement, typically) is decoded rather than swallowed.

**No byte stream panics the decoder.** `FirmataClient::feed` reads every frame
through checked access only, so a truncated or malformed message (line noise, a
reset mid-message) is dropped, never a panic that takes down the browser
runtime or the desktop actor. `firmata::sim::noise` builds a hostile corpus —
every known message cut at every byte and followed by every other, plus seeded
random streams — and tests push it through the client (with and without a
described board, whole, bytewise and in random chunks), the wasm detection
session and the runtime's inbound path.

**The profile is bounded and the seed is literal.** A `PinProfile` holds at most
`MAX_PINS` (128, Firmata's addressable pins); a capability response or seed
entry past that is dropped rather than allocated. A seed's `analogChannel` is
always the board's analog channel for that pin (`-1` for none): seeds are built
fresh on every connect and never stored, so the runtime reads them as given and
does not guess at an older pin-index format.
