//! PN532 NFC Reader — Input (I2C command/response driver).
//!
//! Unlike the register-mapped sensors behind [`I2cDevice`](super::i2c_device),
//! the PN532 is an NFC controller with a **command/response frame protocol**
//! (NXP UM0701-02): there is no register to stream. Reading a card UID means
//! building a checksummed frame, writing it, waiting for the PN532 to process,
//! polling a status/RDY byte, reading the response frame, verifying its
//! checksums, and parsing the UID — then re-issuing for the next read.
//!
//! ## Two-clock driver (sans-IO)
//! The node never blocks. It is driven by:
//! - **`schedule_wakeup("_tick", …)`** — issues the next I2C op (write a frame,
//!   or request a read). Re-armed inside the handler like [`Interval`].
//! - **`on_i2c_reply`** — feeds returned bytes into the [state machine](St),
//!   which decides the next step.
//!
//! Every wait is a *short read + retry*, never a blocking "wait for the device"
//! read — that RDY-poll is what keeps the PN532 from clock-stretching long
//! enough to wedge a no-timeout AVR `Wire` bus (see `docs/PN532_NFC.md`).
//!
//! ## Scope (V1)
//! Reads the UID of one ISO14443-A target (Mifare/NTAG) and emits it as an
//! uppercase hex string on the `value` handle, firing on change. Codegen is not
//! implemented — the Arduino export falls back to a placeholder (the
//! `Adafruit_PN532` path is a future follow-up; see the design doc).

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, HardwareComponent, ListenerWiring,
    RuntimeContext, RuntimeError,
};
pub use crate::config::pn532::Pn532Config;

// --- Protocol constants ----------------------------------------------------

/// `SAMConfiguration` payload (`TFI + PD`): normal mode, timeout `0x14`, use IRQ.
/// Puts the SAM in normal mode so the reader is usable after power-on.
const SAM_CONFIGURATION: &[u8] = &[0xD4, 0x14, 0x01, 0x14, 0x01];

/// `InListPassiveTarget` payload (`TFI + PD`): detect 1 target (`MaxTg=01`) at
/// 106 kbps ISO14443 type A (`BrTy=00`).
const IN_LIST_PASSIVE_TARGET: &[u8] = &[0xD4, 0x4A, 0x01, 0x00];

/// TFI byte for a PN532 → host frame. The host → PN532 direction is `0xD4`.
const TFI_FROM_PN532: u8 = 0xD5;
/// Response code for `InListPassiveTarget` (`command + 1`).
const RESP_IN_LIST: u8 = 0x4B;

/// Bytes to read when consuming the `SAMConfiguration` ACK: status byte + the
/// 6-byte ACK frame (`00 00 FF 00 FF 00`).
const ACK_READ_LEN: i32 = 7;
/// Bytes to read when polling for the `InListPassiveTarget` response: status byte
/// + up to a 23-byte response (enough for a 7-byte NTAG/Ultralight UID).
const RESP_READ_LEN: i32 = 24;

/// One-shot delay after power-on / `i2c_config` before the first command, so the
/// bus and module have settled.
const BOOT_DELAY_MS: u64 = 50;
/// Gap between writing a command and reading its reply — the PN532 ACKs within
/// ~1 ms; this gives `StandardFirmata`'s async write→reply room to sequence.
const SETTLE_MS: u64 = 5;
/// Gap between successive response-poll reads (and the read watchdog): short, so
/// the device is never asked to stretch the clock while we wait.
const READ_GAP_MS: u64 = 20;
/// Response-poll reads before giving up this cycle and re-issuing the command.
/// Bounds the fast poll loop when no card is in the field (`~MAX × READ_GAP`).
const MAX_READ_ATTEMPTS: u8 = 8;

/// Where the driver is in the command/response handshake. Each state names what
/// the *next* stimulus (tick or reply) should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum St {
    /// Fresh (or restarting): the next tick writes `SAMConfiguration`.
    Start,
    /// SAM frame written; the next tick issues the ACK read.
    SamSettle,
    /// ACK read issued; the next reply (skip-validated) starts polling.
    SamRead,
    /// Between poll cycles: the next tick writes a fresh `InListPassiveTarget`.
    /// Detection is one-shot, so every cycle must re-issue the command — not just
    /// re-read, or a card is only ever detected once.
    PollIdle,
    /// `InListPassiveTarget` written; the next tick issues the response read.
    PollSettle,
    /// Response read issued; the next reply is parsed for a UID.
    PollRead,
}

pub struct Pn532 {
    base: ComponentBase,
    config: Pn532Config,
    state: St,
    /// Consecutive not-ready / ACK-only response reads this poll cycle.
    read_attempts: u8,
}

impl Pn532 {
    #[must_use]
    pub fn new(id: String, config: Pn532Config) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::String(String::new())),
            config,
            state: St::Start,
            read_attempts: 0,
        }
    }

    fn address(&self) -> i32 {
        i32::from(self.config.address)
    }

    /// Write a command frame, then arm a tick to read its reply after a settle.
    fn send(&mut self, ctx: &mut RuntimeContext, payload: &[u8], next: St) -> Result<(), RuntimeError> {
        let frame = build_frame(payload);
        ctx.i2c().i2c_write(self.address(), &frame)?;
        self.state = next;
        ctx.schedule_wakeup("_tick", SETTLE_MS);
        Ok(())
    }

    /// Issue a one-shot read of `len` bytes, then arm a watchdog tick: if the
    /// reply is lost, the watchdog fires in `next` and retries.
    fn read(&mut self, ctx: &mut RuntimeContext, len: i32, next: St) -> Result<(), RuntimeError> {
        ctx.i2c().i2c_read(self.address(), len)?;
        self.state = next;
        ctx.schedule_wakeup("_tick", READ_GAP_MS);
        Ok(())
    }

    fn send_sam(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.send(ctx, SAM_CONFIGURATION, St::SamSettle)
    }

    fn send_poll(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.read_attempts = 0;
        self.send(ctx, IN_LIST_PASSIVE_TARGET, St::PollSettle)
    }

    /// A tick elapsed. Issue the next op for the current state; a tick arriving in
    /// a `*Read` state is a watchdog (the reply was lost) — resend the command.
    fn tick(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        match self.state {
            St::Start | St::SamRead => self.send_sam(ctx),
            St::SamSettle => self.read(ctx, ACK_READ_LEN, St::SamRead),
            // Idle → (re)issue the detection command; a PollRead tick is the
            // watchdog after a lost reply — both re-write `InListPassiveTarget`.
            St::PollIdle | St::PollRead => self.send_poll(ctx),
            St::PollSettle => self.read(ctx, RESP_READ_LEN, St::PollRead),
        }
    }

    /// Reply bytes arrived for the read we issued. Only a reply we're actually
    /// waiting for cancels the read watchdog and advances; a stray/late reply
    /// (e.g. one that lands after the watchdog already re-issued the command) is
    /// ignored and must NOT touch the pending timer, or the machine stalls.
    fn reply(&mut self, bytes: &[u8], ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        match self.state {
            // SAM ACK/response is not validated — any reply means the module
            // accepted the config; start looking for a card.
            St::SamRead => {
                ctx.cancel_wakeup("_tick");
                self.send_poll(ctx)
            }
            St::PollRead => {
                ctx.cancel_wakeup("_tick");
                self.handle_poll_reply(bytes, ctx)
            }
            _ => Ok(()),
        }
    }

    fn handle_poll_reply(&mut self, bytes: &[u8], ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        match parse_reply(bytes) {
            Reply::Card(uid) => {
                // `set_value` emits `value` only on change, so a card held in the
                // field won't re-fire, and re-presenting the same card is quiet.
                self.base.set_value(ComponentValue::String(uid_hex(&uid)));
                self.schedule_next_poll(ctx);
                Ok(())
            }
            Reply::NoCard => {
                self.schedule_next_poll(ctx);
                Ok(())
            }
            // The response for this poll isn't here yet (RDY clear, or we read the
            // ACK / a leftover SAM response). Read again shortly, bounded so an
            // empty field doesn't spin — then re-issue the command next cycle.
            Reply::NotReady | Reply::Ack | Reply::Nack | Reply::Malformed => {
                self.read_attempts = self.read_attempts.saturating_add(1);
                if self.read_attempts >= MAX_READ_ATTEMPTS {
                    self.schedule_next_poll(ctx);
                } else {
                    self.read(ctx, RESP_READ_LEN, St::PollRead)?;
                }
                Ok(())
            }
        }
    }

    /// Arm the next `InListPassiveTarget` cycle after the configured poll interval.
    /// Lands in `PollIdle` so the tick *re-issues* the command (one-shot
    /// detection); parking in `PollSettle` would only re-read a spent buffer and
    /// the reader would detect a card exactly once.
    fn schedule_next_poll(&mut self, ctx: &mut RuntimeContext) {
        self.read_attempts = 0;
        self.state = St::PollIdle;
        ctx.schedule_wakeup("_tick", u64::from(self.config.poll_interval_ms));
    }
}

impl Component for Pn532 {
    fn ports() -> &'static [&'static str] {
        // Autonomous reader: no edge inputs in V1. It polls once the flow runs.
        &[]
    }

    fn emits() -> &'static [&'static str] {
        &[ComponentBase::VALUE_HANDLE]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Pn532"
    }

    /// Register for replies at the module's address. A one-shot `i2c_read` sends
    /// no register, so replies carry register `0`; listening on register `0`
    /// matches them (and the runtime's register-mismatch fallback delivers even
    /// if the echoed register is unexpected). Registering also makes the runtime
    /// enable the I2C bus (`i2c_config`) centrally.
    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        vec![ListenerWiring::I2cAddress { address: self.config.address, register: 0 }]
    }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> {
        Some(self)
    }

    fn dispatch(
        &mut self,
        method: &str,
        _args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        Err(RuntimeError::ComponentError(format!("Pn532: unknown method '{method}'")))
    }

    fn dispatch_internal(
        &mut self,
        method: &str,
        _value: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "tick" => self.tick(ctx),
            _ => Err(RuntimeError::ComponentError(format!("Pn532: unknown internal method '{method}'"))),
        }
    }

    /// Arm the first tick to kick the handshake, exactly like `Interval`.
    fn on_start(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.state = St::Start;
        self.read_attempts = 0;
        ctx.schedule_wakeup("_tick", BOOT_DELAY_MS);
        Ok(())
    }

    fn destroy(&mut self) {
        self.state = St::Start;
    }
}

impl HardwareComponent for Pn532 {
    fn initialize(&mut self, _ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        // I2C bus enable is a single global Firmata setting reconciled centrally
        // in `update_flow` (this node registers an I2C listener, so the bus is
        // enabled before `on_start` arms the first tick). Nothing per-node here.
        Ok(())
    }

    fn on_i2c_reply(&mut self, bytes: &[u8], ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        // The runtime already unmarshaled the reply to raw bytes at the dispatch
        // site, so feed the frame state machine directly.
        self.reply(bytes, ctx)?;
        Ok(())
    }
}

impl ComponentBuilder for Pn532 {
    type Config = Pn532Config;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

// --- Pure protocol helpers (fully unit-testable without hardware) ----------

/// Wrap a `TFI + PD` payload in a PN532 normal information frame:
/// `00 00 FF LEN LCS <payload> DCS 00`, where
/// - `LEN` = payload length (`TFI + PD` count),
/// - `LCS` = length checksum, `(LEN + LCS) & 0xFF == 0`,
/// - `DCS` = data checksum, `(ΣPD + DCS) & 0xFF == 0` (payload includes the TFI).
///
/// Works for either direction, so tests reuse it to synthesize PN532 → host
/// response frames (`payload` beginning with `0xD5`).
fn build_frame(payload: &[u8]) -> Vec<u8> {
    let len = payload.len() as u8;
    let lcs = len.wrapping_neg();
    let dcs = payload.iter().copied().fold(0u8, u8::wrapping_add).wrapping_neg();
    let mut frame = Vec::with_capacity(payload.len() + 7);
    frame.extend_from_slice(&[0x00, 0x00, 0xFF, len, lcs]);
    frame.extend_from_slice(payload);
    frame.push(dcs);
    frame.push(0x00);
    frame
}

/// Classification of one PN532 read (status byte + frame bytes).
#[derive(Debug, PartialEq, Eq)]
enum Reply {
    /// Status/RDY bit clear — the rest of the read is meaningless; retry.
    NotReady,
    /// Command-received acknowledgement (`00 00 FF 00 FF 00`).
    Ack,
    /// Negative acknowledgement (`00 00 FF FF 00 00`).
    Nack,
    /// A valid `InListPassiveTarget` response with a card: the UID bytes.
    Card(Vec<u8>),
    /// A valid `InListPassiveTarget` response reporting no target in the field.
    NoCard,
    /// Framing/checksum error, or a response we don't handle.
    Malformed,
}

/// Parse one PN532 I2C read. `read[0]` is the status/RDY byte the module
/// prefixes to every read; `read[1..]` is the frame.
fn parse_reply(read: &[u8]) -> Reply {
    let Some((&status, frame)) = read.split_first() else {
        return Reply::Malformed;
    };
    if status & 0x01 == 0 {
        return Reply::NotReady;
    }
    if frame.starts_with(&[0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00]) {
        return Reply::Ack;
    }
    if frame.starts_with(&[0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00]) {
        return Reply::Nack;
    }
    parse_in_list_response(frame)
}

/// Parse a normal information frame carrying an `InListPassiveTarget` response,
/// verifying the length and data checksums before trusting the UID.
fn parse_in_list_response(frame: &[u8]) -> Reply {
    // Locate the `00 FF` start-of-packet, tolerating leading padding bytes.
    let Some(sop) = frame.windows(2).position(|w| w == [0x00, 0xFF]) else {
        return Reply::Malformed;
    };
    let rest = &frame[sop + 2..];
    let [len, lcs, body @ ..] = rest else {
        return Reply::Malformed;
    };
    // Length checksum: (LEN + LCS) & 0xFF == 0.
    if len.wrapping_add(*lcs) != 0 {
        return Reply::Malformed;
    }
    let len = *len as usize;
    // body = <len data bytes> DCS <postamble…>
    if len == 0 || body.len() < len + 1 {
        return Reply::Malformed;
    }
    let data = &body[..len];
    let dcs = body[len];
    // Data checksum: (Σdata + DCS) & 0xFF == 0 (data includes the TFI).
    if data.iter().copied().fold(0u8, u8::wrapping_add).wrapping_add(dcs) != 0 {
        return Reply::Malformed;
    }
    // data = TFI(D5) CODE(4B) NbTg [Tg SENS_RES(2) SEL_RES IDLen NFCID1…]
    if data[0] != TFI_FROM_PN532 || data.get(1) != Some(&RESP_IN_LIST) {
        return Reply::Malformed;
    }
    match data.get(2) {
        Some(0) => Reply::NoCard,
        Some(_) => {
            // Honour IDLen (4 for Mifare/Classic, 7 for NTAG/Ultralight); never
            // assume 4. Layout: [3]=Tg [4,5]=SENS_RES [6]=SEL_RES [7]=IDLen [8..]=UID.
            let Some(&id_len) = data.get(7) else {
                return Reply::Malformed;
            };
            let start = 8;
            let end = start + id_len as usize;
            if id_len == 0 || end > data.len() {
                return Reply::Malformed;
            }
            Reply::Card(data[start..end].to_vec())
        }
        None => Reply::Malformed,
    }
}

/// Uppercase, separator-free hex of a UID, e.g. `[0x04, 0xA2]` → `"04A2"`.
fn uid_hex(uid: &[u8]) -> String {
    use std::fmt::Write;
    uid.iter().fold(String::with_capacity(uid.len() * 2), |mut s, b| {
        let _ = write!(s, "{b:02X}");
        s
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firmata::FirmataClient;
    use crate::runtime::{BufferBoardWriter, EventSink, ScheduleRequests};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;

    // ---- Pure frame + parse tests (no hardware) --------------------------

    #[test]
    fn command_frames_match_the_known_good_bytes() {
        // The exact frames from the datasheet / design doc — a regression guard
        // on the checksum maths.
        assert_eq!(
            build_frame(SAM_CONFIGURATION),
            vec![0x00, 0x00, 0xFF, 0x05, 0xFB, 0xD4, 0x14, 0x01, 0x14, 0x01, 0x02, 0x00],
            "`SAMConfiguration` frame",
        );
        assert_eq!(
            build_frame(IN_LIST_PASSIVE_TARGET),
            vec![0x00, 0x00, 0xFF, 0x04, 0xFC, 0xD4, 0x4A, 0x01, 0x00, 0xE1, 0x00],
            "`InListPassiveTarget` frame",
        );
    }

    #[test]
    fn build_frame_checksums_satisfy_the_zero_sum_property() {
        for payload in [SAM_CONFIGURATION, IN_LIST_PASSIVE_TARGET, &[0xD5, 0x4B, 0x00][..]] {
            let f = build_frame(payload);
            let len = f[3];
            let lcs = f[4];
            assert_eq!(len.wrapping_add(lcs), 0, "(LEN+LCS) must be 0 mod 256");
            let dcs = f[f.len() - 2];
            let sum = payload.iter().copied().fold(0u8, u8::wrapping_add);
            assert_eq!(sum.wrapping_add(dcs), 0, "(Σpayload+DCS) must be 0 mod 256");
        }
    }

    /// Wrap a response payload as the module would return it over I2C: a RDY
    /// status byte, then the framed payload.
    fn ready_read(payload: &[u8]) -> Vec<u8> {
        let mut read = vec![0x01];
        read.extend_from_slice(&build_frame(payload));
        read
    }

    fn in_list_response(uid: &[u8]) -> Vec<u8> {
        // TFI D5, code 4B, NbTg 1, Tg 1, SENS_RES 00 04, SEL_RES 08, IDLen, UID.
        let mut payload = vec![0xD5, 0x4B, 0x01, 0x01, 0x00, 0x04, 0x08, uid.len() as u8];
        payload.extend_from_slice(uid);
        ready_read(&payload)
    }

    #[test]
    fn parse_extracts_a_4_byte_uid() {
        let uid = [0x04, 0xA2, 0xB1, 0xC3];
        assert_eq!(parse_reply(&in_list_response(&uid)), Reply::Card(uid.to_vec()));
    }

    #[test]
    fn parse_extracts_a_7_byte_uid_honouring_id_len() {
        // NTAG/Ultralight are 7-byte — the parser must not assume 4.
        let uid = [0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
        assert_eq!(parse_reply(&in_list_response(&uid)), Reply::Card(uid.to_vec()));
    }

    #[test]
    fn parse_reports_no_card_when_nbtg_is_zero() {
        let read = ready_read(&[0xD5, 0x4B, 0x00]);
        assert_eq!(parse_reply(&read), Reply::NoCard);
    }

    #[test]
    fn parse_recognises_ack_and_nack_and_not_ready() {
        assert_eq!(parse_reply(&[0x01, 0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00]), Reply::Ack);
        assert_eq!(parse_reply(&[0x01, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00]), Reply::Nack);
        // Status bit clear: the frame bytes are meaningless even if present.
        assert_eq!(parse_reply(&[0x00, 0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00]), Reply::NotReady);
    }

    #[test]
    fn parse_rejects_a_bad_data_checksum() {
        let mut read = in_list_response(&[0x04, 0xA2, 0xB1, 0xC3]);
        // Corrupt a UID byte without fixing the DCS → checksum must fail.
        let last = read.len() - 3; // one UID byte, before DCS + postamble
        read[last] ^= 0xFF;
        assert_eq!(parse_reply(&read), Reply::Malformed);
    }

    #[test]
    fn uid_hex_is_uppercase_and_padded() {
        assert_eq!(uid_hex(&[0x04, 0xA2, 0x0B, 0xC3]), "04A20BC3");
    }

    // ---- State-machine tests (drive ctx like switch.rs) ------------------

    struct Harness {
        client: FirmataClient,
        sink: EventSink,
        now_ms: f64,
    }

    impl Harness {
        fn new() -> Self {
            Self { client: FirmataClient::new(), sink: Rc::new(RefCell::new(VecDeque::new())), now_ms: 0.0 }
        }

        /// Run one closure with a fresh per-turn `RuntimeContext`, returning the
        /// outbound bytes it produced.
        fn turn(&mut self, node: &mut Pn532, f: impl FnOnce(&mut Pn532, &mut RuntimeContext)) -> Vec<u8> {
            let mut out = Vec::new();
            let mut writer = BufferBoardWriter::new(&mut self.client, &mut out);
            let mut reqs = ScheduleRequests::default();
            let mut ctx = RuntimeContext::new(&mut writer, self.now_ms, "nfc", &mut reqs);
            f(node, &mut ctx);
            out
        }

        fn tick(&mut self, node: &mut Pn532) -> Vec<u8> {
            self.turn(node, |n, ctx| n.dispatch_internal("tick", ComponentValue::default(), ctx).unwrap())
        }

        fn reply(&mut self, node: &mut Pn532, bytes: &[u8]) -> Vec<u8> {
            self.turn(node, |n, ctx| n.on_i2c_reply(bytes, ctx).unwrap())
        }

        fn emitted_value(&self) -> Option<ComponentValue> {
            self.sink
                .borrow()
                .iter()
                .rev()
                .find(|e| &*e.source_handle == ComponentBase::VALUE_HANDLE)
                .map(|e| e.value.clone())
        }
    }

    fn node() -> Pn532 {
        let mut n = Pn532::new("nfc".into(), Pn532Config::default());
        n.set_sink(Rc::new(RefCell::new(VecDeque::new())));
        n
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn handshake_writes_sam_then_poll_then_emits_the_uid() {
        let mut h = Harness::new();
        let mut n = Pn532::new("nfc".into(), Pn532Config::default());
        n.set_sink(h.sink.clone());

        let addr = i32::from(Pn532Config::default().address);
        let sam = h.client.encode_i2c_write(addr, &build_frame(SAM_CONFIGURATION));
        let poll = h.client.encode_i2c_write(addr, &build_frame(IN_LIST_PASSIVE_TARGET));

        // on_start arms the first tick.
        h.turn(&mut n, |n, ctx| n.on_start(ctx).unwrap());

        // tick#1: writes `SAMConfiguration`.
        let out = h.tick(&mut n);
        assert!(contains(&out, &sam), "first tick must write `SAMConfiguration`, got {out:02X?}");

        // tick#2: issues the ACK read (no command write).
        let out = h.tick(&mut n);
        assert!(!contains(&out, &sam) && !contains(&out, &poll), "second tick only reads");

        // ACK reply → writes `InListPassiveTarget`.
        let out = h.reply(&mut n, &[0x01, 0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00]);
        assert!(contains(&out, &poll), "SAM reply must write `InListPassiveTarget`, got {out:02X?}");

        // tick: issues the response read.
        h.tick(&mut n);

        // Response reply with a card → emits the UID hex string.
        h.reply(&mut n, &in_list_response(&[0x04, 0xA2, 0xB1, 0xC3]));
        assert_eq!(h.emitted_value(), Some(ComponentValue::String("04A2B1C3".to_string())));
    }

    #[test]
    fn re_reads_when_the_response_is_not_ready_then_gives_up_and_repolls() {
        let mut h = Harness::new();
        let mut n = node();
        // Force into the response-read state.
        n.state = St::PollRead;

        // A not-ready read re-issues a read (stays in the poll loop).
        let out = h.reply(&mut n, &[0x00]); // status bit clear
        let addr = i32::from(Pn532Config::default().address);
        let read = h.client.encode_i2c_read(addr, RESP_READ_LEN);
        assert!(contains(&out, &read), "not-ready reply must read again, got {out:02X?}");
        assert_eq!(n.state, St::PollRead);

        // After MAX_READ_ATTEMPTS not-ready reads, it stops looping and schedules
        // the next poll cycle instead (bounds the spin on an empty field).
        n.read_attempts = MAX_READ_ATTEMPTS - 1;
        h.reply(&mut n, &[0x00]);
        assert_eq!(n.state, St::PollIdle, "must fall back to re-issuing the command");
        assert_eq!(n.read_attempts, 0);
    }

    #[test]
    fn polls_again_for_a_new_card_after_reading_one() {
        // Regression: after the first card the reader must re-issue
        // `InListPassiveTarget` every cycle (detection is one-shot). Parking in a
        // read-only state made it detect a card exactly once and go deaf.
        let mut h = Harness::new();
        let mut n = Pn532::new("nfc".into(), Pn532Config::default());
        n.set_sink(h.sink.clone());
        let addr = i32::from(Pn532Config::default().address);
        let poll = h.client.encode_i2c_write(addr, &build_frame(IN_LIST_PASSIVE_TARGET));

        // First card read leaves the machine idle between cycles.
        n.state = St::PollRead;
        h.reply(&mut n, &in_list_response(&[0x04, 0xA2, 0xB1, 0xC3]));
        assert_eq!(n.state, St::PollIdle);

        // The next poll tick must RE-WRITE `InListPassiveTarget` (the bug: it read
        // a spent buffer instead), then read and surface a *different* card.
        let out = h.tick(&mut n);
        assert!(contains(&out, &poll), "next cycle must re-issue `InListPassiveTarget`, got {out:02X?}");
        assert_eq!(n.state, St::PollSettle);

        h.tick(&mut n); // PollSettle → issue the response read
        h.reply(&mut n, &in_list_response(&[0x11, 0x22, 0x33, 0x44]));
        assert_eq!(h.emitted_value(), Some(ComponentValue::String("11223344".to_string())));
    }

    #[test]
    fn a_late_reply_in_a_non_read_state_is_ignored() {
        // If a watchdog already re-issued the command (state left a `*Read`), a
        // late reply must be a no-op: it must NOT emit and must NOT advance state,
        // so it can't cancel the freshly-armed tick and stall the machine.
        let mut h = Harness::new();
        let mut n = node();
        n.set_sink(h.sink.clone());
        n.state = St::PollSettle;

        h.reply(&mut n, &in_list_response(&[0x04, 0xA2, 0xB1, 0xC3]));
        assert_eq!(n.state, St::PollSettle, "a stray reply must not change state");
        assert_eq!(h.emitted_value(), None, "a stray reply must not emit");
    }

    #[test]
    fn no_card_schedules_the_next_poll_without_emitting() {
        let mut h = Harness::new();
        let mut n = node();
        n.set_sink(h.sink.clone());
        n.state = St::PollRead;

        h.reply(&mut n, &ready_read(&[0xD5, 0x4B, 0x00]));
        assert_eq!(n.state, St::PollIdle);
        assert_eq!(h.emitted_value(), None, "an empty field must not emit a value");
    }
}
