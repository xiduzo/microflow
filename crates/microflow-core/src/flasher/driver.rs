//! Sans-IO flasher driver framework.
//!
//! A [`FlashDriver`] is a bootloader-protocol state machine with the transport
//! removed: it does no I/O, no sleeping, no port handling. Instead it emits
//! [`FlashStep`]s telling an executor what to do (toggle reset lines, write
//! bytes, read N bytes, sleep, …) and is fed the result of each step via
//! [`FlashDriver::advance`].
//!
//! Two executors run the steps: the desktop against `serialport` (blocking),
//! the browser against the Web Serial API (async). The protocol logic (sync
//! handshakes, page programming, packet framing and checksums, retries and
//! timeouts) lives here once, shared by both.
//!
//! The steps are serde-serializable so the wasm wrapper can hand them to the JS
//! executor as JSON.
//!
//! # What an executor must do
//!
//! - Run every step in order and pass each [`FlashStep::Transact`]'s bytes back
//!   through [`FlashDriver::advance`] (an empty slice for every other step).
//! - Discard buffered input at the start of every `Transact`, unless it says
//!   `keep_input`: a bootloader answers a command and says nothing else, so
//!   anything already buffered is stale. Both executors do so even when the
//!   `Transact` writes nothing.
//! - Leave the input alone at the start of a `Transact` that says
//!   `keep_input`: it reads on from where the last one stopped, bytes that
//!   came in between two of them included. A driver asks for that where an
//!   answer may still be on its way when the next bytes go out (a board just
//!   reset is asked again and again, and a slow link delivers the answers
//!   late), and tells a late answer from the one it waits for itself.
//! - Time a `Transact`'s read with one deadline for the whole step:
//!   `timeout_ms` after its bytes were written, however many reads it takes
//!   and however the bytes trickle in (see [`FlashStep::Transact`]). The
//!   drivers' bounds on how long a flash can take rest on it.
//! - Report a read that came up short as the bytes that did arrive. The driver
//!   decides whether that is a retry or the end.
//! - Close the port before opening it again ([`FlashStep::SetBaud`],
//!   [`FlashStep::ReacquirePort`]).

use super::FlashError;
use serde::Serialize;
use ts_rs::TS;

/// One action the executor must perform on the serial transport.
///
/// `rename_all` camelCases the variant tags (`reset`, `setBaud`, …); the
/// separate `rename_all_fields` is essential — it camelCases the *fields inside*
/// the struct variants (`delay_ms` → `delayMs`, `read_len` → `readLen`, …). Without
/// it those multi-word fields serialize `snake_case` and arrive `undefined` in the
/// JS executor (which reads `delayMs`/`readLen`/`timeoutMs`/`keepInput`/`waitMs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FlashStep {
    /// Set the DTR/RTS control lines, then hold for `delay_ms` (board reset).
    Reset { dtr: bool, rts: bool, delay_ms: u32 },
    /// Reopen the port at this baud rate (close + reopen).
    SetBaud { baud: u32 },
    /// Discard any buffered input bytes. No driver emits this: a `Transact`
    /// discards unless it keeps its input. Executors carry it out all the same.
    FlushInput,
    /// Discard buffered input (unless `keep_input`), write `write` (if
    /// non-empty), then read until `read_len` bytes are in or `timeout_ms`
    /// has passed since the write, whichever comes first (0 ⇒ write only).
    /// `timeout_ms` is one deadline for the whole step, not a wait per read:
    /// bytes that come in do not extend it. The bytes read are passed back
    /// via [`FlashDriver::advance`]; fewer than `read_len` bytes means the
    /// deadline passed.
    Transact {
        write: Vec<u8>,
        read_len: usize,
        /// How long after the write the step's read may last, in all.
        timeout_ms: u32,
        /// Read on in the input as it is, instead of discarding it first.
        keep_input: bool,
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
    /// Fatal error; flashing cannot continue. On the wire it is the error's
    /// text (`message`), which a host shows to the user as it is.
    Error {
        #[serde(rename = "message")]
        #[ts(type = "string")]
        error: FlashError,
    },
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The JS executor reads camelCase fields. Variant-level `rename_all` does
    /// not touch struct-variant fields, so multi-word fields must be camelCased
    /// by `rename_all_fields`; otherwise they serialize `snake_case` and the
    /// executor sees `undefined` (no reset delay, instant empty reads — sync
    /// fails with "0 bytes"). Guards against a silent regression of that bug.
    #[test]
    fn steps_serialize_camelcase_fields_for_the_js_executor() {
        let reset =
            serde_json::to_string(&FlashStep::Reset { dtr: true, rts: false, delay_ms: 250 }).unwrap();
        assert!(reset.contains("\"kind\":\"reset\""), "tag: {reset}");
        assert!(reset.contains("\"delayMs\":250"), "delayMs: {reset}");

        let transact = serde_json::to_string(&FlashStep::Transact {
            write: vec![0x30, 0x20],
            read_len: 2,
            timeout_ms: 500,
            keep_input: true,
        })
        .unwrap();
        assert!(transact.contains("\"readLen\":2"), "readLen: {transact}");
        assert!(transact.contains("\"timeoutMs\":500"), "timeoutMs: {transact}");
        assert!(transact.contains("\"keepInput\":true"), "keepInput: {transact}");

        let reacquire =
            serde_json::to_string(&FlashStep::ReacquirePort { wait_ms: 1000, baud: 57600 }).unwrap();
        assert!(reacquire.contains("\"waitMs\":1000"), "waitMs: {reacquire}");
    }
}
