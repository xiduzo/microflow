//! Sans-IO `STK500v2` driver (Mega 2560): Atmel's framed AVR068 protocol, as
//! the Mega's `stk500boot` bootloader speaks it.
//!
//! A message is `MESSAGE_START, sequence, size (big-endian u16), TOKEN, body,
//! checksum`. The checksum is the XOR of every byte before it, `MESSAGE_START`
//! included; the bootloader drops a message whose checksum is wrong without
//! answering. Its answer carries the same sequence number, and a body that
//! starts with the command id followed by a status byte.
//!
//! A command is written by one [`FlashStep::Transact`], which asks for the
//! whole of its answer: the size of an answer is fixed per command. The driver
//! frames what comes in itself, and takes as the answer only a message that
//! carries the sequence number it sent. A message with another number is the
//! answer to an earlier one, come in late; it is read past.

use super::driver::{FlashDriver, FlashStep};
use super::{word_aligned, BoardConfig, FlashError};

const MESSAGE_START: u8 = 0x1B;
const TOKEN: u8 = 0x0E;
/// Bytes before a body: start, sequence, two size bytes, token.
const HEADER_LEN: usize = 5;
/// Bytes around a body: the header and the checksum.
const FRAME_OVERHEAD: usize = HEADER_LEN + 1;

const CMD_SIGN_ON: u8 = 0x01;
const CMD_LOAD_ADDRESS: u8 = 0x06;
const CMD_ENTER_PROGMODE_ISP: u8 = 0x10;
const CMD_LEAVE_PROGMODE_ISP: u8 = 0x11;
const CMD_PROGRAM_FLASH_ISP: u8 = 0x13;
const CMD_READ_SIGNATURE_ISP: u8 = 0x1B;

const STATUS_CMD_OK: u8 = 0x00;

/// The longest body the bootloader answers this driver with: the sign-on's.
/// A message that claims more is not an answer to anything sent here.
const MAX_ANSWER_BODY: usize = 11;

// The sign-on cadence, from `stk500boot.c`. The chip comes out of reset about
// 70 ms after the reset edge (its fuses' 65 ms start-up). The bootloader then
// waits for a first byte for `boot_timeout = 20000` turns of a loop of roughly
// 45 µs, "about 1 second", and starts the sketch if none came: it listens
// from about 70 ms to somewhere between 0.9 and 1.1 s after the edge. A
// sign-on is 7 bytes and its answer 17, 2 ms on the wire at 115200 baud plus
// up to about 16 ms in the USB-serial bridge, and far more over a slow
// bridge, a hub or a busy machine.
//
// A sign-on goes out every 250 ms from 100 ms after the edge: at 100, 350,
// 600, 850 and 1100 ms, four of them in the window. The driver listens from
// the first one to 1350 ms after the edge without discarding anything, and
// the answer to any of them ends the sign-on, whenever in that time it comes
// in. Once the bootloader has heard any byte it waits seconds for the next
// (`recchar_timeout`), so the commands after the sign-on keep the long wait.
//
// The bootloader answers every sign-on it hears, so up to four more answers
// can follow the one that ended the sign-on. Every sign-on carries sequence
// number 1 (see `sign_on`) and the command after it 2: those answers are read
// past by their number, in the same undiscarded input, before the answer to
// that command.
//
// Bytes that are no sign-on answer (a sketch still printing) must not buy
// more time: the driver has no clock. A sign-on asks for just its answer
// until the first such bytes come in. The sign-on they came in for then
// listens on once, and from then on every wait reads its whole period: it
// asks for as many bytes as may be read past and the answer, and ends when
// its time is up. A board that never answers is given up on after at most six
// periods, whatever it prints.
const MAX_SIGN_ON_ATTEMPTS: u32 = 5;
/// How long the answer to one sign-on is waited for before the next goes out.
const SIGN_ON_PERIOD_MS: u32 = 250;
/// Wait for the answer to any other command. A page is erased and written in
/// about 9 ms after its 266 bytes (23 ms) are in.
const TRANSACT_TIMEOUT_MS: u32 = 1000;
/// How many bytes are read past in search of one answer before the command
/// counts as unanswered: every sign-on answer there can be. More than that is
/// not a bootloader talking.
const MAX_SKIPPED: usize = MAX_SIGN_ON_ATTEMPTS as usize * (FRAME_OVERHEAD + MAX_ANSWER_BODY);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cmd {
    SignOn,
    EnterProgmode,
    Signature,
    LoadAddress,
    ProgramPage,
    LeaveProgmode,
}

impl Cmd {
    fn id(self) -> u8 {
        match self {
            Self::SignOn => CMD_SIGN_ON,
            Self::EnterProgmode => CMD_ENTER_PROGMODE_ISP,
            Self::Signature => CMD_READ_SIGNATURE_ISP,
            Self::LoadAddress => CMD_LOAD_ADDRESS,
            Self::ProgramPage => CMD_PROGRAM_FLASH_ISP,
            Self::LeaveProgmode => CMD_LEAVE_PROGMODE_ISP,
        }
    }

    /// Size of the answer body: command id, status, and for two commands data.
    fn answer_len(self) -> usize {
        match self {
            // id, status, name length, "AVRISP_2"
            Self::SignOn => MAX_ANSWER_BODY,
            // id, status, signature byte, status
            Self::Signature => 4,
            _ => 2,
        }
    }

    fn timeout_ms(self) -> u32 {
        match self {
            Self::SignOn => SIGN_ON_PERIOD_MS,
            _ => TRANSACT_TIMEOUT_MS,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    ResetLow,
    ResetHigh,
    Settle,
    /// Waiting for the answer to this command.
    Answer(Cmd),
    Progress,
    Done,
}

/// What the input holds of the answer to the message in flight.
enum Scan {
    /// Its body.
    Answer(Vec<u8>),
    /// Not all of it: an answer takes at least this many more bytes.
    Need(usize),
}

pub struct Stk500v2Driver {
    flash: Vec<u8>,
    page_size: usize,
    /// Sequence number of the next message.
    seq: u8,
    /// Sequence number of the message awaiting its answer.
    sent_seq: u8,
    phase: Phase,
    /// Input read since the last discard and not yet made sense of.
    rx: Vec<u8>,
    /// Bytes the last step asked for; fewer came in if its read timed out.
    asked: usize,
    /// Bytes read past since the message in flight was sent.
    skipped: usize,
    sign_on_attempt: u32,
    /// Bytes that are no sign-on answer came in since the first sign-on:
    /// every sign-on wait reads its whole period.
    noisy: bool,
    sig_index: u8,
    page_index: usize,
    total_pages: usize,
}

impl Stk500v2Driver {
    #[must_use]
    pub fn new(flash: Vec<u8>, config: &BoardConfig) -> Self {
        let flash = word_aligned(flash);
        let page_size = config.page_size.max(1);
        let total_pages = flash.len().div_ceil(page_size);
        Self {
            flash,
            page_size,
            seq: 1,
            sent_seq: 0,
            phase: Phase::ResetLow,
            rx: Vec::new(),
            asked: 0,
            skipped: 0,
            sign_on_attempt: 0,
            noisy: false,
            sig_index: 0,
            page_index: 0,
            total_pages,
        }
    }

    /// Frame `body` as a message and send it, expecting `cmd`'s answer. The
    /// input is discarded first unless `keep_input`.
    fn send(&mut self, body: &[u8], cmd: Cmd, keep_input: bool) -> FlashStep {
        self.sent_seq = self.seq;
        self.seq = self.seq.wrapping_add(1);
        let len = body.len() as u16;
        let mut packet = Vec::with_capacity(FRAME_OVERHEAD + body.len());
        packet.extend_from_slice(&[MESSAGE_START, self.sent_seq, (len >> 8) as u8, len as u8, TOKEN]);
        packet.extend_from_slice(body);
        packet.push(checksum(&packet));

        if !keep_input {
            self.rx.clear();
        }
        self.skipped = 0;
        // A message already in the input is not the answer to one that has
        // not gone out yet, whatever number it carries.
        let need = loop {
            if let Scan::Need(need) = self.scan(cmd) {
                break need;
            }
        };
        self.transact(packet, need, cmd, keep_input)
    }

    /// Wait for `more` bytes of `cmd`'s answer, sending nothing.
    fn listen(&mut self, more: usize, cmd: Cmd) -> FlashStep {
        self.transact(Vec::new(), more, cmd, true)
    }

    fn transact(&mut self, write: Vec<u8>, read_len: usize, cmd: Cmd, keep_input: bool) -> FlashStep {
        // A sign-on wait after bytes that are no answer reads its whole period.
        let read_len = if cmd == Cmd::SignOn && self.noisy { read_len + MAX_SKIPPED } else { read_len };
        self.asked = read_len;
        self.phase = Phase::Answer(cmd);
        FlashStep::Transact { write, read_len, timeout_ms: cmd.timeout_ms(), keep_input }
    }

    /// Read `count` bytes past: they are not part of the answer waited for.
    fn skip(&mut self, count: usize) {
        self.rx.drain(..count);
        self.skipped += count;
    }

    /// Look in the input for the answer to the message in flight: a
    /// well-formed message that carries its sequence number. Whatever comes
    /// before it is read past: bytes that frame no message, and whole
    /// messages with another number (answers to earlier messages).
    fn scan(&mut self, cmd: Cmd) -> Scan {
        let whole = FRAME_OVERHEAD + cmd.answer_len();
        loop {
            let noise = self.rx.iter().position(|&b| b == MESSAGE_START).unwrap_or(self.rx.len());
            self.skip(noise);
            if self.rx.len() < HEADER_LEN {
                return Scan::Need(whole - self.rx.len());
            }
            let len = usize::from(self.rx[2]) << 8 | usize::from(self.rx[3]);
            if self.rx[4] != TOKEN || len > MAX_ANSWER_BODY {
                self.skip(1);
                continue;
            }
            // Where the checksum is.
            let end = HEADER_LEN + len;
            let ours = self.rx[1] == self.sent_seq;
            if self.rx.len() <= end {
                let rest = end + 1 - self.rx.len();
                // After another message's answer, this one's is still to come.
                return Scan::Need(if ours { rest } else { rest + whole });
            }
            if checksum(&self.rx[..end]) != self.rx[end] {
                self.skip(1);
            } else if ours {
                let body = self.rx[HEADER_LEN..end].to_vec();
                self.rx.drain(..=end);
                return Scan::Answer(body);
            } else {
                self.skip(end + 1);
            }
        }
    }

    /// The step after `input` came in for `cmd`: on with the flash once its
    /// answer is there, more listening while it can still come.
    fn on_input(&mut self, cmd: Cmd, input: &[u8]) -> FlashStep {
        let timed_out = input.len() < self.asked;
        self.rx.extend_from_slice(input);
        match self.scan(cmd) {
            Scan::Answer(body) => {
                // A body starts with the command id, then the status.
                let ok = body.len() >= cmd.answer_len() && body[0] == cmd.id() && body[1] == STATUS_CMD_OK;
                self.on_answer(cmd, ok)
            }
            // The period is over, or a wait for all of it filled up with bytes
            // that are no answer.
            Scan::Need(_) if cmd == Cmd::SignOn && (timed_out || self.noisy) => self.on_answer(cmd, false),
            Scan::Need(more) if cmd == Cmd::SignOn => {
                // The first bytes that are no answer, and the period is not
                // over: listen on for the rest of it.
                self.noisy = true;
                self.listen(more, cmd)
            }
            Scan::Need(_) if timed_out || self.skipped > MAX_SKIPPED => self.on_answer(cmd, false),
            Scan::Need(more) => self.listen(more, cmd),
        }
    }

    /// Send a sign-on. The first one of a flash discards what the reset left
    /// in the input; the ones after it keep what came in since.
    fn sign_on(&mut self) -> FlashStep {
        if self.sign_on_attempt == 0 {
            self.noisy = false;
        }
        // Bootloaders older than Arduino's "issue 505" fix accept only the
        // sequence number they expect next, or 1. A sign-on that went
        // unanswered leaves the two out of step, so every sign-on is sent as 1.
        self.seq = 1;
        self.send(&[CMD_SIGN_ON], Cmd::SignOn, self.sign_on_attempt > 0)
    }

    fn enter_progmode(&mut self) -> FlashStep {
        // ISP programming parameters for the ATmega2560: timeout, stabDelay,
        // cmdexeDelay, synchLoops, byteDelay, pollValue, pollIndex, cmd1..4.
        let params = [CMD_ENTER_PROGMODE_ISP, 200, 100, 25, 32, 0, 0x53, 3, 0xAC, 0x53, 0x00, 0x00];
        // The first command after the sign-on: answers to repeated sign-ons
        // can come in before its own, so the input stays as it is.
        self.send(&params, Cmd::EnterProgmode, true)
    }

    fn read_signature_byte(&mut self) -> FlashStep {
        let cmd = [CMD_READ_SIGNATURE_ISP, 4, 0x30, 0x00, self.sig_index, 0x00];
        self.send(&cmd, Cmd::Signature, false)
    }

    fn load_address(&mut self) -> FlashStep {
        let address = (self.page_index * self.page_size) as u32;
        let word_addr = address / 2;
        let cmd = [
            CMD_LOAD_ADDRESS,
            (word_addr >> 24) as u8,
            (word_addr >> 16) as u8,
            (word_addr >> 8) as u8,
            word_addr as u8,
        ];
        self.send(&cmd, Cmd::LoadAddress, false)
    }

    fn program_page(&mut self) -> FlashStep {
        let start = self.page_index * self.page_size;
        let end = (start + self.page_size).min(self.flash.len());
        let len = end - start;
        let mut body = Vec::with_capacity(10 + len);
        // size, mode, delay, cmd1..3, poll1..2: the bootloader reads the size
        // and the data and ignores the ISP parameters between them.
        body.extend_from_slice(&[
            CMD_PROGRAM_FLASH_ISP,
            (len >> 8) as u8,
            len as u8,
            0xC1,
            10,
            0x40,
            0x4C,
            0x20,
            0x00,
            0x00,
        ]);
        body.extend_from_slice(&self.flash[start..end]);
        self.send(&body, Cmd::ProgramPage, false)
    }

    fn leave_progmode(&mut self) -> FlashStep {
        self.send(&[CMD_LEAVE_PROGMODE_ISP, 1, 1], Cmd::LeaveProgmode, false)
    }

    fn fail(&mut self, error: FlashError) -> FlashStep {
        self.phase = Phase::Done;
        FlashStep::Error { error }
    }

    /// The step after `cmd` was answered with an OK (`accepted`), or was
    /// refused or not answered in time.
    fn on_answer(&mut self, cmd: Cmd, accepted: bool) -> FlashStep {
        match cmd {
            Cmd::SignOn if accepted => self.enter_progmode(),
            Cmd::SignOn => {
                self.sign_on_attempt += 1;
                if self.sign_on_attempt < MAX_SIGN_ON_ATTEMPTS {
                    self.sign_on()
                } else {
                    self.fail(FlashError::SyncFailed)
                }
            }
            // The chip is programmed by now; a lost answer to "leave" is not a
            // failed flash.
            Cmd::LeaveProgmode => {
                self.phase = Phase::Done;
                FlashStep::Done
            }
            Cmd::EnterProgmode if !accepted => {
                self.fail(FlashError::Communication("Failed to enter programming mode".into()))
            }
            Cmd::Signature if !accepted => {
                self.fail(FlashError::Communication("Failed to read signature".into()))
            }
            Cmd::LoadAddress if !accepted => {
                self.fail(FlashError::Communication("Failed to load flash address".into()))
            }
            Cmd::ProgramPage if !accepted => self.fail(FlashError::ProgramFailed(format!(
                "page {} was not acknowledged",
                self.page_index
            ))),
            Cmd::EnterProgmode => {
                self.sig_index = 0;
                self.read_signature_byte()
            }
            Cmd::Signature => {
                // The signature's value is informational: all three bytes are
                // read, and a mismatch is tolerated.
                self.sig_index += 1;
                if self.sig_index < 3 {
                    self.read_signature_byte()
                } else if self.total_pages == 0 {
                    self.leave_progmode()
                } else {
                    self.page_index = 0;
                    self.load_address()
                }
            }
            Cmd::LoadAddress => self.program_page(),
            Cmd::ProgramPage => {
                // Progress is a step of its own: the advance after it moves on
                // to the next page or leaves programming mode.
                self.phase = Phase::Progress;
                FlashStep::Progress { done: (self.page_index + 1) as u32, total: self.total_pages as u32 }
            }
        }
    }
}

/// XOR of every byte of a message, `MESSAGE_START` included.
fn checksum(bytes: &[u8]) -> u8 {
    bytes.iter().fold(0, |acc, &b| acc ^ b)
}

impl FlashDriver for Stk500v2Driver {
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
                self.sign_on_attempt = 0;
                self.sign_on()
            }
            Phase::Answer(cmd) => self.on_input(cmd, input),
            Phase::Progress => {
                self.page_index += 1;
                if self.page_index < self.total_pages {
                    self.load_address()
                } else {
                    self.leave_progmode()
                }
            }
            Phase::Done => FlashStep::Done,
        }
    }
}
