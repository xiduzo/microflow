//! Sans-IO AVR109 driver (Leonardo, Micro), as the Caterina bootloader speaks
//! it: a "1200-baud touch" resets the board into its bootloader, which
//! re-enumerates as a new USB device; then sync ("CATERIN"), chip erase,
//! sequential block programming, and exit.
//!
//! The re-enumeration is a [`FlashStep::ReacquirePort`]: how the bootloader's
//! port is found again is the executor's business (the desktop polls the OS
//! port list, the browser picks among the granted Web Serial ports).

use super::driver::{FlashDriver, FlashStep};
use super::{word_aligned, BoardConfig, FlashError};

// The cadence, from `Caterina.c`. The bootloader runs for 8 s
// (`TIMEOUT_PERIOD`) from its start, and only a block write restarts that
// clock: identify, erase and the first block must all happen inside it. The
// host gets here 1 to 4 s in (USB enumeration, then the executor's search for
// the port), and the erase takes about 2 s. Over USB an answer takes
// milliseconds, so the 2 s wait is ample; of the five identify attempts, the
// ones 0, 2 and 4 s after the first can still be followed by the erase and a
// block in time.
//
// The driver listens from the first identify to 10 s after it without
// discarding anything, and the answer to any of them ends the phase, whenever
// in that time it comes in. The bootloader answers every identify it gets, so
// as many more identifiers as identifies were repeated can follow that
// answer. They come in before the answer to the erase and are read past
// there: the erase is answered with a carriage return, which no identifier
// starts with.

const EXPECT_CR: u8 = 0x0D;
/// What every Caterina's identifier starts with.
const IDENTIFIER_START: &[u8] = b"CATER";
/// AVR109's answer to `S`: seven characters (Caterina's are `CATERIN`).
const IDENTIFIER_LEN: usize = 7;
const BLOCK_SIZE: usize = 128;
const TRANSACT_TIMEOUT_MS: u32 = 2000;
/// The chip erase is answered only once every application page is erased and
/// rewritten: 224 pages at 3.7 to 4.5 ms, twice, is 1.7 to 2.0 s on an
/// `ATmega32U4` before the answer even sets off.
const ERASE_TIMEOUT_MS: u32 = 5000;
/// How long the port stays open after `E`, so the command is on the wire
/// before the port closes. A bootloader that never gets it waits out its 8 s
/// timeout before it starts the sketch.
const EXIT_HOLD_MS: u32 = 100;
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
    ExitHold,
    Done,
}

pub struct Avr109Driver {
    flash: Vec<u8>,
    boot_baud: u32,
    phase: Phase,
    sync_attempt: u32,
    block_index: usize,
    total_blocks: usize,
    /// Input read since the first identify and not yet made sense of.
    rx: Vec<u8>,
    /// Bytes the last step asked for; fewer came in if its read timed out.
    asked: usize,
    /// Answers to repeated identifies that can still come in.
    late_identifiers: u32,
}

impl Avr109Driver {
    #[must_use]
    pub fn new(flash: Vec<u8>, config: &BoardConfig) -> Self {
        let flash = word_aligned(flash);
        let total_blocks = flash.len().div_ceil(BLOCK_SIZE);
        Self {
            flash,
            boot_baud: config.baud_rate,
            phase: Phase::AfterSetBaud,
            sync_attempt: 0,
            block_index: 0,
            total_blocks,
            rx: Vec::new(),
            asked: 0,
            late_identifiers: 0,
        }
    }

    /// A step that reads `read_len` bytes, remembering how many it asked for.
    fn read(&mut self, write: Vec<u8>, read_len: usize, timeout_ms: u32, keep_input: bool) -> FlashStep {
        self.asked = read_len;
        FlashStep::Transact { write, read_len, timeout_ms, keep_input }
    }

    /// Ask the bootloader to identify itself. The first time discards what
    /// is in the input; the ones after it keep what came in since.
    fn identify(&mut self) -> FlashStep {
        let first = self.sync_attempt == 0;
        if first {
            self.rx.clear();
        }
        self.phase = Phase::Sync;
        let missing = self.identifier_missing();
        self.read(vec![b'S'], missing, TRANSACT_TIMEOUT_MS, !first)
    }

    /// How many bytes an identifier still takes. What cannot be part of one
    /// is read past.
    fn identifier_missing(&mut self) -> usize {
        // The identifier, or as much of its start as the input ends with.
        let at = (0..self.rx.len())
            .find(|&at| {
                let tail = &self.rx[at..];
                tail.starts_with(IDENTIFIER_START) || IDENTIFIER_START.starts_with(tail)
            })
            .unwrap_or(self.rx.len());
        self.rx.drain(..at);
        IDENTIFIER_LEN.saturating_sub(self.rx.len())
    }

    /// The step after `input` came in for an identify.
    fn on_identify_input(&mut self, input: &[u8]) -> FlashStep {
        self.rx.extend_from_slice(input);
        if self.identifier_missing() > 0 {
            self.sync_attempt += 1;
            if self.sync_attempt < MAX_SYNC_ATTEMPTS {
                return self.identify();
            }
            return self.fail(FlashError::SyncFailed);
        }
        self.rx.drain(..IDENTIFIER_LEN);
        // The bootloader may have got every identify before this one too.
        self.late_identifiers = self.sync_attempt;
        self.phase = Phase::Erase;
        self.read(vec![b'e'], 1, ERASE_TIMEOUT_MS, true)
    }

    /// The step after `input` came in for the chip erase.
    fn on_erase_input(&mut self, input: &[u8]) -> FlashStep {
        let timed_out = input.len() < self.asked;
        self.rx.extend_from_slice(input);
        // An answer to an earlier identify.
        while self.late_identifiers > 0
            && self.rx.len() >= IDENTIFIER_LEN
            && self.rx.starts_with(IDENTIFIER_START)
        {
            self.rx.drain(..IDENTIFIER_LEN);
            self.late_identifiers -= 1;
        }
        // The start of one more.
        let late_identifier = self.late_identifiers > 0
            && !self.rx.is_empty()
            && (self.rx.starts_with(IDENTIFIER_START) || IDENTIFIER_START.starts_with(&self.rx));
        if late_identifier && !timed_out {
            // The rest of it, and then the erase's own answer.
            let missing = IDENTIFIER_LEN - self.rx.len() + 1;
            return self.read(Vec::new(), missing, ERASE_TIMEOUT_MS, true);
        }
        if std::mem::take(&mut self.rx).first() == Some(&EXPECT_CR) {
            // Set the word address to 0; the bootloader auto-increments.
            self.phase = Phase::SetAddr;
            command(vec![b'A', 0, 0], 1)
        } else {
            self.fail(FlashError::ProgramFailed("chip erase was not acknowledged".into()))
        }
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
        command(write, 1)
    }

    fn begin_blocks(&mut self) -> FlashStep {
        if self.total_blocks == 0 {
            self.phase = Phase::Exit;
            // Answered with a carriage return that is not waited for: see
            // the exit after the last block.
            return command(vec![b'E'], 0);
        }
        self.block_index = 0;
        self.phase = Phase::ProgBlock;
        self.block_step()
    }

    fn fail(&mut self, error: FlashError) -> FlashStep {
        self.phase = Phase::Done;
        FlashStep::Error { error }
    }
}

/// A command sent once nothing earlier can still be on its way: the input is
/// discarded, `write` goes out, and `read_len` bytes of answer are read.
fn command(write: Vec<u8>, read_len: usize) -> FlashStep {
    FlashStep::Transact { write, read_len, timeout_ms: TRANSACT_TIMEOUT_MS, keep_input: false }
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
                self.identify()
            }
            Phase::Sync => self.on_identify_input(input),
            Phase::Erase => self.on_erase_input(input),
            Phase::SetAddr => {
                if input.first() == Some(&EXPECT_CR) {
                    self.begin_blocks()
                } else {
                    self.fail(FlashError::ProgramFailed("Failed to set flash address".into()))
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
                    self.fail(FlashError::ProgramFailed(format!(
                        "block {} was not acknowledged",
                        self.block_index
                    )))
                }
            }
            Phase::Progress => {
                self.block_index += 1;
                if self.block_index < self.total_blocks {
                    self.phase = Phase::ProgBlock;
                    self.block_step()
                } else {
                    self.phase = Phase::Exit;
                    // 'E' exits the bootloader: Caterina answers it with a
                    // carriage return and starts the sketch about half a
                    // second later. Every block was acknowledged by then, so
                    // the answer is not waited for (and a lost one is not a
                    // failed flash); the port is held open a moment instead.
                    command(vec![b'E'], 0)
                }
            }
            Phase::Exit => {
                self.phase = Phase::ExitHold;
                FlashStep::Delay { ms: EXIT_HOLD_MS }
            }
            Phase::ExitHold => {
                self.phase = Phase::Done;
                FlashStep::Done
            }
            Phase::Done => FlashStep::Done,
        }
    }
}
