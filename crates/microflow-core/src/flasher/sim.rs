//! Modelled bootloaders: the firmware end of a flash, for tests.
//!
//! A [`SimBootloader`] consumes the bytes a flasher writes, answers with the
//! bytes the real bootloader would, and keeps the chip's flash memory. A test
//! flashes an image at it and asserts on what ended up programmed, not on the
//! bytes that were sent (ADR-0030, applied to flashing).
//!
//! Each model is transcribed from the bootloader Arduino ships for the board
//! (`bootloaders/` in the Arduino AVR core):
//!
//! - [`SimBootloader::optiboot`]: `optiboot/optiboot.c` (Uno, newer Nano), `STK500v1`.
//! - [`SimBootloader::atmegaboot`]: `atmega/ATmegaBOOT_168.c`, the `atmega328`
//!   build (older Nano, Duemilanove), `STK500v1` at 57600 baud.
//! - [`SimBootloader::stk500boot`]: `stk500v2/stk500boot.c` (Mega 2560), `STK500v2`.
//! - [`SimBootloader::caterina`]: `caterina/Caterina.c` (Leonardo, Micro), AVR109.
//!
//! Time is virtual: the model has its own clock, moved by [`sleep`](SimBootloader::sleep)
//! and by a [`read`](SimBootloader::read) that waits. The bootloader's own
//! deadlines run on it (Optiboot's 1 s watchdog, `stk500boot`'s 1 s wait for a
//! first byte, Caterina's 8 s timeout), so a flasher that dawdles finds the
//! sketch running instead of the bootloader.
//!
//! Something a real bootloader would choke on or silently drop is recorded as a
//! **violation**, so a test can fail on it. A model can be wrong; where it
//! departs from a real board, the board wins and the model is corrected.
//!
//! # Known differences from hardware
//!
//! - **Start-up.** A real AVR runs nothing for about 66 ms after reset (the
//!   fuses' start-up time); the models listen at once unless a test sets
//!   [`with_startup_ms`](SimBootloader::with_startup_ms).
//! - **Latency.** A page write takes 4 to 9 ms and a USB-serial bridge adds up
//!   to about 16 ms to an answer; the models answer instantly unless a test
//!   sets [`with_answer_delay_ms`](SimBootloader::with_answer_delay_ms), which
//!   holds every answer back by the same time. What the host writes always
//!   arrives at once. Besides that, only Optiboot's and `ATmegaBOOT`'s LED
//!   flashes and Caterina's chip erase take time.
//! - **The wrong baud.** Real bytes at the wrong rate arrive as some other
//!   bytes, with framing errors. The models do not invent them: Optiboot leaves
//!   for the sketch at once, `ATmegaBOOT` counts each byte as an error, and
//!   `stk500boot` ignores them.
//! - **A blank chip.** With no sketch in flash the real bootloaders come back
//!   or stay; the models always "start the sketch" when they leave.
//! - **Timeouts counted in loop turns** (`ATmegaBOOT`'s `MAX_TIME_COUNT`,
//!   `stk500boot`'s `boot_timeout` and `recchar_timeout`) are estimates in ms.

use std::collections::VecDeque;

/// How a bootloader stopped running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    /// The host told it to leave (`STK_LEAVE_PROGMODE`, `CMD_LEAVE_PROGMODE_ISP`, `E`).
    Left,
    /// Nothing (valid) arrived in time; it started the sketch on its own.
    TimedOut,
    /// It received bytes that are not its protocol and bailed out to the sketch.
    Desynced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Model {
    Optiboot,
    AtmegaBoot,
    Stk500Boot,
    Caterina,
}

/// `stk500boot.c`'s receive states.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Frame {
    Start,
    Seq,
    Size1,
    Size2,
    Token,
    Data,
    Check,
}

const ATMEGA328P_SIGNATURE: [u8; 3] = [0x1E, 0x95, 0x0F];
const MEGA_SIGNATURE: [u8; 3] = [0x1E, 0x98, 0x01];
/// `LED_START_FLASHES=3`: six 62.5 ms LED toggles before Optiboot reads the UART.
const OPTIBOOT_BOOT_MS: u64 = 375;
/// `WATCHDOG_1S`, fed by every byte received (`optiboot.c:580`).
const OPTIBOOT_WATCHDOG_MS: u64 = 1000;
/// `NUM_LED_FLASHES=1`: `flash_led` holds the LED on 100 ms and off 100 ms
/// before `ATmegaBOOT` reads the UART (`ATmegaBOOT_168.c:1046`).
const ATMEGABOOT_BOOT_MS: u64 = 200;
/// `MAX_TIME_COUNT=F_CPU>>4`: a million turns of `getch`'s wait loop, about
/// 14 cycles each at 16 MHz (`ATmegaBOOT_168.c:973`). Per byte, not per session.
const ATMEGABOOT_IDLE_MS: u64 = 900;
/// `MAX_ERROR_COUNT` (`ATmegaBOOT_168.c:89`).
const ATMEGABOOT_MAX_ERRORS: u8 = 5;
/// What an AVR UART holds while nobody reads it: a two-level receive buffer.
const UART_HELD: usize = 2;
/// `boot_timeout = 20000` turns, "should be about 1 second": how long
/// `stk500boot` waits for a first byte (`stk500boot.c:587`, `:642`).
const STK500BOOT_FIRST_BYTE_MS: u64 = 1000;
/// `recchar_timeout`: how long it waits for each later byte (`stk500boot.c:496`).
const STK500BOOT_IDLE_MS: u64 = 4000;
/// A full-speed USB bulk packet: what one `Endpoint_ClearOUT()` discards.
const USB_PACKET: usize = 64;
/// Caterina's `TIMEOUT_PERIOD`.
const CATERINA_TIMEOUT_MS: u64 = 8000;
/// What Caterina leaves on its clock after `E`.
const CATERINA_EXIT_MS: u64 = 500;
/// What a sketch set to talk prints, over and over: no byte of it starts a
/// bootloader's answer (`STK_INSYNC`, `MESSAGE_START`, Caterina's `C`).
const SKETCH_TEXT: &[u8] = b"sensor=512\r\n";

/// A bootloader and the chip it programs. See the [module docs](self).
#[derive(Debug)]
pub struct SimBootloader {
    model: Model,
    /// The one rate the bootloader's UART listens at; `None` for native USB.
    listen_baud: Option<u32>,
    host_baud: u32,
    page_size: usize,
    now: u64,
    running: bool,
    exit: Option<Exit>,
    /// The bootloader starts the sketch at this time unless fed first.
    deadline: u64,
    /// Nothing is answered before this time (boot LED flashes, a chip erase).
    busy_until: u64,
    /// Bytes on their way to the host, each with the time it arrives.
    outbox: VecDeque<(u64, u8)>,
    /// Received bytes that do not make a whole command yet.
    rx: Vec<u8>,
    flash: Vec<u8>,
    violations: Vec<String>,
    /// Byte address the next page lands at.
    address: usize,
    pages_written: usize,
    /// Optiboot's RAM page buffer; it is never cleared between pages.
    page_ram: Vec<u8>,
    /// `stk500boot`: the next page its sequential erase pointer will erase.
    erase_address: usize,
    frame: Frame,
    frame_len: usize,
    frame_checksum: u8,
    /// `stk500boot`'s `seqNum`: the sequence number it expects next.
    seq: u8,
    /// Caterina after `E`: running its clock out before it starts the sketch.
    leaving: bool,
    erase_ms: u64,
    /// Reset to the first instruction, in ms. Bytes sent before are lost.
    startup_ms: u64,
    started_at: u64,
    /// Bytes the UART is holding for a bootloader that is not reading yet.
    uart_held: usize,
    /// `ATmegaBOOT`'s `error_count`; never cleared while it runs.
    errors: u8,
    /// How long an answer is on its way to the host.
    answer_delay_ms: u64,
    /// The reset line is not wired: [`reset`](Self::reset) does nothing.
    no_auto_reset: bool,
    /// While the sketch runs it prints this many bytes every so many ms.
    sketch_output: Option<(usize, u64)>,
    /// What the sketch printed is in the outbox up to this time.
    sketch_printed_until: u64,
    /// Where in [`SKETCH_TEXT`] the sketch's next byte is.
    sketch_text_at: usize,
}

impl SimBootloader {
    fn new(model: Model, listen_baud: Option<u32>, page_size: usize, app_size: usize) -> Self {
        Self {
            model,
            listen_baud,
            host_baud: listen_baud.unwrap_or(0),
            page_size,
            now: 0,
            running: false,
            exit: None,
            deadline: 0,
            busy_until: 0,
            outbox: VecDeque::new(),
            rx: Vec::new(),
            flash: vec![0xFF; app_size],
            violations: Vec::new(),
            address: 0,
            pages_written: 0,
            page_ram: vec![0; 256],
            erase_address: 0,
            frame: Frame::Start,
            frame_len: 0,
            frame_checksum: 0,
            seq: 0,
            leaving: false,
            erase_ms: 1800,
            startup_ms: 0,
            started_at: 0,
            uart_held: 0,
            errors: 0,
            answer_delay_ms: 0,
            no_auto_reset: false,
            sketch_output: None,
            sketch_printed_until: 0,
            sketch_text_at: 0,
        }
    }

    /// Optiboot on an `ATmega328P` (Uno, newer Nano), listening at `baud`.
    #[must_use]
    pub fn optiboot(baud: u32) -> Self {
        Self::new(Model::Optiboot, Some(baud), 128, 0x7E00)
    }

    /// `ATmegaBOOT` on an `ATmega328P` (older Nano, Duemilanove), listening at
    /// 57600 baud. Unlike Optiboot it has no watchdog (it starts the sketch
    /// when a byte is too long in coming), ignores "leave programming mode",
    /// and counts protocol errors instead of resetting on the first.
    #[must_use]
    pub fn atmegaboot() -> Self {
        Self::new(Model::AtmegaBoot, Some(57_600), 128, 0x7800)
    }

    /// `stk500boot` on an `ATmega2560` (Mega), listening at 115200 baud.
    #[must_use]
    pub fn stk500boot() -> Self {
        Self::new(Model::Stk500Boot, Some(115_200), 256, 0x3_E000)
    }

    /// Caterina on an `ATmega32U4` (Leonardo, Micro). Native USB: any baud.
    #[must_use]
    pub fn caterina() -> Self {
        Self::new(Model::Caterina, None, 128, 0x7000)
    }

    /// How long Caterina's chip erase (`e`) takes before it answers. A real
    /// one erases and rewrites 224 pages at 3.7 to 4.5 ms each: 1.7 to 2.0 s.
    #[must_use]
    pub fn with_erase_ms(mut self, ms: u32) -> Self {
        self.erase_ms = u64::from(ms);
        self
    }

    /// How long the chip takes from reset to its first instruction. Whatever
    /// the host sends before that is lost. A real AVR needs about 66 ms.
    #[must_use]
    pub fn with_startup_ms(mut self, ms: u32) -> Self {
        self.startup_ms = u64::from(ms);
        self
    }

    /// How long every answer takes to reach the host, as over a slow
    /// USB-serial bridge, a hub or a loaded machine. An answer on its way is
    /// not touched by [`discard_input`](Self::discard_input): it arrives after.
    #[must_use]
    pub fn with_answer_delay_ms(mut self, ms: u32) -> Self {
        self.answer_delay_ms = u64::from(ms);
        self
    }

    /// A board whose reset line is not wired to the host (no auto-reset
    /// capacitor, a bridge without DTR): no reset reaches the chip, and its
    /// sketch keeps running whatever the host does.
    #[must_use]
    pub fn without_auto_reset(mut self) -> Self {
        self.no_auto_reset = true;
        self
    }

    /// A sketch that talks: while it runs it prints `bytes` bytes every
    /// `every_ms` ms, over the same link as the bootloader's answers. Text
    /// from it never starts a bootloader's answer. What the sketch prints is
    /// counted from the host's reads; a bootloader that leaves during a read
    /// starts the printing at the next one.
    #[must_use]
    pub fn with_sketch_output(mut self, bytes: usize, every_ms: u32) -> Self {
        self.sketch_output = Some((bytes, u64::from(every_ms.max(1))));
        self
    }

    /// The chip resets into its bootloader (DTR pulse, 1200-baud touch).
    pub fn reset(&mut self) {
        if self.no_auto_reset {
            return;
        }
        self.running = true;
        self.exit = None;
        self.outbox.clear();
        self.rx.clear();
        self.address = 0;
        self.erase_address = 0;
        self.frame = Frame::Start;
        self.seq = 0;
        self.leaving = false;
        self.uart_held = 0;
        self.errors = 0;
        self.started_at = self.now + self.startup_ms;
        let (boot_ms, listens_ms) = match self.model {
            Model::Optiboot => (OPTIBOOT_BOOT_MS, OPTIBOOT_WATCHDOG_MS),
            Model::AtmegaBoot => (ATMEGABOOT_BOOT_MS, ATMEGABOOT_IDLE_MS),
            Model::Stk500Boot => (0, STK500BOOT_FIRST_BYTE_MS),
            Model::Caterina => (0, CATERINA_TIMEOUT_MS),
        };
        self.busy_until = self.started_at + boot_ms;
        self.deadline = self.busy_until + listens_ms;
    }

    /// The host changed its line rate.
    pub fn set_baud(&mut self, baud: u32) {
        self.host_baud = baud;
    }

    /// Time passes with the host doing nothing.
    pub fn sleep(&mut self, ms: u32) {
        self.now += u64::from(ms);
        self.tick();
    }

    /// The host wrote `bytes`.
    pub fn write(&mut self, bytes: &[u8]) {
        self.tick();
        if !self.running {
            return; // The sketch is running; it does not speak a bootloader protocol.
        }
        if self.now < self.started_at {
            return; // Still in reset: nothing is listening.
        }
        if self.listen_baud.is_some_and(|baud| baud != self.host_baud) {
            // Bytes at the wrong rate arrive as noise.
            match self.model {
                // Not a command followed by CRC_EOP: watchdog reset, sketch.
                Model::Optiboot => self.leave(Exit::Desynced),
                Model::AtmegaBoot => {
                    self.deadline = self.now.max(self.busy_until) + ATMEGABOOT_IDLE_MS;
                    for _ in bytes {
                        if self.running {
                            self.atmegaboot_error();
                        }
                    }
                }
                Model::Stk500Boot | Model::Caterina => {}
            }
            return;
        }
        if self.model == Model::Caterina {
            self.caterina_write(bytes);
            return;
        }
        if self.now >= self.busy_until {
            self.uart_held = 0;
        }
        for &byte in bytes {
            if !self.running {
                break;
            }
            if self.model != Model::Stk500Boot && self.now < self.busy_until {
                // The bootloader is flashing its LED, not reading: the UART
                // keeps two bytes and overruns on the rest.
                if self.uart_held == UART_HELD {
                    self.violation("byte lost: the UART holds two while the bootloader is not reading");
                    continue;
                }
                self.uart_held += 1;
            }
            match self.model {
                Model::Optiboot => {
                    self.deadline = self.now.max(self.busy_until) + OPTIBOOT_WATCHDOG_MS;
                    self.rx.push(byte);
                    self.optiboot_commands();
                }
                Model::AtmegaBoot => {
                    self.deadline = self.now.max(self.busy_until) + ATMEGABOOT_IDLE_MS;
                    self.rx.push(byte);
                    self.atmegaboot_commands();
                }
                Model::Stk500Boot => {
                    self.deadline = self.now + STK500BOOT_IDLE_MS;
                    self.stk500boot_byte(byte);
                }
                Model::Caterina => {}
            }
        }
    }

    /// One host write to Caterina: USB packets, one command each.
    fn caterina_write(&mut self, bytes: &[u8]) {
        for packet in bytes.chunks(USB_PACKET) {
            for (index, &byte) in packet.iter().enumerate() {
                if !self.running {
                    return;
                }
                self.rx.push(byte);
                if self.caterina_command() {
                    // `CDC_Task` handles one command and ends in
                    // `Endpoint_ClearOUT()` (`Caterina.c:711`), which throws
                    // away whatever else came in the same packet.
                    let dropped = packet.len() - index - 1;
                    if dropped > 0 {
                        self.violation(format!(
                            "{dropped} bytes after a command were dropped with the rest of its USB packet"
                        ));
                    }
                    break;
                }
            }
        }
    }

    /// The host reads up to `max` bytes, waiting at most `timeout_ms` for the
    /// first one. Empty means the read timed out.
    pub fn read(&mut self, max: usize, timeout_ms: u32) -> Vec<u8> {
        self.tick();
        self.sketch_prints_until(self.now + u64::from(timeout_ms));
        let Some(&(first_at, _)) = self.outbox.front() else {
            self.sleep(timeout_ms);
            return Vec::new();
        };
        if first_at > self.now + u64::from(timeout_ms) {
            self.sleep(timeout_ms);
            return Vec::new();
        }
        self.now = self.now.max(first_at);
        self.tick();
        let mut out = Vec::new();
        while out.len() < max {
            match self.outbox.front() {
                Some(&(at, byte)) if at <= self.now => {
                    out.push(byte);
                    self.outbox.pop_front();
                }
                _ => break,
            }
        }
        out
    }

    /// The host discards the input it has buffered. Bytes still on their way
    /// are not affected.
    pub fn discard_input(&mut self) {
        self.tick();
        self.sketch_prints_until(self.now);
        while self.outbox.front().is_some_and(|&(at, _)| at <= self.now) {
            self.outbox.pop_front();
        }
    }

    /// The chip's application flash; `0xFF` where nothing was programmed.
    #[must_use]
    pub fn flash(&self) -> &[u8] {
        &self.flash
    }

    /// Flash pages programmed since the model was built.
    #[must_use]
    pub fn pages_written(&self) -> usize {
        self.pages_written
    }

    /// Whether the bootloader (not the sketch) is running right now.
    pub fn in_bootloader(&mut self) -> bool {
        self.tick();
        self.running
    }

    /// How the bootloader last stopped; `None` while it runs or before a reset.
    pub fn exit(&mut self) -> Option<Exit> {
        self.tick();
        self.exit
    }

    /// What a real bootloader would have choked on or dropped.
    #[must_use]
    pub fn violations(&self) -> &[String] {
        &self.violations
    }

    /// The model's clock, in ms.
    #[must_use]
    pub fn now_ms(&self) -> u64 {
        self.now
    }

    fn tick(&mut self) {
        if self.running && self.now >= self.deadline {
            self.leave(if self.leaving { Exit::Left } else { Exit::TimedOut });
        }
    }

    fn leave(&mut self, exit: Exit) {
        self.running = false;
        self.exit = Some(exit);
        self.rx.clear();
        // The sketch prints from now on, not for the time the bootloader ran.
        self.sketch_printed_until = self.sketch_printed_until.max(self.now);
    }

    /// Put what a talking sketch prints up to `until` in the outbox.
    fn sketch_prints_until(&mut self, until: u64) {
        let Some((bytes, every)) = self.sketch_output else { return };
        if self.running || until <= self.sketch_printed_until {
            return;
        }
        let mut at = (self.sketch_printed_until / every + 1) * every;
        while at <= until {
            for _ in 0..bytes {
                let byte = SKETCH_TEXT[self.sketch_text_at];
                self.sketch_text_at = (self.sketch_text_at + 1) % SKETCH_TEXT.len();
                self.outbox.push_back((at + self.answer_delay_ms, byte));
            }
            at += every;
        }
        self.sketch_printed_until = until;
    }

    fn violation(&mut self, what: impl Into<String>) {
        self.violations.push(what.into());
    }

    fn send(&mut self, bytes: &[u8]) {
        let at = self.now.max(self.busy_until) + self.answer_delay_ms;
        self.outbox.extend(bytes.iter().map(|&b| (at, b)));
    }

    /// Program one page: `data` lands at byte offset `at`. `0xFF` elsewhere in
    /// the page unless `fill` gives the rest of it.
    fn program_page(&mut self, at: usize, data: &[u8], fill: Option<&[u8]>) {
        let page = at - at % self.page_size;
        if page + self.page_size > self.flash.len() {
            self.violation(format!("page at {page:#x} is outside the application section"));
            return;
        }
        let offset = at - page;
        if offset + data.len() > self.page_size {
            self.violation(format!("{} bytes at {at:#x} overrun the flash page", data.len()));
            return;
        }
        let target = &mut self.flash[page..page + self.page_size];
        match fill {
            Some(whole) => target.copy_from_slice(&whole[..target.len()]),
            None => target.fill(0xFF),
        }
        target[offset..offset + data.len()].copy_from_slice(data);
        self.pages_written += 1;
    }

    // --- Optiboot (STK500v1) ------------------------------------------------

    fn optiboot_commands(&mut self) {
        const CRC_EOP: u8 = 0x20;
        const STK_INSYNC: u8 = 0x14;
        const STK_OK: u8 = 0x10;
        loop {
            let Some(&command) = self.rx.first() else { return };
            let needed = match command {
                0x41 => 3,          // STK_GET_PARAMETER: which, EOP
                0x42 => 22,         // STK_SET_DEVICE: 20 ignored bytes, EOP
                0x45 => 7,          // STK_SET_DEVICE_EXT: 5 ignored bytes, EOP
                0x55 => 4,          // STK_LOAD_ADDRESS: low, high, EOP
                0x56 => 6,          // STK_UNIVERSAL: 4 ignored bytes, EOP
                0x74 => 5,          // STK_READ_PAGE: 0, length, memtype, EOP
                0x64 => match self.rx.get(2) {
                    // STK_PROG_PAGE: 0, length, memtype, data, EOP. Optiboot
                    // reads the length's low byte only; 0 counts as 256.
                    Some(&low) => 4 + if low == 0 { 256 } else { usize::from(low) } + 1,
                    None => return,
                },
                _ => 2,             // everything else: EOP
            };
            if self.rx.len() < needed {
                return;
            }
            let frame: Vec<u8> = self.rx.drain(..needed).collect();
            if frame[needed - 1] != CRC_EOP {
                // verifySpace(): no INSYNC, watchdog reset into the sketch.
                self.violation(format!("STK500v1 command {command:#04x} not terminated by CRC_EOP"));
                self.leave(Exit::Desynced);
                return;
            }
            self.send(&[STK_INSYNC]);
            match command {
                // The Optiboot version for 0x81/0x82, a generic 3 otherwise.
                0x41 => self.send(&[if matches!(frame[1], 0x81 | 0x82) { 4 } else { 3 }]),
                0x55 => self.address = (usize::from(frame[1]) | usize::from(frame[2]) << 8) * 2,
                0x56 => self.send(&[0x00]),
                0x64 => {
                    if frame[1] != 0 {
                        self.violation("STK_PROG_PAGE length does not fit Optiboot's one length byte");
                    }
                    let data = &frame[4..needed - 1];
                    if self.address % self.page_size != 0 {
                        self.violation(format!("page programmed at unaligned address {:#x}", self.address));
                    }
                    self.page_ram[..data.len()].copy_from_slice(data);
                    // The whole RAM buffer is programmed, so a short last page
                    // carries the tail of the page before it.
                    let ram = self.page_ram.clone();
                    self.program_page(self.address, data, Some(&ram));
                }
                0x74 => {
                    let length = if frame[2] == 0 { 256 } else { usize::from(frame[2]) };
                    let end = (self.address + length).min(self.flash.len());
                    let bytes = self.flash[self.address.min(end)..end].to_vec();
                    self.address = end;
                    self.send(&bytes);
                }
                0x75 => self.send(&ATMEGA328P_SIGNATURE),
                _ => {}
            }
            self.send(&[STK_OK]);
            if command == 0x51 {
                // STK_LEAVE_PROGMODE: 16 ms watchdog, then the sketch.
                self.leave(Exit::Left);
                return;
            }
        }
    }

    // --- ATmegaBOOT (STK500v1) ----------------------------------------------

    /// A wrong terminator or an unknown command: counted, never answered. The
    /// fifth starts the sketch (`ATmegaBOOT_168.c:876`, `:1041`).
    fn atmegaboot_error(&mut self) {
        self.errors += 1;
        if self.errors == ATMEGABOOT_MAX_ERRORS {
            self.leave(Exit::Desynced);
        }
    }

    fn atmegaboot_commands(&mut self) {
        const INSYNC: u8 = 0x14;
        const OK: u8 = 0x10;
        while self.running {
            let Some(&command) = self.rx.first() else { return };
            // Bytes in the whole command, its terminating space included.
            let needed = match command {
                b'0' | b'1' | b'P' | b'R' | b'Q' | b'u' | b'v' => 2,
                // '@': one parameter, two if it is above 0x85.
                b'@' => match self.rx.get(1) {
                    Some(&parameter) => 3 + usize::from(parameter > 0x85),
                    None => return,
                },
                b'A' => 3,  // which parameter
                b'B' => 22, // 20 ignored bytes
                b'E' => 7,  // 5 ignored bytes
                b'U' => 4,  // address: low, high
                b'V' => 6,  // 4 bytes of a universal SPI command
                b't' => 5,  // length: high, low; memory type
                // 'd': length (high, low), memory type, data.
                b'd' => match (self.rx.get(1), self.rx.get(2)) {
                    (Some(&high), Some(&low)) => 4 + (usize::from(high) << 8 | usize::from(low)) + 1,
                    _ => return,
                },
                _ => {
                    self.rx.remove(0);
                    self.violation(format!("ATmegaBOOT does not know command {command:#04x}"));
                    self.atmegaboot_error();
                    continue;
                }
            };
            if self.rx.len() < needed {
                return;
            }
            let frame: Vec<u8> = self.rx.drain(..needed).collect();
            if frame[needed - 1] != b' ' {
                self.violation(format!("STK500v1 command {command:#04x} not terminated by CRC_EOP"));
                self.atmegaboot_error();
                continue;
            }
            self.send(&[INSYNC]);
            match command {
                b'1' => self.send(b"AVR ISP"),
                // Hardware version, software major and minor.
                b'A' => self.send(&[match frame[1] {
                    0x80 => 0x02,
                    0x81 => 0x01,
                    0x82 => 0x10,
                    0x98 => 0x03,
                    _ => 0x00,
                }]),
                // A word address. Programming and reading shift it to a byte
                // address in place, so it must be loaded before each page.
                b'U' => self.address = usize::from(frame[1]) | usize::from(frame[2]) << 8,
                b'V' => {
                    let signature = frame[1] == 0x30;
                    let index = usize::from(frame[3]).min(2);
                    self.send(&[if signature { ATMEGA328P_SIGNATURE[index] } else { 0x00 }]);
                }
                b'd' => {
                    let data = &frame[4..needed - 1];
                    self.address = (self.address << 1) & 0xFFFF;
                    if data.len() > self.page_ram.len() {
                        self.violation(format!("{} bytes overrun ATmegaBOOT's 256-byte buffer", data.len()));
                    } else if frame[3] != b'E' {
                        if self.address % self.page_size != 0 {
                            self.violation(format!("page programmed at unaligned address {:#x}", self.address));
                        }
                        // A page is erased, filled word by word and written
                        // whenever 64 words are in; a short last page is
                        // written as it is, the rest of it erased.
                        for (index, page) in data.chunks(self.page_size).enumerate() {
                            self.program_page(self.address + index * self.page_size, page, None);
                        }
                    }
                }
                b't' => {
                    let length = usize::from(frame[1]) << 8 | usize::from(frame[2]);
                    self.address = (self.address << 1) & 0xFFFF;
                    let end = (self.address + length).min(self.flash.len());
                    let bytes = self.flash[self.address.min(end)..end].to_vec();
                    self.address = end;
                    self.send(&bytes);
                }
                b'u' => self.send(&ATMEGA328P_SIGNATURE),
                b'v' => self.send(&[0x00]),
                // 'Q' (leave programming mode) is answered and changes nothing:
                // this build has no WATCHDOG_MODS, so the sketch starts only
                // when the next byte is too long in coming.
                _ => {}
            }
            self.send(&[OK]);
        }
    }

    // --- stk500boot (STK500v2) ----------------------------------------------

    fn stk500boot_byte(&mut self, byte: u8) {
        const MESSAGE_START: u8 = 0x1B;
        const TOKEN: u8 = 0x0E;
        match self.frame {
            Frame::Start => {
                if byte == MESSAGE_START {
                    self.frame = Frame::Seq;
                    // The checksum covers every byte of the message, MESSAGE_START included.
                    self.frame_checksum = MESSAGE_START;
                }
            }
            Frame::Seq => {
                // The Mega 2560 bootloader as first shipped takes only the
                // number it expects or 1 (`stk500boot.c:723`); the build with
                // `_FIX_ISSUE_505_` takes any. The model is the strict one.
                if byte == 1 || byte == self.seq {
                    self.seq = byte;
                    self.frame_checksum ^= byte;
                    self.frame = Frame::Size1;
                } else {
                    self.violation(format!(
                        "STK500v2 message dropped: sequence number {byte}, expected {} or 1",
                        self.seq
                    ));
                    self.frame = Frame::Start;
                }
            }
            Frame::Size1 => {
                self.frame_len = usize::from(byte) << 8;
                self.frame_checksum ^= byte;
                self.frame = Frame::Size2;
            }
            Frame::Size2 => {
                self.frame_len |= usize::from(byte);
                self.frame_checksum ^= byte;
                self.frame = Frame::Token;
            }
            Frame::Token => {
                if byte == TOKEN {
                    self.frame_checksum ^= byte;
                    self.rx.clear();
                    self.frame = if self.frame_len == 0 { Frame::Check } else { Frame::Data };
                } else {
                    self.violation("STK500v2 message without TOKEN dropped");
                    self.frame = Frame::Start;
                }
            }
            Frame::Data => {
                self.rx.push(byte);
                self.frame_checksum ^= byte;
                if self.rx.len() == self.frame_len {
                    self.frame = Frame::Check;
                }
            }
            Frame::Check => {
                self.frame = Frame::Start;
                if byte == self.frame_checksum {
                    let message = std::mem::take(&mut self.rx);
                    self.stk500boot_command(&message);
                } else {
                    // Dropped without an answer: the host sees a timeout.
                    self.violation(format!(
                        "STK500v2 message dropped: checksum {byte:#04x}, expected {:#04x}",
                        self.frame_checksum
                    ));
                    self.rx.clear();
                }
            }
        }
    }

    fn stk500boot_command(&mut self, message: &[u8]) {
        const STATUS_CMD_OK: u8 = 0x00;
        const STATUS_CMD_FAILED: u8 = 0xC0;
        let Some(&command) = message.first() else { return };
        // Every answer starts with the command id, then the status.
        let mut answer = vec![command, STATUS_CMD_OK];
        match command {
            0x01 => {
                // CMD_SIGN_ON
                answer.push(8);
                answer.extend_from_slice(b"AVRISP_2");
            }
            0x03 => answer.push(0),          // CMD_GET_PARAMETER
            0x02 | 0x10 | 0x11 => {}         // SET_PARAMETER, ENTER_PROGMODE_ISP, LEAVE_PROGMODE_ISP
            0x06 if message.len() >= 5 => {
                // CMD_LOAD_ADDRESS: a big-endian word address.
                let word = u32::from_be_bytes([message[1], message[2], message[3], message[4]]);
                self.address = (word << 1) as usize;
            }
            0x13 if message.len() >= 10 => {
                // CMD_PROGRAM_FLASH_ISP: size, 7 ISP parameter bytes, data.
                let size = usize::from(message[1]) << 8 | usize::from(message[2]);
                let data = &message[10..];
                if size == 0 || size % 2 != 0 {
                    // `do { … size -= 2; } while (size)` never ends on these.
                    self.violation(format!("CMD_PROGRAM_FLASH_ISP with size {size}: must be even and non-zero"));
                } else if data.len() < size {
                    self.violation("CMD_PROGRAM_FLASH_ISP shorter than its size field");
                } else {
                    let erased = self.erase_address;
                    self.erase_address += self.page_size;
                    if self.address - self.address % self.page_size != erased {
                        self.violation(format!(
                            "page at {:#x} programmed, but the page erased was {erased:#x}",
                            self.address
                        ));
                    }
                    self.program_page(self.address, &data[..size], None);
                    self.address += size;
                }
            }
            0x14 if message.len() >= 3 => {
                // CMD_READ_FLASH_ISP
                let size = usize::from(message[1]) << 8 | usize::from(message[2]);
                let end = (self.address + size).min(self.flash.len());
                answer.extend_from_slice(&self.flash[self.address.min(end)..end]);
                answer.push(STATUS_CMD_OK);
                self.address = end;
            }
            0x1B if message.len() >= 5 => {
                // CMD_READ_SIGNATURE_ISP: the index is the fifth byte.
                answer.push(MEGA_SIGNATURE.get(usize::from(message[4])).copied().unwrap_or(0));
                answer.push(STATUS_CMD_OK);
            }
            _ => answer[1] = STATUS_CMD_FAILED, // also CMD_CHIP_ERASE_ISP (0x12)
        }

        let mut reply = vec![0x1B, self.seq, (answer.len() >> 8) as u8, answer.len() as u8, 0x0E];
        reply.extend_from_slice(&answer);
        reply.push(reply.iter().fold(0, |acc, &b| acc ^ b));
        self.send(&reply);
        self.seq = self.seq.wrapping_add(1);
        if command == 0x11 {
            self.leave(Exit::Left);
        }
    }

    // --- Caterina (AVR109) --------------------------------------------------

    /// Handle the command in `rx` if all of it has arrived; `false` if it is
    /// still incomplete.
    fn caterina_command(&mut self) -> bool {
        let Some(&command) = self.rx.first() else { return false };
        let needed = match command {
            b'T' | b'l' => 2,
            b'A' => 3,
            b'B' | b'g' => match (self.rx.get(1), self.rx.get(2), self.rx.get(3)) {
                (Some(&high), Some(&low), Some(&memory)) => {
                    let size = usize::from(high) << 8 | usize::from(low);
                    // A write to flash or EEPROM is followed by its data.
                    4 + if command == b'B' && matches!(memory, b'E' | b'F') { size } else { 0 }
                }
                _ => return false,
            },
            _ => 1,
        };
        if self.rx.len() < needed {
            return false;
        }
        let frame: Vec<u8> = self.rx.drain(..needed).collect();
        match command {
            b'E' => {
                // Leaves in about half a second; answers first.
                self.deadline = self.now + CATERINA_EXIT_MS;
                self.leaving = true;
                self.send(b"\r");
            }
            b'T' | b'L' | b'P' | b'l' => self.send(b"\r"),
            b't' => self.send(&[0x44, 0x00]),
            b'a' => self.send(b"Y"),
            b'A' => {
                self.address = usize::from(frame[1]) << 9 | usize::from(frame[2]) << 1;
                self.send(b"\r");
            }
            b'p' => self.send(b"S"),
            b'S' => self.send(b"CATERIN"),
            b'V' => self.send(b"10"),
            b's' => self.send(&[0x87, 0x95, 0x1E]),
            b'e' => {
                self.flash.fill(0xFF);
                // The answer follows the erase; nothing else is served meanwhile.
                self.busy_until = self.now.max(self.busy_until) + self.erase_ms;
                self.send(b"\r");
            }
            b'b' => self.send(&[b'Y', 0x00, 0x80]),
            b'B' | b'g' => self.caterina_block(command, &frame),
            0x1B => {}
            _ => self.send(b"?"),
        }
        true
    }

    fn caterina_block(&mut self, command: u8, frame: &[u8]) {
        let size = usize::from(frame[1]) << 8 | usize::from(frame[2]);
        let memory = frame[3];
        if !matches!(memory, b'E' | b'F') {
            self.send(b"?");
            return;
        }
        // Block transfers reset the bootloader's timeout.
        self.deadline = self.now + CATERINA_TIMEOUT_MS;
        if memory == b'E' {
            if command == b'g' {
                self.send(&vec![0xFF; size]);
            } else {
                self.send(b"\r");
            }
            self.address += size * 2;
            return;
        }
        if command == b'g' {
            let end = (self.address + size).min(self.flash.len());
            let bytes = self.flash[self.address.min(end)..end].to_vec();
            self.address = end;
            self.send(&bytes);
            return;
        }
        let data = &frame[4..];
        if size % 2 != 0 {
            // The last low byte is fetched and never written.
            self.violation(format!("flash block of {size} bytes: the odd last byte is dropped"));
        }
        let whole = size - size % 2;
        self.program_page(self.address, &data[..whole], None);
        self.address += whole;
        self.send(b"\r");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exchange(sim: &mut SimBootloader, write: &[u8], read: usize) -> Vec<u8> {
        sim.write(write);
        let mut out = Vec::new();
        while out.len() < read {
            let chunk = sim.read(read - out.len(), 500);
            if chunk.is_empty() {
                break;
            }
            out.extend(chunk);
        }
        out
    }

    #[test]
    fn optiboot_answers_only_after_a_reset_and_its_led_flashes() {
        let mut sim = SimBootloader::optiboot(115_200);
        assert_eq!(exchange(&mut sim, &[0x30, 0x20], 2), [] as [u8; 0], "the sketch does not answer");

        sim.reset();
        sim.write(&[0x30, 0x20]);
        assert_eq!(sim.read(2, 100), [] as [u8; 0], "still flashing its LED");
        assert_eq!(sim.read(2, 500), [0x14, 0x10]);
    }

    #[test]
    fn optiboot_starts_the_sketch_after_a_silent_second() {
        let mut sim = SimBootloader::optiboot(115_200);
        sim.reset();
        sim.sleep(1400);
        assert!(!sim.in_bootloader());
        assert_eq!(sim.exit(), Some(Exit::TimedOut));
    }

    #[test]
    fn optiboot_bails_out_on_the_wrong_baud_and_on_a_missing_eop() {
        let mut sim = SimBootloader::optiboot(115_200);
        sim.reset();
        sim.set_baud(57_600);
        sim.write(&[0x30, 0x20]);
        assert_eq!(sim.exit(), Some(Exit::Desynced));

        sim.set_baud(115_200);
        sim.reset();
        sim.write(&[0x30, 0x30]);
        assert_eq!(sim.exit(), Some(Exit::Desynced));
        assert_eq!(sim.violations().len(), 1);
    }

    #[test]
    fn optiboot_programs_a_page_at_the_loaded_word_address() {
        let mut sim = SimBootloader::optiboot(115_200);
        sim.reset();
        sim.sleep(400);
        assert_eq!(exchange(&mut sim, &[0x55, 0x40, 0x00, 0x20], 2), [0x14, 0x10]);
        let mut page = vec![0x64, 0x00, 0x04, b'F', 1, 2, 3, 4];
        page.push(0x20);
        assert_eq!(exchange(&mut sim, &page, 2), [0x14, 0x10]);
        assert_eq!(&sim.flash()[0x80..0x84], [1, 2, 3, 4]);
        assert_eq!(exchange(&mut sim, &[0x75, 0x20], 5), [0x14, 0x1E, 0x95, 0x0F, 0x10]);
    }

    /// While Optiboot flashes its LED nothing reads the UART, which keeps two
    /// bytes: a sync fits, a second one sent on top of it does not.
    #[test]
    fn optiboot_uart_overruns_past_two_bytes_during_the_led_flashes() {
        let mut sim = SimBootloader::optiboot(115_200);
        sim.reset();
        sim.write(&[0x30, 0x20]);
        assert_eq!(sim.violations(), [] as [String; 0]);
        sim.write(&[0x30, 0x20]);
        assert_eq!(sim.violations().len(), 2);
        assert_eq!(sim.read(4, 500), [0x14, 0x10], "only the first sync was heard");
    }

    #[test]
    fn a_chip_still_in_reset_hears_nothing() {
        let mut sim = SimBootloader::stk500boot().with_startup_ms(150);
        sim.reset();
        sim.sleep(100);
        assert_eq!(exchange(&mut sim, &v2_frame(1, &[0x01]), 17), [] as [u8; 0]);
        assert_eq!(sim.violations(), [] as [String; 0]);
    }

    #[test]
    fn atmegaboot_syncs_after_its_led_flash_and_reports_the_328p() {
        let mut sim = SimBootloader::atmegaboot();
        sim.reset();
        sim.write(b"0 ");
        assert_eq!(sim.read(2, 100), [] as [u8; 0], "LED still on");
        assert_eq!(sim.read(2, 200), [0x14, 0x10]);
        assert_eq!(exchange(&mut sim, b"u ", 5), [0x14, 0x1E, 0x95, 0x0F, 0x10]);
    }

    /// "Leave programming mode" is acknowledged and changes nothing; the sketch
    /// starts when no byte has come for about 0.9 s.
    #[test]
    fn atmegaboot_ignores_leave_and_idles_out_into_the_sketch() {
        let mut sim = SimBootloader::atmegaboot();
        sim.reset();
        sim.sleep(250);
        assert_eq!(exchange(&mut sim, b"Q ", 2), [0x14, 0x10]);
        assert!(sim.in_bootloader());
        assert_eq!(exchange(&mut sim, b"0 ", 2), [0x14, 0x10], "still answering");
        sim.sleep(1000);
        assert_eq!(sim.exit(), Some(Exit::TimedOut));
    }

    #[test]
    fn atmegaboot_counts_five_errors_before_it_gives_up() {
        let mut sim = SimBootloader::atmegaboot();
        sim.reset();
        sim.sleep(250);
        for _ in 0..4 {
            assert_eq!(exchange(&mut sim, b"0!", 2), [] as [u8; 0], "an error is not answered");
        }
        assert_eq!(exchange(&mut sim, b"0 ", 2), [0x14, 0x10], "four errors are forgiven");
        sim.write(b"0!");
        assert_eq!(sim.exit(), Some(Exit::Desynced));
    }

    /// The address is a word address, and programming turns it into a byte
    /// address where it stands: it has to be loaded again before each page.
    #[test]
    fn atmegaboot_programs_a_page_and_leaves_a_short_one_erased_past_its_end() {
        let mut sim = SimBootloader::atmegaboot();
        sim.reset();
        sim.sleep(250);
        assert_eq!(exchange(&mut sim, &[b'U', 0x40, 0x00, b' '], 2), [0x14, 0x10]);
        assert_eq!(exchange(&mut sim, &[b'd', 0x00, 0x04, b'F', 1, 2, 3, 4, b' '], 2), [0x14, 0x10]);
        assert_eq!(&sim.flash()[0x80..0x85], [1, 2, 3, 4, 0xFF]);
        assert_eq!(sim.violations(), [] as [String; 0]);

        // Without a new address the next page goes to twice the last one.
        assert_eq!(exchange(&mut sim, &[b'd', 0x00, 0x02, b'F', 9, 9, b' '], 2), [0x14, 0x10]);
        assert_eq!(&sim.flash()[0x100..0x102], [9, 9]);
    }

    /// Frame `body` the way AVR068 and `stk500boot.c` do.
    fn v2_frame(seq: u8, body: &[u8]) -> Vec<u8> {
        let mut frame = vec![0x1B, seq, (body.len() >> 8) as u8, body.len() as u8, 0x0E];
        frame.extend_from_slice(body);
        frame.push(frame.iter().fold(0, |acc, &b| acc ^ b));
        frame
    }

    #[test]
    fn stk500boot_answers_with_the_command_id_then_the_status() {
        let mut sim = SimBootloader::stk500boot();
        sim.reset();
        let answer = exchange(&mut sim, &v2_frame(1, &[0x01]), 17);
        assert_eq!(answer, v2_frame(1, b"\x01\x00\x08AVRISP_2"));
    }

    #[test]
    fn stk500boot_drops_a_message_whose_checksum_skips_message_start() {
        let mut sim = SimBootloader::stk500boot();
        sim.reset();
        let mut frame = v2_frame(1, &[0x01]);
        *frame.last_mut().unwrap() ^= 0x1B;
        assert_eq!(exchange(&mut sim, &frame, 17), [] as [u8; 0]);
        assert_eq!(sim.violations().len(), 1);
    }

    /// Without Arduino's issue-505 fix the bootloader takes the sequence
    /// number it expects next, or 1, and nothing else.
    #[test]
    fn stk500boot_drops_a_message_with_an_unexpected_sequence_number() {
        let mut sim = SimBootloader::stk500boot();
        sim.reset();
        assert_eq!(exchange(&mut sim, &v2_frame(5, &[0x01]), 17), [] as [u8; 0]);
        assert_eq!(sim.violations().len(), 1);
        assert_eq!(exchange(&mut sim, &v2_frame(1, &[0x01]), 17).len(), 17, "1 is always taken");
        assert_eq!(exchange(&mut sim, &v2_frame(2, &[0x10]), 8), v2_frame(2, &[0x10, 0x00]));
        assert_eq!(exchange(&mut sim, &v2_frame(4, &[0x10]), 8), [] as [u8; 0], "3 was next");
    }

    /// It listens about a second for a first byte, then starts the sketch.
    #[test]
    fn stk500boot_starts_the_sketch_when_no_byte_comes_in_its_first_second() {
        let mut sim = SimBootloader::stk500boot();
        sim.reset();
        sim.sleep(1100);
        assert_eq!(sim.exit(), Some(Exit::TimedOut));
        assert_eq!(exchange(&mut sim, &v2_frame(1, &[0x01]), 17), [] as [u8; 0]);
    }

    #[test]
    fn stk500boot_programs_pages_in_order_and_rejects_an_odd_size() {
        let mut sim = SimBootloader::stk500boot();
        sim.reset();
        let mut program = vec![0x13, 0x00, 0x04, 0xC1, 10, 0x40, 0x4C, 0x20, 0, 0];
        program.extend_from_slice(&[9, 8, 7, 6]);
        assert_eq!(exchange(&mut sim, &v2_frame(1, &program), 8), v2_frame(1, &[0x13, 0x00]));
        assert_eq!(&sim.flash()[..5], [9, 8, 7, 6, 0xFF]);

        let odd = [0x13, 0x00, 0x01, 0xC1, 10, 0x40, 0x4C, 0x20, 0, 0, 5];
        sim.write(&v2_frame(2, &odd));
        assert_eq!(sim.violations().len(), 1);
    }

    #[test]
    fn caterina_identifies_erases_slowly_and_programs_blocks() {
        let mut sim = SimBootloader::caterina().with_erase_ms(1900);
        sim.reset();
        assert_eq!(exchange(&mut sim, b"S", 7), b"CATERIN");
        sim.write(b"e");
        assert_eq!(sim.read(1, 1000), [] as [u8; 0], "still erasing");
        assert_eq!(sim.read(1, 1000), b"\r");
        assert_eq!(exchange(&mut sim, &[b'A', 0, 0], 1), b"\r");
        assert_eq!(exchange(&mut sim, &[b'B', 0, 2, b'F', 0xAB, 0xCD], 1), b"\r");
        assert_eq!(&sim.flash()[..3], [0xAB, 0xCD, 0xFF]);
        assert_eq!(exchange(&mut sim, b"E", 1), b"\r");
        sim.sleep(600);
        assert_eq!(sim.exit(), Some(Exit::Left));
    }

    /// One command per write: `CDC_Task` discards the rest of the USB packet.
    #[test]
    fn caterina_drops_what_follows_a_command_in_the_same_packet() {
        let mut sim = SimBootloader::caterina();
        sim.reset();
        sim.write(b"Se");
        assert_eq!(sim.read(8, 100), b"CATERIN");
        assert_eq!(sim.read(1, 3000), [] as [u8; 0], "the erase never arrived");
        assert_eq!(sim.violations().len(), 1);
    }

    #[test]
    fn caterina_gives_up_after_eight_idle_seconds() {
        let mut sim = SimBootloader::caterina();
        sim.reset();
        sim.sleep(8100);
        assert_eq!(sim.exit(), Some(Exit::TimedOut));
    }
}
