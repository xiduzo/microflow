//! Test-mode replacement for the **Board IO Loop**.
//!
//! Constructed via `BoardHandle::test_pair()`. Drains the same `BoardCommand`
//! channel as the production IO loop but, instead of running a `BoardConnection`,
//! records each command and lets the test script its outcome.
//!
//! This is the second adapter at the `BoardCommand` seam (production IO loop is
//! the first), which is what makes the seam a real seam rather than a
//! hypothetical one. Tests can now assert what was sent over the wire, and
//! drive Components through both success and failure paths without hardware.

use super::handle::BoardHandle;
use super::protocol::BoardCommand;
use crate::error::HardwareError;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

/// Records `BoardCommand`s sent by a `BoardHandle` and lets tests script
/// outcomes. See module docs.
pub struct TestIoLoop {
    cmd_rx: mpsc::Receiver<BoardCommand>,
    #[allow(dead_code)]
    handle: Arc<BoardHandle>,
    /// Commands received but not yet replied to, in arrival order.
    pending: Mutex<Vec<BoardCommand>>,
}

impl TestIoLoop {
    pub(super) fn new(
        cmd_rx: mpsc::Receiver<BoardCommand>,
        handle: Arc<BoardHandle>,
    ) -> Self {
        Self {
            cmd_rx,
            handle,
            pending: Mutex::new(Vec::new()),
        }
    }

    /// Pull any newly-arrived commands into `pending`. Returns count drained.
    /// Called automatically by every assertion / take method.
    pub fn drain(&self) -> usize {
        let mut pending = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut count = 0;
        while let Ok(cmd) = self.cmd_rx.try_recv() {
            pending.push(cmd);
            count += 1;
        }
        count
    }

    /// Number of pending commands awaiting a reply.
    pub fn pending_count(&self) -> usize {
        self.drain();
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    /// Take the next pending command for pattern-matching. The test is then
    /// responsible for sending an outcome via the command's `reply` field
    /// (or dropping it, which resolves the receipt to `Disconnected`).
    pub fn take_next(&self) -> Option<BoardCommand> {
        self.drain();
        let mut pending = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending.is_empty() {
            None
        } else {
            Some(pending.remove(0))
        }
    }

    /// Complete the oldest pending command with the given outcome.
    /// Panics if no command is pending — drains first so a fresh send is visible.
    pub fn complete_next(&self, outcome: Result<(), HardwareError>) {
        let cmd = self
            .take_next()
            .expect("TestIoLoop::complete_next called with no pending commands");
        send_reply(cmd, outcome);
    }

    /// Drain all pending commands and reply `Ok(())` to each. Useful when a
    /// test does not care about individual outcomes.
    pub fn complete_all_ok(&self) {
        self.drain();
        let mut pending = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        for cmd in pending.drain(..) {
            send_reply(cmd, Ok(()));
        }
    }
}

/// Send the outcome on a `BoardCommand`'s reply channel and discard the command.
/// `Stop` has no reply; silently drop.
fn send_reply(cmd: BoardCommand, outcome: Result<(), HardwareError>) {
    match cmd {
        BoardCommand::SetPinMode { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::DigitalWrite { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::AnalogWrite { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::EnableAnalogReporting { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::DisableAnalogReporting { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::EnableDigitalReporting { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::DisableDigitalReporting { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::ResetAllReporting { reply } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::ShiftOut { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::Tone { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::NoTone { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::Sysex { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::I2cConfig { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::I2cRead { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::I2cWrite { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::I2cStopReading { reply, .. } => {
            let _ = reply.send(outcome);
        }
        BoardCommand::Stop => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_digital_write_at_the_wire() {
        let (board, io_loop) = BoardHandle::test_pair();
        let receipt = board.digital_write(13, true);

        let cmd = io_loop
            .take_next()
            .expect("digital_write should arrive on the wire");
        match cmd {
            BoardCommand::DigitalWrite { pin, value, reply } => {
                assert_eq!(pin, 13);
                assert!(value);
                let _ = reply.send(Ok(()));
            }
            _ => panic!("expected DigitalWrite"),
        }
        assert!(receipt.wait().is_ok());
    }

    #[test]
    fn scripted_failure_propagates_to_receipt() {
        let (board, io_loop) = BoardHandle::test_pair();
        let receipt = board.digital_write(13, true);

        io_loop.complete_next(Err(HardwareError::FirmataCommunication(
            "scripted failure".to_string(),
        )));

        let err = receipt.wait().expect_err("scripted failure");
        assert!(err.to_string().contains("scripted failure"));
    }

    #[test]
    fn dropped_command_resolves_receipt_to_disconnected() {
        let (board, io_loop) = BoardHandle::test_pair();
        let receipt = board.digital_write(13, true);

        // Take the command without replying, then drop it — simulates the IO
        // loop shutting down mid-flight.
        let cmd = io_loop.take_next().expect("command should be pending");
        drop(cmd);

        assert!(matches!(receipt.wait(), Err(HardwareError::Disconnected)));
    }

    #[test]
    fn complete_all_ok_drains_pending() {
        let (board, io_loop) = BoardHandle::test_pair();
        let r1 = board.digital_write(13, true);
        let r2 = board.digital_write(14, false);
        let r3 = board.analog_write(9, 128);

        assert_eq!(io_loop.pending_count(), 3);
        io_loop.complete_all_ok();
        assert_eq!(io_loop.pending_count(), 0);
        assert!(r1.wait().is_ok());
        assert!(r2.wait().is_ok());
        assert!(r3.wait().is_ok());
    }
}
