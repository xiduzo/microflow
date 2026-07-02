# PN532 NFC Reader

The `Pn532` node reads the UID of an NFC/RFID card over I2C using a PN532 module
(e.g. the Aideepen V3 board). It is a **dedicated node**, not an I2C-device
preset — the PN532 is a command/response NFC controller, not a register-mapped
sensor, so it needs its own protocol driver.

## Why it is not an I2C preset

Every I2C-device preset (SHT21, BME/BMP280, MPU6050, BH1750, TCS34725) is
**register-mapped**: point at a register, read _N_ bytes, decode, and let the
board stream that register on its sampling interval. The PN532 has no register to
stream. Reading one card UID means: build a checksummed command frame → write it →
let the module process → poll a status byte → read the response frame → verify its
checksums → parse the UID → re-issue for the next read. That is a state machine,
not `address + register + readLength`.

## Wiring

- Set the module's DIP switches to **I2C** (not SPI/HSU).
- 7-bit address **0x24** (the node default).
- Shared SDA/SCL need proper pull-ups; StandardFirmata's `Wire` runs at 100 kHz,
  which the PN532 handles.

## Configuration

| Field | Default | Meaning |
|-------|---------|---------|
| `address` | `0x24` | 7-bit I2C address. |
| `pollIntervalMs` | `300` | How often a fresh scan is issued while sensing for a card. Floored in practice by the board's global sampling interval when sharing a bus. |

## Output

- **`value`** — the card UID as an uppercase, separator-free hex string
  (e.g. `"04A2B1C3"`). It fires **on change**, so a card held still in the field
  does not re-fire, and re-presenting the same card is quiet. UID length is
  honoured (4 bytes for Mifare Classic, 7 for NTAG/Ultralight).

## The PN532 frame protocol

### Normal information frame

```
00 | 00 FF | LEN | LCS | TFI | PD0 … PDn | DCS | 00
└┬─┘ └─┬──┘ └─┬─┘ └─┬─┘ └─┬─┘ └────┬────┘ └─┬─┘ └┬┘
preamble start  len  lcs  tfi   payload    dcs  postamble
```

- **LEN** = byte count of `TFI + PD` = `1 + n`.
- **LCS** (length checksum): `(LEN + LCS) & 0xFF == 0`.
- **TFI**: `0xD4` host→PN532, `0xD5` PN532→host.
- **DCS** (data checksum): `(TFI + ΣPD + DCS) & 0xFF == 0`.

### ACK / NACK

- **ACK** (`command received`): `00 00 FF 00 FF 00`
- **NACK**: `00 00 FF FF 00 00`

### I2C read framing

Every PN532 I2C read is prefixed by a **status/RDY byte**: the host reads
`1 + framelen` bytes, and `byte[0] & 0x01 == 1` means data is ready. If the bit is
clear the rest of the read is meaningless — back off and re-read. This RDY-poll is
how the PN532 avoids long clock-stretches (see [Limitations](#limitations)).

### The two commands used

| Command | Frame (hex) |
|---------|-------------|
| **SAMConfiguration** — normal mode (`mode=01 timeout=14 irq=01`) | `00 00 FF 05 FB D4 14 01 14 01 02 00` |
| **InListPassiveTarget** — 1 target, 106 kbps ISO14443-A (`MaxTg=01 BrTy=00`) | `00 00 FF 04 FC D4 4A 01 00 E1 00` |

A successful InListPassiveTarget response (TFI `D5`, code `4B`) for a 4-byte-UID
Mifare Classic 1K looks like `D5 4B 01 01 00 04 08 04 <U0 U1 U2 U3>`; the UID is
`NFCID1`, `IDLen` bytes long. `NbTg == 0` means no card in the field.

## How the node works (runtime)

`crates/microflow-core/src/runtime/input/pn532.rs` drives the handshake sans-IO,
on two clocks:

- **`schedule_wakeup("_tick", …)` ticks** issue the next I2C operation (write a
  frame, or request a read), re-armed inside the handler like the `Interval` node.
- **`on_i2c_reply` deliveries** feed returned bytes into the state machine.

State machine (UID reader, ACK-skipping):

| State | Tick issues | On reply |
|-------|-------------|----------|
| `Start` | write SAMConfiguration | — |
| `SamSettle` | read (RDY + ACK) | — |
| `SamRead` | *(watchdog: resend SAM)* | any reply → write InListPassiveTarget |
| `PollIdle` | write InListPassiveTarget | — |
| `PollSettle` | read (RDY + response) | — |
| `PollRead` | *(watchdog: re-issue InListPassiveTarget)* | parse: card → **emit UID**; no card / not-ready → re-read (bounded); then a fresh cycle after `pollIntervalMs` |

Detection is one-shot: **every** cycle re-issues InListPassiveTarget (via
`PollIdle`), not just re-reads — otherwise a card is detected exactly once. Every
wait is a **short read + retry**, never a blocking "wait for the device"
read — so the module is never given a reason to clock-stretch for long. Frame
construction, both checksums, ACK/NACK/RDY recognition, and response parsing
(incl. 4- and 7-byte UIDs and a bad-checksum reject) are unit-tested in that file.

Replies are routed to the node by I2C address; a one-shot read carries register
`0`, which the node's listener matches (with the runtime's register-mismatch
fallback as a backstop).

## Limitations

- **Codegen (Arduino export) is not implemented.** The generated sketch falls back
  to a placeholder for this node — it runs live over Firmata but is omitted from a
  standalone Arduino export. (An `Adafruit_PN532`-based emitter is a possible
  follow-up; the blocking library call is simpler than the live async driver.)
- **UID only.** Reading/writing NDEF, Mifare blocks, or authentication is not
  supported.
- **Hardware-unverified timing.** The clock-stretch mitigation (RDY-poll, short
  reads) is designed but has not been confirmed on a physical board. On a classic
  AVR (`Wire` has no clock-stretch timeout) a misbehaving device can wedge the
  whole I2C bus — the same failure mode as the SHT21 hold-master read. Bench-test
  before relying on it in a multi-device flow.
