//! Sans-IO `STK500v1` driver (Uno, Nano). A faithful port of the desktop
//! blocking flasher into the [`FlashDriver`] step machine: same reset, sync
//! (with retries + baud fallback), signature read, page programming, and
//! programming-mode exit — but transport-free, so the browser drives it too.

use super::driver::{FlashDriver, FlashStep};
use super::BoardConfig;

const STK_OK: u8 = 0x10;
const STK_INSYNC: u8 = 0x14;
const CRC_EOP: u8 = 0x20;
const STK_GET_SYNC: u8 = 0x30;
const STK_ENTER_PROGMODE: u8 = 0x50;
const STK_LEAVE_PROGMODE: u8 = 0x51;
const STK_LOAD_ADDRESS: u8 = 0x55;
const STK_PROG_PAGE: u8 = 0x64;
const STK_READ_SIGN: u8 = 0x75;

/// Baud rates to try after the configured one (clones vary).
const FALLBACK_BAUDS: [u32; 3] = [57600, 115200, 19200];
/// Sync attempts before falling back to the next baud rate.
const MAX_SYNC_ATTEMPTS: u32 = 10;
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
}

impl Stk500v1Driver {
    #[must_use]
    pub fn new(flash: Vec<u8>, config: &BoardConfig) -> Self {
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
        }
    }

    fn sync_transact() -> FlashStep {
        FlashStep::Transact {
            write: vec![STK_GET_SYNC, CRC_EOP],
            read_len: 2,
            timeout_ms: TRANSACT_TIMEOUT_MS,
        }
    }

    fn load_address_step(&self) -> FlashStep {
        let address = (self.page_index * self.page_size) as u32;
        let word_addr = (address / 2) as u16;
        FlashStep::Transact {
            write: vec![
                STK_LOAD_ADDRESS,
                (word_addr & 0xFF) as u8,
                ((word_addr >> 8) & 0xFF) as u8,
                CRC_EOP,
            ],
            read_len: 2,
            timeout_ms: TRANSACT_TIMEOUT_MS,
        }
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
        FlashStep::Transact { write, read_len: 2, timeout_ms: TRANSACT_TIMEOUT_MS }
    }

    fn begin_program(&mut self) -> FlashStep {
        if self.total_pages == 0 {
            self.phase = Phase::LeaveProgmode;
            return leave_progmode_step();
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
            return Self::sync_transact();
        }
        self.baud_index += 1;
        if self.baud_index < self.bauds.len() {
            self.sync_attempt = 0;
            self.phase = Phase::AfterSetBaud;
            FlashStep::SetBaud { baud: self.bauds[self.baud_index] }
        } else {
            self.phase = Phase::Done;
            FlashStep::Error {
                message: "Failed to sync with the STK500v1 bootloader".into(),
            }
        }
    }
}

/// `[STK_LEAVE_PROGMODE, CRC_EOP]`, expecting `[INSYNC, OK]`.
fn leave_progmode_step() -> FlashStep {
    FlashStep::Transact {
        write: vec![STK_LEAVE_PROGMODE, CRC_EOP],
        read_len: 2,
        timeout_ms: TRANSACT_TIMEOUT_MS,
    }
}

/// True when a 2-byte reply is the bootloader's `INSYNC` + `OK` acknowledgement.
fn is_ok(resp: &[u8]) -> bool {
    resp.len() >= 2 && resp[0] == STK_INSYNC && resp[1] == STK_OK
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
                self.phase = Phase::Sync;
                Self::sync_transact()
            }
            Phase::AfterSetBaud => {
                self.phase = Phase::ResetLow;
                FlashStep::Reset { dtr: false, rts: false, delay_ms: 250 }
            }
            Phase::Sync => {
                if is_ok(input) {
                    self.phase = Phase::Signature;
                    FlashStep::Transact {
                        write: vec![STK_READ_SIGN, CRC_EOP],
                        read_len: 5,
                        timeout_ms: TRANSACT_TIMEOUT_MS,
                    }
                } else {
                    self.on_sync_failure()
                }
            }
            Phase::Signature => {
                // The signature is informational; mismatches are tolerated (some
                // clones report different ids), matching the desktop flasher.
                self.phase = Phase::EnterProgmode;
                FlashStep::Transact {
                    write: vec![STK_ENTER_PROGMODE, CRC_EOP],
                    read_len: 2,
                    timeout_ms: TRANSACT_TIMEOUT_MS,
                }
            }
            Phase::EnterProgmode => {
                if is_ok(input) {
                    self.begin_program()
                } else {
                    self.phase = Phase::Done;
                    FlashStep::Error { message: "Failed to enter programming mode".into() }
                }
            }
            Phase::LoadAddr => {
                if is_ok(input) {
                    self.phase = Phase::ProgPage;
                    self.prog_page_step()
                } else {
                    self.phase = Phase::Done;
                    FlashStep::Error { message: "Failed to load flash address".into() }
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
                    self.phase = Phase::Done;
                    FlashStep::Error {
                        message: format!("Failed to program page {}", self.page_index),
                    }
                }
            }
            Phase::AfterPage => {
                self.page_index += 1;
                if self.page_index < self.total_pages {
                    self.phase = Phase::LoadAddr;
                    self.load_address_step()
                } else {
                    self.phase = Phase::LeaveProgmode;
                    leave_progmode_step()
                }
            }
            Phase::LeaveProgmode => {
                self.phase = Phase::Done;
                if is_ok(input) {
                    FlashStep::Done
                } else {
                    // The chip is programmed; a missing leave-ack is non-fatal.
                    FlashStep::Done
                }
            }
            Phase::Done => FlashStep::Done,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flasher::BoardType;

    /// Drive the happy path with a scripted bootloader that always ACKs, and
    /// assert the transaction sequence matches the `STK500v1` protocol.
    #[test]
    fn happy_path_programs_every_page_and_finishes() {
        // 200 bytes over a 128-byte page size => 2 pages.
        let flash = vec![0xAAu8; 200];
        let config = BoardConfig::find(BoardType::Uno);
        let mut d = Stk500v1Driver::new(flash, &config);

        let ok = [STK_INSYNC, STK_OK];
        let sig = [STK_INSYNC, 0x1E, 0x95, 0x0F, STK_OK];

        let mut step = d.start();
        let mut load_addrs = 0;
        let mut prog_pages = 0;
        let mut guard = 0;
        loop {
            guard += 1;
            assert!(guard < 100, "driver did not terminate");
            step = match &step {
                FlashStep::Reset { .. } | FlashStep::Delay { .. } | FlashStep::Progress { .. } => {
                    d.advance(&[])
                }
                FlashStep::Transact { write, read_len, .. } => {
                    // Identify the command from the first byte to script a reply.
                    let reply: &[u8] = match write[0] {
                        STK_READ_SIGN => &sig,
                        _ => &ok,
                    };
                    if write[0] == STK_LOAD_ADDRESS {
                        load_addrs += 1;
                    }
                    if write[0] == STK_PROG_PAGE {
                        prog_pages += 1;
                    }
                    assert_eq!(*read_len, reply.len());
                    d.advance(reply)
                }
                FlashStep::Done => break,
                other => panic!("unexpected step on happy path: {other:?}"),
            };
        }
        assert_eq!(load_addrs, 2, "one load-address per page");
        assert_eq!(prog_pages, 2, "one prog-page per page");
    }

    #[test]
    fn sync_falls_back_to_next_baud_after_retries() {
        let config = BoardConfig::find(BoardType::Nano); // 57600
        let mut d = Stk500v1Driver::new(vec![0u8; 8], &config);

        // Skip the reset/settle steps up to the first sync.
        let mut step = d.start();
        while !matches!(step, FlashStep::Transact { .. }) {
            step = d.advance(&[]);
        }

        // Feed garbage to every sync attempt; after MAX_SYNC_ATTEMPTS the driver
        // should ask to switch baud rather than give up immediately.
        let mut saw_setbaud = false;
        for _ in 0..=MAX_SYNC_ATTEMPTS {
            step = d.advance(&[0x00, 0x00]);
            if let FlashStep::SetBaud { baud } = step {
                assert_eq!(baud, 115200, "next baud after 57600");
                saw_setbaud = true;
                break;
            }
        }
        assert!(saw_setbaud, "expected a baud fallback after repeated sync failures");
    }
}
