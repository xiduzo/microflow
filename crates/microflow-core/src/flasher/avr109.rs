//! Sans-IO AVR109 driver (Leonardo, Micro). A port of the desktop blocking
//! flasher: a "1200-baud touch" resets the board into its bootloader, which
//! re-enumerates as a new USB device; then sync ("CATERIN"), chip erase,
//! sequential block programming, and exit.
//!
//! The re-enumeration is expressed as a [`FlashStep::ReacquirePort`] — trivial
//! on the desktop (the OS re-lists the port), but in the browser the bootloader
//! appears as a *new* Web Serial device that may need the user to re-pick it.
//! The executor handles that; the protocol logic here is identical to desktop.

use super::driver::{FlashDriver, FlashStep};
use super::BoardConfig;

const EXPECT_CR: u8 = 0x0D;
const BLOCK_SIZE: usize = 128;
const TRANSACT_TIMEOUT_MS: u32 = 2000;
const MAX_SYNC_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    AfterSetBaud,
    AfterReset,
    AfterReacquire,
    Settle,
    Sync,
    Erase,
    SetAddr,
    ProgBlock,
    Progress,
    Exit,
    Done,
}

pub struct Avr109Driver {
    flash: Vec<u8>,
    boot_baud: u32,
    phase: Phase,
    sync_attempt: u32,
    block_index: usize,
    total_blocks: usize,
}

impl Avr109Driver {
    #[must_use]
    pub fn new(flash: Vec<u8>, config: &BoardConfig) -> Self {
        let total_blocks = flash.len().div_ceil(BLOCK_SIZE);
        Self {
            flash,
            boot_baud: config.baud_rate,
            phase: Phase::AfterSetBaud,
            sync_attempt: 0,
            block_index: 0,
            total_blocks,
        }
    }

    fn sync_step() -> FlashStep {
        FlashStep::Transact { write: vec![b'S'], read_len: 7, timeout_ms: TRANSACT_TIMEOUT_MS }
    }

    fn block_step(&self) -> FlashStep {
        let start = self.block_index * BLOCK_SIZE;
        let end = (start + BLOCK_SIZE).min(self.flash.len());
        let chunk = &self.flash[start..end];
        let len = chunk.len();
        let mut write = Vec::with_capacity(4 + len);
        write.push(b'B');
        write.push(((len >> 8) & 0xFF) as u8);
        write.push((len & 0xFF) as u8);
        write.push(b'F');
        write.extend_from_slice(chunk);
        FlashStep::Transact { write, read_len: 1, timeout_ms: TRANSACT_TIMEOUT_MS }
    }

    fn begin_blocks(&mut self) -> FlashStep {
        if self.total_blocks == 0 {
            self.phase = Phase::Exit;
            return FlashStep::Transact { write: vec![b'E'], read_len: 0, timeout_ms: TRANSACT_TIMEOUT_MS };
        }
        self.block_index = 0;
        self.phase = Phase::ProgBlock;
        self.block_step()
    }

    fn fail(&mut self, message: &str) -> FlashStep {
        self.phase = Phase::Done;
        FlashStep::Error { message: message.into() }
    }
}

/// True when the sync reply contains the Caterina bootloader identifier.
fn is_caterina(resp: &[u8]) -> bool {
    String::from_utf8_lossy(resp).contains("CATER")
}

impl FlashDriver for Avr109Driver {
    fn start(&mut self) -> FlashStep {
        // Open at 1200 baud — the "touch" that triggers the bootloader.
        self.phase = Phase::AfterSetBaud;
        FlashStep::SetBaud { baud: 1200 }
    }

    fn advance(&mut self, input: &[u8]) -> FlashStep {
        match self.phase {
            Phase::AfterSetBaud => {
                // DTR low triggers the reset into the bootloader.
                self.phase = Phase::AfterReset;
                FlashStep::Reset { dtr: false, rts: false, delay_ms: 250 }
            }
            Phase::AfterReset => {
                // Close, wait, and re-acquire the re-enumerated bootloader port.
                self.phase = Phase::AfterReacquire;
                FlashStep::ReacquirePort { wait_ms: 500, baud: self.boot_baud }
            }
            Phase::AfterReacquire => {
                self.phase = Phase::Settle;
                FlashStep::Delay { ms: 200 }
            }
            Phase::Settle => {
                self.sync_attempt = 0;
                self.phase = Phase::Sync;
                Self::sync_step()
            }
            Phase::Sync => {
                if is_caterina(input) {
                    self.phase = Phase::Erase;
                    FlashStep::Transact { write: vec![b'e'], read_len: 1, timeout_ms: TRANSACT_TIMEOUT_MS }
                } else {
                    self.sync_attempt += 1;
                    if self.sync_attempt < MAX_SYNC_ATTEMPTS {
                        Self::sync_step()
                    } else {
                        self.fail("Failed to sync with the AVR109 bootloader")
                    }
                }
            }
            Phase::Erase => {
                if input.first() == Some(&EXPECT_CR) {
                    // Set the word address to 0; the bootloader auto-increments.
                    self.phase = Phase::SetAddr;
                    FlashStep::Transact { write: vec![b'A', 0, 0], read_len: 1, timeout_ms: TRANSACT_TIMEOUT_MS }
                } else {
                    self.fail("Chip erase failed")
                }
            }
            Phase::SetAddr => {
                if input.first() == Some(&EXPECT_CR) {
                    self.begin_blocks()
                } else {
                    self.fail("Failed to set flash address")
                }
            }
            Phase::ProgBlock => {
                if input.first() == Some(&EXPECT_CR) {
                    self.phase = Phase::Progress;
                    FlashStep::Progress {
                        done: (self.block_index + 1) as u32,
                        total: self.total_blocks as u32,
                    }
                } else {
                    self.fail(&format!("Block {} write failed", self.block_index))
                }
            }
            Phase::Progress => {
                self.block_index += 1;
                if self.block_index < self.total_blocks {
                    self.phase = Phase::ProgBlock;
                    self.block_step()
                } else {
                    self.phase = Phase::Exit;
                    // 'E' exits the bootloader and starts the application; no reply.
                    FlashStep::Transact { write: vec![b'E'], read_len: 0, timeout_ms: TRANSACT_TIMEOUT_MS }
                }
            }
            Phase::Exit => {
                self.phase = Phase::Done;
                FlashStep::Done
            }
            Phase::Done => FlashStep::Done,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flasher::BoardType;

    #[test]
    fn happy_path_syncs_erases_and_programs_every_block() {
        // 300 bytes over 128-byte blocks => 3 blocks.
        let flash = vec![0x5Au8; 300];
        let config = BoardConfig::find(BoardType::Leonardo);
        let mut d = Avr109Driver::new(flash, &config);

        let mut step = d.start();
        let (mut syncs, mut erases, mut blocks, mut exits) = (0, 0, 0, 0);
        let mut guard = 0;
        loop {
            guard += 1;
            assert!(guard < 200, "driver did not terminate");
            step = match &step {
                FlashStep::Done => break,
                FlashStep::Error { message } => panic!("unexpected error: {message}"),
                FlashStep::Transact { write, read_len, .. } => {
                    let reply: Vec<u8> = match write.first() {
                        Some(&b'S') => {
                            syncs += 1;
                            b"CATERIN".to_vec()
                        }
                        Some(&b'e') => {
                            erases += 1;
                            vec![EXPECT_CR]
                        }
                        Some(&b'A') => vec![EXPECT_CR],
                        Some(&b'B') => {
                            blocks += 1;
                            vec![EXPECT_CR]
                        }
                        Some(&b'E') => {
                            exits += 1;
                            Vec::new()
                        }
                        other => panic!("unexpected avr109 command: {other:?}"),
                    };
                    // 'E' reads nothing; others read exactly one byte (sync: 7).
                    assert!(reply.len() >= *read_len || *read_len == 0 || write.first() == Some(&b'S'));
                    d.advance(&reply)
                }
                _ => d.advance(&[]),
            };
        }
        assert_eq!(syncs, 1);
        assert_eq!(erases, 1);
        assert_eq!(blocks, 3, "one block write per 128-byte block");
        assert_eq!(exits, 1);
    }
}
