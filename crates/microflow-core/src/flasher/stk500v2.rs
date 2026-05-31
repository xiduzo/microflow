//! Sans-IO `STK500v2` driver (Mega 2560). A port of the desktop blocking
//! flasher: packet-based framing with a sequence number and XOR checksum.
//! Each command is two transactions — read the 5-byte header, then read the
//! body whose length the header announces.

use super::driver::{FlashDriver, FlashStep};
use super::BoardConfig;

const MESSAGE_START: u8 = 0x1B;
const TOKEN: u8 = 0x0E;

const CMD_SIGN_ON: u8 = 0x01;
const CMD_LOAD_ADDRESS: u8 = 0x06;
const CMD_ENTER_PROGMODE_ISP: u8 = 0x10;
const CMD_LEAVE_PROGMODE_ISP: u8 = 0x11;
const CMD_PROGRAM_FLASH_ISP: u8 = 0x13;
const CMD_READ_SIGNATURE_ISP: u8 = 0x1B;

const STATUS_CMD_OK: u8 = 0x00;

const MAX_SIGNON_ATTEMPTS: u32 = 5;
const TRANSACT_TIMEOUT_MS: u32 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cmd {
    SignOn,
    EnterProgmode,
    Signature,
    LoadAddress,
    ProgramPage,
    LeaveProgmode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    ResetLow,
    ResetHigh,
    Settle,
    Header,
    Body,
    Progress,
    Done,
}

pub struct Stk500v2Driver {
    flash: Vec<u8>,
    page_size: usize,
    seq: u8,
    cmd: Cmd,
    phase: Phase,
    header: [u8; 5],
    body_len: usize,
    signon_attempt: u32,
    sig_index: u8,
    page_index: usize,
    total_pages: usize,
}

impl Stk500v2Driver {
    #[must_use]
    pub fn new(flash: Vec<u8>, config: &BoardConfig) -> Self {
        let page_size = config.page_size.max(1);
        let total_pages = flash.len().div_ceil(page_size);
        Self {
            flash,
            page_size,
            seq: 0,
            cmd: Cmd::SignOn,
            phase: Phase::ResetLow,
            header: [0; 5],
            body_len: 0,
            signon_attempt: 0,
            sig_index: 0,
            page_index: 0,
            total_pages,
        }
    }

    /// Frame `body` into an `STK500v2` packet and emit it, expecting the 5-byte
    /// reply header next.
    fn send(&mut self, body: &[u8], cmd: Cmd) -> FlashStep {
        let seq = self.seq;
        self.seq = self.seq.wrapping_add(1);
        let len = body.len() as u16;
        let mut packet = Vec::with_capacity(6 + body.len());
        packet.push(MESSAGE_START);
        packet.push(seq);
        packet.push(((len >> 8) & 0xFF) as u8);
        packet.push((len & 0xFF) as u8);
        packet.push(TOKEN);
        packet.extend_from_slice(body);
        let checksum = packet[1..].iter().fold(0u8, |acc, &b| acc ^ b);
        packet.push(checksum);

        self.cmd = cmd;
        self.phase = Phase::Header;
        FlashStep::Transact { write: packet, read_len: 5, timeout_ms: TRANSACT_TIMEOUT_MS }
    }

    fn enter_progmode(&mut self) -> FlashStep {
        // ISP programming parameters for the ATmega2560.
        let params = [
            CMD_ENTER_PROGMODE_ISP, 200, 100, 25, 32, 0, 0x53, 3, 0xAC, 0x53, 0x00, 0x00,
        ];
        self.send(&params, Cmd::EnterProgmode)
    }

    fn read_signature_byte(&mut self) -> FlashStep {
        let cmd = [CMD_READ_SIGNATURE_ISP, 4, 0x30, 0x00, self.sig_index, 0x00];
        self.send(&cmd, Cmd::Signature)
    }

    fn load_address(&mut self) -> FlashStep {
        let address = (self.page_index * self.page_size) as u32;
        let word_addr = address / 2;
        let cmd = [
            CMD_LOAD_ADDRESS,
            ((word_addr >> 24) & 0xFF) as u8,
            ((word_addr >> 16) & 0xFF) as u8,
            ((word_addr >> 8) & 0xFF) as u8,
            (word_addr & 0xFF) as u8,
        ];
        self.send(&cmd, Cmd::LoadAddress)
    }

    fn program_page(&mut self) -> FlashStep {
        let start = self.page_index * self.page_size;
        let end = (start + self.page_size).min(self.flash.len());
        let chunk = self.flash[start..end].to_vec();
        let len = chunk.len();
        let mut body = Vec::with_capacity(10 + len);
        body.extend_from_slice(&[
            CMD_PROGRAM_FLASH_ISP,
            ((len >> 8) & 0xFF) as u8,
            (len & 0xFF) as u8,
            0xC1, 10, 0x40, 0x4C, 0x20, 0x00, 0x00,
        ]);
        body.extend_from_slice(&chunk);
        self.send(&body, Cmd::ProgramPage)
    }

    fn leave_progmode(&mut self) -> FlashStep {
        self.send(&[CMD_LEAVE_PROGMODE_ISP, 1, 1], Cmd::LeaveProgmode)
    }

    fn begin_program(&mut self) -> FlashStep {
        if self.total_pages == 0 {
            return self.leave_progmode();
        }
        self.page_index = 0;
        self.load_address()
    }

    fn fail(&mut self, message: &str) -> FlashStep {
        self.phase = Phase::Done;
        FlashStep::Error { message: message.into() }
    }
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
                self.signon_attempt = 0;
                self.send(&[CMD_SIGN_ON], Cmd::SignOn)
            }
            Phase::Header => {
                // input is the 5-byte reply header.
                if input.len() < 5 || input[0] != MESSAGE_START || input[4] != TOKEN {
                    if self.cmd == Cmd::SignOn {
                        self.signon_attempt += 1;
                        if self.signon_attempt < MAX_SIGNON_ATTEMPTS {
                            return self.send(&[CMD_SIGN_ON], Cmd::SignOn);
                        }
                        return self.fail("Failed to sign on to the STK500v2 bootloader");
                    }
                    return self.fail("Invalid STK500v2 reply header");
                }
                self.header.copy_from_slice(&input[..5]);
                self.body_len = ((usize::from(input[2])) << 8) | usize::from(input[3]);
                self.phase = Phase::Body;
                FlashStep::Transact {
                    write: Vec::new(),
                    read_len: self.body_len + 1,
                    timeout_ms: TRANSACT_TIMEOUT_MS,
                }
            }
            Phase::Body => {
                // input is body + trailing checksum byte.
                if input.len() < self.body_len + 1 {
                    return self.fail("Truncated STK500v2 reply body");
                }
                let body = &input[..self.body_len];
                let received = input[self.body_len];
                let mut calc = self.header[1..].iter().fold(0u8, |acc, &b| acc ^ b);
                calc = body.iter().fold(calc, |acc, &b| acc ^ b);
                if received != calc {
                    return self.fail("STK500v2 checksum mismatch");
                }
                let status_ok = !body.is_empty() && body[0] == STATUS_CMD_OK;

                match self.cmd {
                    Cmd::SignOn => {
                        if status_ok {
                            self.enter_progmode()
                        } else {
                            self.signon_attempt += 1;
                            if self.signon_attempt < MAX_SIGNON_ATTEMPTS {
                                self.send(&[CMD_SIGN_ON], Cmd::SignOn)
                            } else {
                                self.fail("STK500v2 sign-on rejected")
                            }
                        }
                    }
                    Cmd::EnterProgmode => {
                        if status_ok {
                            self.sig_index = 0;
                            self.read_signature_byte()
                        } else {
                            self.fail("Failed to enter programming mode")
                        }
                    }
                    Cmd::Signature => {
                        // Signature is informational (body[2] is the byte); just
                        // read all three then move on, tolerating mismatches.
                        self.sig_index += 1;
                        if self.sig_index < 3 {
                            self.read_signature_byte()
                        } else {
                            self.begin_program()
                        }
                    }
                    Cmd::LoadAddress => {
                        if status_ok {
                            self.program_page()
                        } else {
                            self.fail("Failed to load flash address")
                        }
                    }
                    Cmd::ProgramPage => {
                        if !status_ok {
                            return self.fail(&format!("Failed to program page {}", self.page_index));
                        }
                        // Emit progress now; the next advance (Phase::Progress)
                        // continues to the next page or leaves programming mode —
                        // a single step never carries two actions.
                        self.phase = Phase::Progress;
                        FlashStep::Progress {
                            done: (self.page_index + 1) as u32,
                            total: self.total_pages as u32,
                        }
                    }
                    Cmd::LeaveProgmode => {
                        self.phase = Phase::Done;
                        FlashStep::Done
                    }
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flasher::BoardType;

    /// Build the OK reply body for a command id (mirrors what the bootloader
    /// returns; `body[0]` is the status the driver checks).
    fn ok_body(command: u8) -> Vec<u8> {
        match command {
            CMD_READ_SIGNATURE_ISP => vec![STATUS_CMD_OK, 0x00, 0x1E], // body[2] = sig byte
            _ => vec![STATUS_CMD_OK],
        }
    }

    #[test]
    fn happy_path_signs_on_programs_pages_and_leaves() {
        // 300 bytes over a 256-byte page size => 2 pages.
        let flash = vec![0x42u8; 300];
        let config = BoardConfig::find(BoardType::Mega);
        let mut d = Stk500v2Driver::new(flash, &config);

        let mut pending_body: Option<Vec<u8>> = None;
        let mut pending_header = [0u8; 5];
        let mut sign_ons = 0;
        let mut prog_pages = 0;

        let mut step = d.start();
        let mut guard = 0;
        loop {
            guard += 1;
            assert!(guard < 300, "driver did not terminate");
            step = match &step {
                FlashStep::Done => break,
                FlashStep::Error { message } => panic!("unexpected error: {message}"),
                FlashStep::Transact { write, read_len, .. } if !write.is_empty() => {
                    // A packet -> reply with a header announcing the OK body.
                    assert_eq!(*read_len, 5);
                    let command = write[5];
                    if command == CMD_SIGN_ON {
                        sign_ons += 1;
                    }
                    if command == CMD_PROGRAM_FLASH_ISP {
                        prog_pages += 1;
                    }
                    let body = ok_body(command);
                    let len = body.len() as u16;
                    let header = [
                        MESSAGE_START,
                        write[1], // echo seq
                        ((len >> 8) & 0xFF) as u8,
                        (len & 0xFF) as u8,
                        TOKEN,
                    ];
                    pending_header = header;
                    pending_body = Some(body);
                    d.advance(&header)
                }
                FlashStep::Transact { write, read_len, .. } if write.is_empty() => {
                    // A body read -> reply with body + valid checksum.
                    let body = pending_body.take().expect("body requested without header");
                    assert_eq!(*read_len, body.len() + 1);
                    let mut calc = pending_header[1..].iter().fold(0u8, |a, &b| a ^ b);
                    calc = body.iter().fold(calc, |a, &b| a ^ b);
                    let mut reply = body;
                    reply.push(calc);
                    d.advance(&reply)
                }
                _ => d.advance(&[]),
            };
        }
        assert_eq!(sign_ons, 1);
        assert_eq!(prog_pages, 2, "one program-flash per page");
    }
}
