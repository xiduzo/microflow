//! Sans-IO flasher driver framework.
//!
//! A [`FlashDriver`] is a bootloader-protocol state machine with the transport
//! removed: it does no I/O, no sleeping, no port handling. Instead it emits
//! [`FlashStep`]s telling an executor what to do (toggle reset lines, write
//! bytes, read N bytes, sleep, …) and is fed the result of each step via
//! [`FlashDriver::advance`].
//!
//! This is what makes browser flashing possible: the desktop runs the steps
//! against `serialport` (blocking), the browser runs them against the Web
//! Serial API (async) — but the protocol logic (sync handshakes, page
//! programming, packet framing/checksums) lives here once, shared by both.
//!
//! The steps are serde-serializable so the wasm wrapper can hand them to the JS
//! executor as JSON.

use serde::Serialize;

/// One action the executor must perform on the serial transport.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FlashStep {
    /// Set the DTR/RTS control lines, then hold for `delay_ms` (board reset).
    Reset { dtr: bool, rts: bool, delay_ms: u32 },
    /// Reopen the port at this baud rate (close + reopen).
    SetBaud { baud: u32 },
    /// Discard any buffered input bytes.
    FlushInput,
    /// Write `write` (if non-empty), then read exactly `read_len` bytes (0 ⇒
    /// write only). The bytes read are passed back via [`FlashDriver::advance`];
    /// fewer than `read_len` bytes means the read timed out.
    Transact {
        write: Vec<u8>,
        read_len: usize,
        timeout_ms: u32,
    },
    /// Sleep for `ms` milliseconds.
    Delay { ms: u32 },
    /// Close the port, wait `wait_ms`, then re-acquire the (possibly
    /// re-enumerated) bootloader port and open it at `baud`. Used by AVR109's
    /// 1200-baud-touch reset, where the bootloader appears as a new USB device.
    ReacquirePort { wait_ms: u32, baud: u32 },
    /// Progress: `done` of `total` pages programmed.
    Progress { done: u32, total: u32 },
    /// Flashing finished successfully.
    Done,
    /// Fatal error; flashing cannot continue.
    Error { message: String },
}

/// A bootloader-protocol state machine driven by an external transport executor.
pub trait FlashDriver {
    /// The first step. Call once, before any [`advance`](FlashDriver::advance).
    fn start(&mut self) -> FlashStep;

    /// Provide the result of the previous step — the bytes read for a
    /// [`FlashStep::Transact`], or an empty slice for steps that read nothing —
    /// and get the next step.
    fn advance(&mut self, input: &[u8]) -> FlashStep;
}
