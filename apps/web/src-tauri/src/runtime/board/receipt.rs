//! Outcome handles for **BoardHandle** write methods.
//!
//! Every typed write method on `BoardHandle` returns a [`CommandReceipt`]. The
//! receipt resolves after the **Board IO Loop** has run the underlying
//! `BoardConnection` call and reported the result on a oneshot.
//!
//! Three consume methods cover sync, async, and fire-and-forget callers:
//! - [`CommandReceipt::wait`] — sync, blocks the current thread. Used by tests
//!   and rare sync callers. Works without an active Tokio runtime.
//! - [`CommandReceipt::into_future`] — async, `.await` from Tauri commands.
//! - [`CommandReceipt::ignore`] — drops the receipt, making fire-and-forget
//!   intent visible at the call site (hot-path **Component** writes).
//!
//! Resolution semantics:
//! - `Ok(())` — wire write succeeded.
//! - `Err(HardwareError::*)` — `BoardConnection` returned an error.
//! - `Err(HardwareError::Disconnected)` — IO loop shut down before processing.

use crate::error::HardwareError;
use std::time::Instant;
use tokio::sync::oneshot;

/// Outcome handle returned by every `BoardHandle` write method.
///
/// See module docs for usage patterns.
#[must_use = "fire-and-forget writes should call `.ignore()` to make intent explicit"]
pub struct CommandReceipt {
    rx: oneshot::Receiver<Result<(), HardwareError>>,
}

impl CommandReceipt {
    pub(super) fn new(rx: oneshot::Receiver<Result<(), HardwareError>>) -> Self {
        Self { rx }
    }

    /// Block the current thread until the outcome arrives. Safe to call from
    /// any thread, including ones with no Tokio runtime context.
    pub fn wait(self) -> Result<(), HardwareError> {
        self.rx
            .blocking_recv()
            .unwrap_or(Err(HardwareError::Disconnected))
    }

    /// Consume into an async future. `.await` from Tauri commands or any
    /// async context.
    pub async fn into_future(self) -> Result<(), HardwareError> {
        self.rx
            .await
            .unwrap_or(Err(HardwareError::Disconnected))
    }

    /// Drop the receipt without consuming the outcome. Makes fire-and-forget
    /// intent visible at call sites that genuinely do not need the result
    /// (hot-path component writes). The IO loop still runs the command — the
    /// outcome is simply not surfaced to the caller.
    pub fn ignore(self) {
        // self is consumed and dropped here; oneshot::Receiver drop is cheap.
    }

    /// Non-blocking peek. `None` means the IO loop has not yet processed the
    /// command. `Some(Err(Disconnected))` means the IO loop dropped its sender
    /// without sending an outcome.
    pub fn try_now(&mut self) -> Option<Result<(), HardwareError>> {
        match self.rx.try_recv() {
            Ok(result) => Some(result),
            Err(oneshot::error::TryRecvError::Empty) => None,
            Err(oneshot::error::TryRecvError::Closed) => Some(Err(HardwareError::Disconnected)),
        }
    }
}

/// Point-in-time read of a pin's cached value from the **BoardHandle**.
///
/// Returned by `BoardHandle::pin_snapshot`. Carries enough context for callers
/// to distinguish "fresh, board live" from "last known, board gone" without
/// consulting a separate `is_connected()` check.
#[derive(Debug, Clone, Copy)]
pub struct PinSnapshot {
    /// Last value the **BoardConnection** observed for this pin.
    pub value: u16,
    /// When the value was captured by the IO loop (not when the snapshot was read).
    pub captured_at: Instant,
    /// Whether the board is connected *right now* (read-time, not capture-time).
    /// `false` means the value is stale; the board was disconnected before the read.
    pub board_connected: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropped_sender_resolves_to_disconnected_via_wait() {
        let (tx, rx) = oneshot::channel::<Result<(), HardwareError>>();
        drop(tx);
        let receipt = CommandReceipt::new(rx);
        assert!(matches!(receipt.wait(), Err(HardwareError::Disconnected)));
    }

    #[test]
    fn wait_returns_outcome_sent_by_io_loop() {
        let (tx, rx) = oneshot::channel();
        let receipt = CommandReceipt::new(rx);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(10));
            let _ = tx.send(Ok(()));
        });
        assert!(receipt.wait().is_ok());
    }

    #[test]
    fn try_now_returns_none_before_resolution() {
        let (_tx, rx) = oneshot::channel::<Result<(), HardwareError>>();
        let mut receipt = CommandReceipt::new(rx);
        assert!(receipt.try_now().is_none());
    }

    #[test]
    fn try_now_returns_disconnected_when_sender_dropped() {
        let (tx, rx) = oneshot::channel::<Result<(), HardwareError>>();
        drop(tx);
        let mut receipt = CommandReceipt::new(rx);
        assert!(matches!(
            receipt.try_now(),
            Some(Err(HardwareError::Disconnected))
        ));
    }
}
