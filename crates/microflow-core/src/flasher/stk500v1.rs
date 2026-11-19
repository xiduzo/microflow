//! Sans-IO `STK500v1` driver (Uno, Nano), as Optiboot and the older
//! `ATmegaBOOT` speak it: reset, sync (with retries and a baud fallback, since
//! clones ship either bootloader), signature read, page programming, and
//! programming-mode exit.
//!
//! Every command ends in `CRC_EOP` and is answered `STK_INSYNC … STK_OK`.
//! Nothing in an answer says which command it answers, so the driver keeps
//! count: from the first sync after a reset to the answer to the signature
//! read it discards no input, and it reads past no more sync answers than it
//! repeated syncs.

use super::driver::{FlashDriver, FlashStep};
use super::{word_aligned, BoardConfig, FlashError};

const STK_OK: u8 = 0x10;
const STK_INSYNC: u8 = 0x14;
const CRC_EOP: u8 = 0x20;
const STK_GET_SYNC: u8 = 0x30;
const STK_ENTER_PROGMODE: u8 = 0x50;
const STK_LEAVE_PROGMODE: u8 = 0x51;
const STK_LOAD_ADDRESS: u8 = 0x55;
const STK_PROG_PAGE: u8 = 0x64;
const STK_READ_SIGN: u8 = 0x75;

/// The answer to a command that returns no data.
const IN_SYNC_OK: [u8; 2] = [STK_INSYNC, STK_OK];
/// The answer to the signature read: `INSYNC`, three signature bytes, `OK`.
const SIGNATURE_ANSWER_LEN: usize = 5;

/// Baud rates to try after the configured one (clones vary).
const FALLBACK_BAUDS: [u32; 3] = [57600, 115200, 19200];
// The sync cadence, from `optiboot.c` and `ATmegaBOOT_168.c`. Either chip
// comes out of reset about 70 ms after the reset edge.
//
// - Optiboot flashes its LED for 375 ms without reading (the UART keeps two
//   bytes meanwhile: exactly one sync), then answers; from then its 1 s
//   watchdog runs until a byte arrives. It hears a first byte up to about
//   1.45 s after the edge and answers the first sync about 0.45 s after it.
// - `ATmegaBOOT` (the `atmega328` build) flashes for 200 ms, then waits about
//   0.9 s for each byte: a first byte up to about 1.15 s after the edge.
//
// After that the sketch of such a board runs, and nothing can land until the
// next reset. A sync goes out every 550 ms from 100 ms after the edge: at 100,
// 650, 1200, … 3950 ms, three in the stock Optiboot's window, two (the third
// on its edge) in `ATmegaBOOT`'s. The period cannot be much shorter: Optiboot
// answers its first sync 350 ms after it was sent, and its UART keeps only
// that one while it flashes its LED.
//
// The driver listens from the first sync to 4500 ms after the edge without
// discarding anything, and the answer to any sync ends the phase, whenever in
// that time it comes in. A bootloader answers every sync it hears, so as many
// more `INSYNC OK` as syncs were repeated can follow that answer. They come
// in before the answer to the signature read and are read past there.
//
// There are eight attempts, the number the desktop app has always flashed
// boards with. The ones past the stock windows are for the boards whose
// bootloader is not one of those two builds, or that do not reset on time:
// Optiboot builds with a 2, 4 or 8 s watchdog, older bootloaders that wait
// several seconds, a board whose reset comes late (a weak or missing
// auto-reset capacitor, a slow USB-serial bridge), and a bootloader that
// heard an earlier sync without its answer getting through (every byte heard
// restarts its clock). They cost time only on a board that never answers:
// 4.75 s per baud.
//
// Bytes that are no sync answer (a sketch still printing, a bootloader at
// another baud rate) must not buy more time. The driver has no clock, so the
// bound is counted in waits. A wait asks for just the answer, and so ends as
// soon as it is in, until the first byte at this baud that is no answer. The
// attempt that byte came in for then listens on once, and from then on every
// wait at this baud reads its whole period: it asks for as many bytes as may
// be read past plus the answer, and ends when its time is up (the executor's
// one deadline per step) or when that many came in. That is one wait per sync
// and one listen-on per baud: a board that never answers is given up on after
// at most nine periods per baud, 5.3 s, whatever it prints and however it
// trickles in.

/// Sync attempts before falling back to the next baud rate.
const MAX_SYNC_ATTEMPTS: u32 = 8;
/// How long the answer to one sync is waited for before the next goes out.
const SYNC_PERIOD_MS: u32 = 550;
/// How many bytes that are no sync answer one wait reads past. A wait that
/// fills up with them ends its attempt: that is a sketch talking, or a
/// bootloader at another baud rate.
const MAX_SYNC_NOISE: usize = 64;
/// Wait for the answer to any other command. A page is written in under 30 ms.
const TRANSACT_TIMEOUT_MS: u32 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    ResetLow,
    ResetHigh,
    Settle,
    Sync,
    AfterSetBaud,
    Signature,
    EnterProgmode,
    LoadAddr,
    ProgPage,
    AfterPage,
    LeaveProgmode,
    Done,
}

pub struct Stk500v1Driver {
    flash: Vec<u8>,
    page_size: usize,
    bauds: Vec<u32>,
    baud_index: usize,
    sync_attempt: u32,
    page_index: usize,
    total_pages: usize,
    phase: Phase,
    /// Input read since the first sync after the reset and not yet made
    /// sense of.
    rx: Vec<u8>,
    /// Bytes the last step asked for; fewer came in if its read timed out.
    asked: usize,
    /// Bytes that are no sync answer came in since the first sync at this
    /// baud: every wait reads its whole period.
    noisy: bool,
    /// Answers to repeated syncs that can still come in.
    late_sync_answers: u32,
}

impl Stk500v1Driver {
    #[must_use]
    pub fn new(flash: Vec<u8>, config: &BoardConfig) -> Self {
        let flash = word_aligned(flash);
        let mut bauds = vec![config.baud_rate];
        for &b in &FALLBACK_BAUDS {
            if !bauds.contains(&b) {
                bauds.push(b);
            }
        }
        let page_size = config.page_size.max(1);
        let total_pages = flash.len().div_ceil(page_size);
        Self {
            flash,
            page_size,
            bauds,
            baud_index: 0,
            sync_attempt: 0,
            page_index: 0,
            total_pages,
            phase: Phase::ResetLow,
            rx: Vec::new(),
            asked: 0,
            noisy: false,
            late_sync_answers: 0,
        }
    }

    /// A step that reads `read_len` bytes, remembering how many it asked for.
    fn read(&mut self, write: Vec<u8>, read_len: usize, timeout_ms: u32, keep_input: bool) -> FlashStep {
        self.asked = read_len;
        FlashStep::Transact { write, read_len, timeout_ms, keep_input }
    }

    /// Send a sync. The first one after a reset discards what the reset left
    /// in the input; the ones after it keep what came in since.
    fn sync(&mut self) -> FlashStep {
        let first = self.sync_attempt == 0;
        if first {
            self.rx.clear();
            self.noisy = false;
        }
        self.phase = Phase::Sync;
        self.sync_wait(vec![STK_GET_SYNC, CRC_EOP], !first)
    }

    /// A wait for a sync answer, writing `write` first: for just the answer
    /// while the input has been quiet, else for the whole period.
    fn sync_wait(&mut self, write: Vec<u8>, keep_input: bool) -> FlashStep {
        let missing = IN_SYNC_OK.len() - self.rx.len();
        let read_len = if self.noisy { MAX_SYNC_NOISE + missing } else { missing };
        self.read(write, read_len, SYNC_PERIOD_MS, keep_input)
    }

    /// Whether a sync answer has come in. Whatever came before it is read
    /// past; a last byte that can be the first half of an answer stays.
    fn take_sync_answer(&mut self) -> bool {
        if let Some(at) = self.rx.windows(IN_SYNC_OK.len()).position(|pair| pair == IN_SYNC_OK) {
            self.rx.drain(..at + IN_SYNC_OK.len());
            return true;
        }
        let kept = usize::from(self.rx.last() == Some(&STK_INSYNC));
        self.rx.drain(..self.rx.len() - kept);
        false
    }

    /// The step after `input` came in for a sync.
    fn on_sync_input(&mut self, input: &[u8]) -> FlashStep {
        let timed_out = input.len() < self.asked;
        self.rx.extend_from_slice(input);
        if self.take_sync_answer() {
            // The bootloader may have heard every sync before this one too.
            self.late_sync_answers = self.sync_attempt;
            self.phase = Phase::Signature;
            self.read_past_late_sync_answers();
            let missing = SIGNATURE_ANSWER_LEN.saturating_sub(self.rx.len());
            self.read(vec![STK_READ_SIGN, CRC_EOP], missing, TRANSACT_TIMEOUT_MS, true)
        } else if timed_out || self.noisy {
            // The period is over, or a wait for all of it filled up with
            // bytes that are no answer.
            self.on_sync_failure()
        } else {
            // The first bytes at this baud that are no answer, and the period
            // is not over: listen on for the rest of it.
            self.noisy = true;
            self.sync_wait(Vec::new(), true)
        }
    }

    /// Read past answers to earlier syncs. No signature answer starts like
    /// one: the first signature byte of an AVR is its maker's, 0x1E.
    fn read_past_late_sync_answers(&mut self) {
        while self.late_sync_answers > 0 && self.rx.starts_with(&IN_SYNC_OK) {
            self.rx.drain(..IN_SYNC_OK.len());
            self.late_sync_answers -= 1;
        }
    }

    /// The step after `input` came in for the signature read: the last check
    /// before pages are erased.
    fn on_signature_input(&mut self, input: &[u8]) -> FlashStep {
        let timed_out = input.len() < self.asked;
        self.rx.extend_from_slice(input);
        self.read_past_late_sync_answers();
        if self.rx.len() < SIGNATURE_ANSWER_LEN && !timed_out {
            let missing = SIGNATURE_ANSWER_LEN - self.rx.len();
            return self.read(Vec::new(), missing, TRANSACT_TIMEOUT_MS, true);
        }
        // The reply must be framed as the protocol says. The signature's
        // value is informational; a mismatch is tolerated (clones report
        // other chips).
        let answer = std::mem::take(&mut self.rx);
        if answer.len() < SIGNATURE_ANSWER_LEN || answer[0] != STK_INSYNC {
            return self.fail(FlashError::Communication(format!(
                "Invalid signature response: {answer:02X?}"
            )));
        }
        if answer[SIGNATURE_ANSWER_LEN - 1] != STK_OK {
            return self.fail(FlashError::Communication("Signature read not OK".into()));
        }
        self.phase = Phase::EnterProgmode;
        command(vec![STK_ENTER_PROGMODE, CRC_EOP])
    }

    fn load_address_step(&self) -> FlashStep {
        let address = (self.page_index * self.page_size) as u32;
        let word_addr = (address / 2) as u16;
        command(vec![
            STK_LOAD_ADDRESS,
            (word_addr & 0xFF) as u8,
            ((word_addr >> 8) & 0xFF) as u8,
            CRC_EOP,
        ])
    }

    fn prog_page_step(&self) -> FlashStep {
        let start = self.page_index * self.page_size;
        let end = (start + self.page_size).min(self.flash.len());
        let chunk = &self.flash[start..end];
        let len = chunk.len();
        let mut write = Vec::with_capacity(4 + len + 1);
        write.push(STK_PROG_PAGE);
        write.push(((len >> 8) & 0xFF) as u8);
        write.push((len & 0xFF) as u8);
        write.push(b'F');
        write.extend_from_slice(chunk);
        write.push(CRC_EOP);
        command(write)
    }

    fn begin_program(&mut self) -> FlashStep {
        if self.total_pages == 0 {
            self.phase = Phase::LeaveProgmode;
            return command(vec![STK_LEAVE_PROGMODE, CRC_EOP]);
        }
        self.page_index = 0;
        self.phase = Phase::LoadAddr;
        self.load_address_step()
    }

    /// Sync failed at the current baud — retry, or fall back to the next baud,
    /// or give up.
    fn on_sync_failure(&mut self) -> FlashStep {
        self.sync_attempt += 1;
        if self.sync_attempt < MAX_SYNC_ATTEMPTS {
            return self.sync();
        }
        self.baud_index += 1;
        if self.baud_index < self.bauds.len() {
            self.sync_attempt = 0;
            self.phase = Phase::AfterSetBaud;
            FlashStep::SetBaud { baud: self.bauds[self.baud_index] }
        } else {
            self.fail(FlashError::SyncFailed)
        }
    }

    fn fail(&mut self, error: FlashError) -> FlashStep {
        self.phase = Phase::Done;
        FlashStep::Error { error }
    }
}

/// A command answered `INSYNC OK`, sent once nothing earlier can still be on
/// its way: the input is discarded, then `write` goes out.
fn command(write: Vec<u8>) -> FlashStep {
    FlashStep::Transact {
        write,
        read_len: IN_SYNC_OK.len(),
        timeout_ms: TRANSACT_TIMEOUT_MS,
        keep_input: false,
    }
}

/// True when a 2-byte reply is the bootloader's `INSYNC` + `OK` acknowledgement.
fn is_ok(resp: &[u8]) -> bool {
    resp.starts_with(&IN_SYNC_OK)
}

impl FlashDriver for Stk500v1Driver {
    fn start(&mut self) -> FlashStep {
        self.phase = Phase::ResetLow;
        FlashStep::Reset { dtr: false, rts: false, delay_ms: 250 }
    }

    fn advance(&mut self, input: &[u8]) -> FlashStep {
        match self.phase {
            Phase::ResetLow => {
                self.phase = Phase::ResetHigh;
                FlashStep::Reset { dtr: true, rts: true, delay_ms: 50 }
            }
            Phase::ResetHigh => {
                self.phase = Phase::Settle;
                FlashStep::Delay { ms: 50 }
            }
            Phase::Settle => {
                self.sync_attempt = 0;
                self.sync()
            }
            Phase::AfterSetBaud => {
                self.phase = Phase::ResetLow;
                FlashStep::Reset { dtr: false, rts: false, delay_ms: 250 }
            }
            Phase::Sync => self.on_sync_input(input),
            Phase::Signature => self.on_signature_input(input),
            Phase::EnterProgmode => {
                if is_ok(input) {
                    self.begin_program()
                } else {
                    self.fail(FlashError::Communication("Failed to enter programming mode".into()))
                }
            }
            Phase::LoadAddr => {
                if is_ok(input) {
                    self.phase = Phase::ProgPage;
                    self.prog_page_step()
                } else {
                    self.fail(FlashError::Communication("Failed to load flash address".into()))
                }
            }
            Phase::ProgPage => {
                if is_ok(input) {
                    self.phase = Phase::AfterPage;
                    FlashStep::Progress {
                        done: (self.page_index + 1) as u32,
                        total: self.total_pages as u32,
                    }
                } else {
                    self.fail(FlashError::ProgramFailed(format!(
                        "page {} was not acknowledged",
                        self.page_index
                    )))
                }
            }
            Phase::AfterPage => {
                self.page_index += 1;
                if self.page_index < self.total_pages {
                    self.phase = Phase::LoadAddr;
                    self.load_address_step()
                } else {
                    self.phase = Phase::LeaveProgmode;
                    command(vec![STK_LEAVE_PROGMODE, CRC_EOP])
                }
            }
            Phase::LeaveProgmode => {
                // The chip is programmed by now; a lost answer to "leave" is
                // not a failed flash.
                self.phase = Phase::Done;
                FlashStep::Done
            }
            Phase::Done => FlashStep::Done,
        }
    }
}
