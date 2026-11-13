//! Board link — the one owner of the desktop board connection.
//!
//! Everything that decides *which* port is the board and *whether* it is
//! connected lives here: the bring-up machine, the port the live connection runs
//! on, the session id the runtime actor holds it under, and the reconnect retry.
//! Nothing else writes connection state.
//!
//! The link is fed **facts** and decides:
//!
//! - [`BoardLink::scan`] — "these ports are present now" (the 250ms poll).
//! - [`BoardLink::session_ended`] — "the runtime's serial I/O on session N
//!   failed" (reported by the actor, see `runtime::host::BoardSession`).
//!
//! Only the board's *own* port leaving is `PortGone`; any other port coming or
//! going is just a port event. A session id scopes every runtime report to the
//! connection it is about, so a late report from a previous connection cannot
//! tear down the current one.
//!
//! A probe blocks (a failed one for ~12s: two bauds × DTR reset + three
//! queries), so a scan makes **at most one** bring-up attempt, and retry delays
//! are measured from when the probe *returned* — port facts are read again
//! between probes. A lost board is retried at 0/1/2/4/8s; after that the link
//! shows an error ("not responding") and keeps one quiet probe every 30s while
//! the port stays present.
//!
//! All I/O — the Firmata probe, flashing, handing the port to the runtime, the
//! Tauri events, and the clock — sits behind the [`LinkIo`] seam: the desktop
//! adapter in `hardware/mod.rs` performs it for real, a fake in the tests
//! records it. The bring-up *policy* stays in [`microflow_core::bringup`]; this
//! module is the desktop adapter's bookkeeping around it.

use super::port_monitor::{PortMonitor, SerialPortInfo};
use super::types::BoardState;
use crate::flasher::{BoardConfig, BoardType};
use microflow_core::flasher::UsbMatch;
use microflow_core::bringup::{Action, BringUp, Event, Phase};
use std::collections::BTreeMap;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

/// Identifies one live board connection, minted by the link per probe. The
/// runtime actor holds the port under it and reports failures by it.
pub type SessionId = u64;

/// The user's answer to a `confirmFlash` board state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlashAnswer {
    /// Flash `StandardFirmata` as the offered board.
    Confirm,
    /// Leave the device alone.
    Decline,
}

/// Fast reconnect attempts after the live connection drops with the port still
/// present (board reset, serial I/O error). The first is immediate.
const RETRY_ATTEMPTS: u32 = 5;
/// Backoff base: attempt `n ≥ 1` waits `RETRY_BASE × 2^(n-1)` (1s, 2s, 4s, 8s)
/// after the previous probe returned.
const RETRY_BASE: Duration = Duration::from_secs(1);
/// Once the fast attempts are spent: one quiet probe this long after the last
/// one returned, for as long as the lost board's port stays present.
const SLOW_RETRY: Duration = Duration::from_secs(30);

/// Everything the board link does to the outside world — the seam that keeps
/// it testable without a board, a serial port, a Tauri app or real time.
pub trait LinkIo {
    /// Run the Firmata probe on `port`. On success the implementation has handed
    /// the open connection to the runtime as `session` and returns its
    /// `Connected` payload. `after_flash`: the board was just flashed and is
    /// rebooting.
    fn probe(&mut self, port: &str, after_flash: bool, session: SessionId) -> Option<BoardState>;
    /// Flash `StandardFirmata` for `board` onto `port`; `Err` carries the
    /// driver's error text verbatim.
    fn flash(&mut self, port: &str, board: BoardType) -> Result<(), String>;
    /// Tear down the live connection (the runtime drops its port).
    fn close(&mut self);
    /// Publish a `board-state` transition.
    fn board_state(&mut self, state: &BoardState);
    /// A serial port appeared.
    fn port_connected(&mut self, port: &SerialPortInfo);
    /// A serial port went away.
    fn port_disconnected(&mut self, port: &SerialPortInfo);
    /// The current time. Read after a probe returns, so retry delays start
    /// when the (blocking) probe ended, not when the scan began.
    fn now(&self) -> Instant;
}

/// A port the link has seen, and whether it may still be tried as the board.
struct KnownPort {
    info: SerialPortInfo,
    /// `true` once probed (or never a candidate: system / non-USB). Reset only
    /// by the port leaving and coming back — or by a reconnect retry.
    probed: bool,
}

/// A pending reconnect to the port the board was lost on.
struct Retry {
    port: String,
    /// Attempts made so far.
    attempt: u32,
    due: Instant,
}

impl Retry {
    /// The fast attempts are spent: probes are now quiet and 30s apart.
    fn is_slow(&self) -> bool {
        self.attempt >= RETRY_ATTEMPTS
    }
}

/// The single owner of the desktop board connection. See the module docs.
pub struct BoardLink<Io: LinkIo> {
    io: Io,
    bringup: BringUp,
    /// Present ports keyed by canonical id; ordered so candidates are tried
    /// deterministically.
    ports: BTreeMap<String, KnownPort>,
    /// Canonical id of the port of the current attempt or live connection.
    board: Option<String>,
    /// Recognised board type of the current attempt (flash target).
    attempt_board: Option<BoardType>,
    /// `Connected` payload from the latest successful probe, published when the
    /// machine says `Phase::Connected`.
    last_connected: Option<BoardState>,
    /// Session of the live connection; `None` while disconnected.
    session: Option<SessionId>,
    next_session: SessionId,
    retry: Option<Retry>,
    /// A slow (post-error) reconnect is in flight: only `Connected` is
    /// published, so the "not responding" error stays up between probes.
    quiet: bool,
}

impl<Io: LinkIo> BoardLink<Io> {
    pub fn new(io: Io) -> Self {
        Self {
            io,
            bringup: BringUp::new(),
            ports: BTreeMap::new(),
            board: None,
            attempt_board: None,
            last_connected: None,
            session: None,
            next_session: 0,
            retry: None,
            quiet: false,
        }
    }

    /// True while a board is connected.
    #[must_use]
    pub fn is_connected(&self) -> bool {
        self.bringup.is_connected()
    }

    /// Port name of the connected board, if any.
    #[cfg(test)]
    pub(crate) fn board_port(&self) -> Option<&str> {
        if !self.is_connected() {
            return None;
        }
        self.board
            .as_ref()
            .and_then(|id| self.ports.get(id))
            .map(|known| known.info.port_name.as_str())
    }

    #[cfg(test)]
    pub(crate) fn io(&self) -> &Io {
        &self.io
    }

    #[cfg(test)]
    pub(crate) fn io_mut(&mut self) -> &mut Io {
        &mut self.io
    }

    /// Fact: these ports are present now. Departures first (only the board's
    /// own port leaving is `PortGone`), then arrivals, then — while no board is
    /// connected — at most one attempt: a due reconnect, else the next untried
    /// candidate.
    pub fn scan(&mut self, ports: Vec<SerialPortInfo>) {
        let current: BTreeMap<String, SerialPortInfo> = ports
            .into_iter()
            .map(|p| (PortMonitor::canonical_id(&p.port_name), p))
            .collect();

        let gone: Vec<String> =
            self.ports.keys().filter(|id| !current.contains_key(*id)).cloned().collect();
        for id in gone {
            self.port_left(&id);
        }

        let mut arrived = Vec::new();
        for (id, info) in current {
            if let Some(known) = self.ports.get_mut(&id) {
                known.info = info;
            } else {
                let probed = !is_candidate(&info);
                if probed {
                    log::debug!("Not a bring-up candidate: {} ({})", info.port_name, info.port_type);
                }
                self.ports.insert(id.clone(), KnownPort { info, probed });
                arrived.push(id);
            }
        }

        self.bring_up_next();

        // Announced after bring-up so `has_firmata` reports the probe outcome.
        for id in arrived {
            if let Some(known) = self.ports.get(&id) {
                let mut info = known.info.clone();
                info.has_firmata = Some(self.is_board(&id));
                log::info!("Port connected: {} (Firmata: {})", info.port_name, self.is_board(&id));
                self.io.port_connected(&info);
            }
        }
    }

    /// Fact: the runtime's serial I/O on `session` failed and it dropped the
    /// port. Ends the live connection (and schedules a reconnect) only if
    /// `session` *is* the live connection — a late report from an earlier one
    /// is ignored.
    pub fn session_ended(&mut self, session: SessionId) {
        if self.session != Some(session) {
            log::debug!("Ignoring end of stale session {session} (live: {:?})", self.session);
            return;
        }
        log::info!("Board session {session} ended without the port leaving; reconnecting");
        self.drive(Event::ConnectionLost);
    }

    /// Feed every session end the runtime reported since the last call — the
    /// monitor tick's first step.
    pub fn drain_session_ends(&mut self, ended: &Receiver<SessionId>) {
        for session in ended.try_iter() {
            self.session_ended(session);
        }
    }

    /// Fact: the user answered the "flash as <board>?" offer. Ignored by the
    /// machine unless an offer is open, so a late answer is harmless.
    pub fn answer_flash(&mut self, answer: FlashAnswer) {
        log::info!("Flash offer answered: {answer:?}");
        self.drive(match answer {
            FlashAnswer::Confirm => Event::FlashConfirmed,
            FlashAnswer::Decline => Event::FlashDeclined,
        });
    }

    /// Feed every flash-offer answer the UI sent since the last call — part of
    /// the monitor tick, so a confirmed flash runs on the monitor thread like
    /// any other bring-up step.
    pub fn drain_flash_answers(&mut self, answers: &Receiver<FlashAnswer>) {
        for answer in answers.try_iter() {
            self.answer_flash(answer);
        }
    }

    fn is_board(&self, id: &str) -> bool {
        self.is_connected() && self.board.as_deref() == Some(id)
    }

    fn port_left(&mut self, id: &str) {
        let Some(known) = self.ports.remove(id) else { return };
        log::info!("Port disconnected: {}", known.info.port_name);
        // A port that comes back is a replug: a fresh candidate, not the tail
        // end of an old reconnect.
        if self.retry.as_ref().is_some_and(|r| r.port == id) {
            self.retry = None;
        }
        if self.board.as_deref() == Some(id) {
            self.drive(Event::PortGone);
            self.board = None;
        }
        let mut info = known.info;
        info.has_firmata = Some(false);
        self.io.port_disconnected(&info);
    }

    /// While no board is connected, make one bring-up attempt: the due
    /// reconnect first, else the next untried candidate. One per scan, so the
    /// next scan's port facts are read between (blocking) probes.
    fn bring_up_next(&mut self) {
        if self.is_connected() {
            return;
        }
        if self.retry.as_ref().is_some_and(|r| r.due <= self.io.now()) {
            self.reconnect();
        } else if let Some(id) =
            self.ports.iter().find(|(_, k)| !k.probed).map(|(id, _)| id.clone())
        {
            self.attempt(&id, false);
        }
        if self.is_connected() {
            self.retry = None;
        }
    }

    /// One reconnect attempt at the lost board's port, then re-arm the retry
    /// from when the probe returned. The attempt that spends the fast budget
    /// surfaces the "not responding" error; later (slow) attempts are quiet.
    fn reconnect(&mut self) {
        let Some((port, slow)) = self.retry.as_ref().map(|r| (r.port.clone(), r.is_slow()))
        else {
            return;
        };
        self.quiet = slow;
        self.attempt(&port, true);
        self.quiet = false;
        if self.is_connected() {
            return;
        }
        let now = self.io.now();
        let Some(retry) = self.retry.as_mut() else { return };
        retry.attempt += 1;
        let delay = if retry.is_slow() { SLOW_RETRY } else { backoff(retry.attempt) };
        retry.due = now + delay;
        if retry.attempt == RETRY_ATTEMPTS {
            let name = self.ports.get(&port).map_or(port.as_str(), |k| k.info.port_name.as_str());
            log::warn!(
                "Board on {name} not responding after {RETRY_ATTEMPTS} attempts; probing every {}s",
                SLOW_RETRY.as_secs()
            );
            let error = not_responding(name);
            self.io.board_state(&BoardState::Error { error: Some(error) });
        }
    }

    /// Start one bring-up attempt on `id`. A `reconnect` is a background
    /// attempt at a board that had Firmata moments ago: it never flashes and
    /// never surfaces the machine's error.
    fn attempt(&mut self, id: &str, reconnect: bool) {
        let Some(known) = self.ports.get_mut(id) else { return };
        known.probed = true;
        let found = known.info.usb_ids().and_then(|(vid, pid)| BoardConfig::identify_usb(vid, pid));
        let board_type = found.map(UsbMatch::board);
        log::info!(
            "Bring-up {} on {} (usb: {found:?})",
            if reconnect { "reconnect" } else { "candidate" },
            known.info.port_name
        );
        self.board = Some(id.to_string());
        self.attempt_board = board_type;
        // A recognised board's failures surface (a recognised board that won't
        // connect is worth an error; a random serial device is not). Only a
        // positively identified one (official Arduino VID) is flashed unasked; a
        // board guessed from a generic USB-serial chip is offered instead
        // (`ConfirmFlash`), since the chip is on plenty of other devices too.
        let recognised = board_type.is_some() && !reconnect;
        self.drive(Event::PortReady {
            board: board_type.map(|b| b.as_str().to_string()),
            auto_flash: recognised && found.and_then(UsbMatch::auto_flash_board).is_some(),
            explicit: recognised,
        });
    }

    /// Feed one event into the shared bring-up machine and perform the actions
    /// it returns. Actions that resolve synchronously (probe, flash) feed their
    /// result straight back in, so one `PortReady` drives the whole bring-up.
    fn drive(&mut self, event: Event) {
        for action in self.bringup.handle(event) {
            self.perform(action);
        }
    }

    fn perform(&mut self, action: Action) {
        let port_name = self.attempt_port_name();
        match action {
            Action::Probe { after_flash } => {
                self.next_session += 1;
                let session = self.next_session;
                if let Some(state) = self.io.probe(&port_name, after_flash, session) {
                    self.session = Some(session);
                    self.last_connected = Some(state);
                    self.drive(Event::ProbeOk);
                } else {
                    self.drive(Event::ProbeFailed);
                }
            }
            Action::Flash { board } => {
                let result = match self.attempt_board.or_else(|| BoardType::from_id(&board)) {
                    Some(board_type) => self.io.flash(&port_name, board_type),
                    None => Err(format!("unknown board type '{board}'")),
                };
                match result {
                    Ok(()) => self.drive(Event::FlashOk),
                    Err(detail) => {
                        log::error!("Flash failed: {detail}");
                        self.drive(Event::FlashFailed { detail });
                    }
                }
            }
            Action::ClosePort => {
                self.session = None;
                self.io.close();
            }
            Action::ScheduleRetry => {
                if let Some(port) = self.board.clone() {
                    self.retry = Some(Retry { port, attempt: 0, due: self.io.now() });
                }
            }
            // The desktop flasher reports no incremental progress today.
            Action::NotifyFlashProgress { .. } => {}
            Action::Notify { phase } => self.publish(&phase),
        }
    }

    fn attempt_port_name(&self) -> String {
        self.board
            .as_ref()
            .and_then(|id| self.ports.get(id))
            .map(|known| known.info.port_name.clone())
            .unwrap_or_default()
    }

    /// Map a machine [`Phase`] onto the `board-state` event, filling host-side
    /// payloads (probe result, port name). `Error.detail` passes through
    /// verbatim — the UI shows it in full (commit `7c8f7e2`).
    fn publish(&mut self, phase: &Phase) {
        if self.quiet && *phase != Phase::Connected {
            return;
        }
        let state = match phase {
            Phase::Connecting => BoardState::Connecting {},
            Phase::Flashing { board } => {
                BoardState::Flashing { port: self.attempt_port_name(), board: board.clone() }
            }
            Phase::Connected => self.last_connected.clone().unwrap_or_else(|| BoardState::Error {
                error: Some("probe succeeded but produced no board state".to_string()),
            }),
            Phase::Disconnected => BoardState::Disconnected {},
            Phase::ConfirmFlash { board } => {
                BoardState::ConfirmFlash { port: self.attempt_port_name(), board: board.clone() }
            }
            Phase::Error { detail } => BoardState::Error { error: Some(detail.clone()) },
        };
        self.io.board_state(&state);
    }
}

/// Only USB ports that are not system ports (Bluetooth, debug consoles, …) are
/// ever probed for Firmata.
fn is_candidate(info: &SerialPortInfo) -> bool {
    info.is_usb() && !PortMonitor::should_skip_firmata_test(&info.port_name)
}

/// Delay before fast reconnect attempt `attempt` (0 = immediate).
fn backoff(attempt: u32) -> Duration {
    match attempt {
        0 => Duration::ZERO,
        n => RETRY_BASE * 2u32.saturating_pow(n - 1),
    }
}

fn not_responding(port_name: &str) -> String {
    format!(
        "The board on {port_name} is not responding. Replug it or press its reset button."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    /// Records every side effect; probes answer from a scripted table and take
    /// `probe_cost` of fake time.
    struct FakeIo {
        clock: Instant,
        probe_cost: Duration,
        /// Ports whose probe finds Firmata.
        firmata: HashSet<String>,
        /// Remaining probe failures per port before it answers.
        fail_next: HashMap<String, u32>,
        /// Every probe (port, start time), in order — on real hardware each is
        /// a DTR reset.
        probes: Vec<(String, Instant)>,
        flashes: Vec<String>,
        /// Whether a flash succeeds (and leaves Firmata on the port).
        flash_ok: bool,
        closes: u32,
        states: Vec<BoardState>,
        appeared: Vec<String>,
        left: Vec<String>,
    }

    impl LinkIo for FakeIo {
        fn probe(&mut self, port: &str, _after_flash: bool, _session: SessionId) -> Option<BoardState> {
            self.probes.push((port.to_string(), self.clock));
            self.clock += self.probe_cost;
            if let Some(n) = self.fail_next.get_mut(port).filter(|n| **n > 0) {
                *n -= 1;
                return None;
            }
            self.firmata.contains(port).then(|| connected(port))
        }
        fn flash(&mut self, port: &str, _board: BoardType) -> Result<(), String> {
            self.flashes.push(port.to_string());
            if !self.flash_ok {
                return Err("no bootloader".to_string());
            }
            self.firmata.insert(port.to_string());
            Ok(())
        }
        fn close(&mut self) {
            self.closes += 1;
        }
        fn board_state(&mut self, state: &BoardState) {
            self.states.push(state.clone());
        }
        fn port_connected(&mut self, port: &SerialPortInfo) {
            self.appeared.push(port.port_name.clone());
        }
        fn port_disconnected(&mut self, port: &SerialPortInfo) {
            self.left.push(port.port_name.clone());
        }
        fn now(&self) -> Instant {
            self.clock
        }
    }

    const UNO: &str = "/dev/cu.usbmodem1101";
    const UNO_2: &str = "/dev/cu.usbmodem2201";
    /// A Prolific PL2303 adapter (e.g. a GPS): USB, but no recognised board.
    const GPS: &str = "/dev/cu.usbserial-gps";

    fn connected(port: &str) -> BoardState {
        BoardState::Connected {
            port: port.to_string(),
            firmware_name: "StandardFirmata.ino".to_string(),
            firmware_version: "2.5".to_string(),
            pins: vec![],
        }
    }

    fn usb(name: &str, vid: u16, pid: u16) -> SerialPortInfo {
        SerialPortInfo {
            port_name: name.to_string(),
            port_type: "USB".to_string(),
            description: None,
            has_firmata: None,
            vid: Some(vid),
            pid: Some(pid),
        }
    }

    fn uno(name: &str) -> SerialPortInfo {
        usb(name, 0x2341, 0x0043)
    }

    fn gps() -> SerialPortInfo {
        usb(GPS, 0x067b, 0x2303)
    }

    fn link_with_firmata(ports: &[&str]) -> BoardLink<FakeIo> {
        BoardLink::new(FakeIo {
            clock: Instant::now(),
            probe_cost: Duration::ZERO,
            firmata: ports.iter().map(|p| (*p).to_string()).collect(),
            fail_next: HashMap::new(),
            probes: Vec::new(),
            flashes: Vec::new(),
            flash_ok: false,
            closes: 0,
            states: Vec::new(),
            appeared: Vec::new(),
            left: Vec::new(),
        })
    }

    /// Advance the fake clock by `ms` (never backwards past a probe) and scan.
    fn scan_after(link: &mut BoardLink<FakeIo>, ms: u64, ports: Vec<SerialPortInfo>) {
        link.io_mut().clock += Duration::from_millis(ms);
        link.scan(ports);
    }

    fn probes(link: &BoardLink<FakeIo>) -> Vec<&str> {
        link.io().probes.iter().map(|(port, _)| port.as_str()).collect()
    }

    fn is_disconnected(state: &BoardState) -> bool {
        matches!(state, BoardState::Disconnected {})
    }

    fn is_error(state: &BoardState) -> bool {
        matches!(state, BoardState::Error { .. })
    }

    #[test]
    fn unrelated_port_unplug_keeps_board_connected() {
        // The live bug: a port that appeared while the board was connected was
        // tagged `has_firmata`, so unplugging it sent `PortGone` and dropped the
        // board — which then re-probed with a DTR reset (reboot, flow state lost).
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)]);
        assert_eq!(link.board_port(), Some(UNO));

        scan_after(&mut link, 250, vec![uno(UNO), gps()]);
        scan_after(&mut link, 250, vec![uno(UNO)]);

        assert_eq!(link.board_port(), Some(UNO), "board stays connected");
        assert_eq!(probes(&link), vec![UNO], "no re-probe, so no DTR reset");
        assert_eq!(link.io().closes, 0);
        assert!(!link.io().states.iter().any(is_disconnected));
        assert_eq!(link.io().left, vec![GPS], "the port event still reaches the UI");
    }

    #[test]
    fn unrelated_port_present_at_startup_unplug_keeps_board_connected() {
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![gps(), uno(UNO)]);
        assert_eq!(link.board_port(), Some(UNO));

        scan_after(&mut link, 250, vec![uno(UNO)]);

        assert_eq!(link.board_port(), Some(UNO));
        assert_eq!(link.io().closes, 0);
        assert!(!link.io().states.iter().any(is_disconnected));
    }

    #[test]
    fn board_unplug_disconnects_then_replug_reconnects() {
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)]);
        assert!(link.is_connected());

        scan_after(&mut link, 250, vec![]);
        assert!(!link.is_connected());
        assert_eq!(link.io().closes, 1);
        assert!(link.io().states.last().is_some_and(is_disconnected));
        assert_eq!(link.io().probes.len(), 1, "an unplug does not retry");

        scan_after(&mut link, 250, vec![uno(UNO)]);
        assert_eq!(link.board_port(), Some(UNO));
        assert_eq!(link.io().probes.len(), 2);
        assert!(matches!(link.io().states.last(), Some(BoardState::Connected { .. })));
    }

    #[test]
    fn lost_session_retries_with_backoff_until_the_board_answers() {
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)]);
        link.io_mut().fail_next.insert(UNO.to_string(), 3);

        link.session_ended(1);
        assert!(!link.is_connected());
        let count = |link: &BoardLink<FakeIo>| link.io().probes.len();

        scan_after(&mut link, 0, vec![uno(UNO)]); // attempt 0: immediate, fails
        assert_eq!(count(&link), 2);
        scan_after(&mut link, 999, vec![uno(UNO)]);
        assert_eq!(count(&link), 2, "backing off");
        scan_after(&mut link, 1, vec![uno(UNO)]); // attempt 1 (+1s), fails
        assert_eq!(count(&link), 3);
        scan_after(&mut link, 1_999, vec![uno(UNO)]);
        assert_eq!(count(&link), 3, "backing off");
        scan_after(&mut link, 1, vec![uno(UNO)]); // attempt 2 (+2s), fails
        assert_eq!(count(&link), 4);
        scan_after(&mut link, 3_999, vec![uno(UNO)]);
        assert_eq!(count(&link), 4, "backing off");
        scan_after(&mut link, 1, vec![uno(UNO)]); // attempt 3 (+4s), answers
        assert_eq!(count(&link), 5);
        assert_eq!(link.board_port(), Some(UNO));

        assert!(link.io().flashes.is_empty(), "a reconnect never flashes");
        assert!(!link.io().states.iter().any(is_error), "recovered before the error");
        scan_after(&mut link, 60_000, vec![uno(UNO)]);
        assert_eq!(count(&link), 5, "no retry once connected");
    }

    #[test]
    fn backoff_is_measured_from_when_the_slow_probe_returned() {
        // A failed real probe blocks ~12s. Delays counted from the scan that
        // started it would all be spent by the next tick: five back-to-back
        // probes, a minute of DTR resets with the monitor thread blocked.
        let probe_cost = Duration::from_secs(12);
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)]);
        link.io_mut().probe_cost = probe_cost;
        link.io_mut().fail_next.insert(UNO.to_string(), u32::MAX);
        link.session_ended(1);

        // A 250ms monitor tick for ten simulated minutes.
        let mut ticks = 0;
        while link.io().clock < link.io().probes[0].1 + Duration::from_secs(600) {
            scan_after(&mut link, 250, vec![uno(UNO)]);
            ticks += 1;
        }
        assert!(ticks > 1_000, "ports were scanned between probes");

        let starts: Vec<Instant> = link.io().probes[1..].iter().map(|(_, at)| *at).collect();
        let gaps: Vec<u64> = starts
            .windows(2)
            .map(|w| (w[1] - (w[0] + probe_cost)).as_millis().try_into().unwrap())
            .collect();
        // Fast backoff, then the slow cadence — each gap within one tick.
        let expected = [1_000, 2_000, 4_000, 8_000, 30_000, 30_000];
        assert!(gaps.len() >= expected.len(), "{gaps:?}");
        for (gap, want) in gaps.iter().zip(expected) {
            assert!((want..want + 250).contains(gap), "gap {gap}ms, expected ~{want}ms ({gaps:?})");
        }
    }

    #[test]
    fn spent_retries_surface_an_error_then_keep_probing_quietly() {
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)]);
        link.io_mut().fail_next.insert(UNO.to_string(), 6);
        link.session_ended(1);

        for _ in 0..(50 * 4) {
            scan_after(&mut link, 250, vec![uno(UNO)]);
        }
        // 5 fast attempts (immediately, then +1/2/4/8s) then one slow one at +30s.
        assert_eq!(link.io().probes.len(), 1 + RETRY_ATTEMPTS as usize + 1);
        let errors: Vec<&BoardState> = link.io().states.iter().filter(|s| is_error(s)).collect();
        assert_eq!(errors.len(), 1, "one error when the fast budget is spent");
        match errors[0] {
            BoardState::Error { error: Some(e) } => assert!(e.contains("not responding"), "{e}"),
            other => panic!("unexpected {other:?}"),
        }
        assert!(link.io().states.last().is_some_and(is_error), "the error stays up while quiet");

        // The second slow probe (+30s) finds the board: it reconnects.
        for _ in 0..(31 * 4) {
            scan_after(&mut link, 250, vec![uno(UNO)]);
        }
        assert_eq!(link.board_port(), Some(UNO));
        assert!(matches!(link.io().states.last(), Some(BoardState::Connected { .. })));
        assert!(link.io().flashes.is_empty());
    }

    #[test]
    fn retry_stops_when_the_port_leaves() {
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)]);
        link.io_mut().fail_next.insert(UNO.to_string(), u32::MAX);
        link.session_ended(1);
        link.scan(vec![uno(UNO)]);
        assert_eq!(link.io().probes.len(), 2);

        scan_after(&mut link, 1_000, vec![]);
        scan_after(&mut link, 30_000, vec![]);
        assert_eq!(link.io().probes.len(), 2, "no retry against an absent port");
    }

    #[test]
    fn port_back_inside_the_retry_window_is_a_fresh_candidate() {
        // A replug mid-retry is a new bring-up: a recognised board without
        // Firmata gets flashed. A stale retry would win instead (it is tried
        // before candidates) and probe it as a no-flash reconnect.
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)]);
        link.io_mut().fail_next.insert(UNO.to_string(), u32::MAX);
        link.session_ended(1);
        link.scan(vec![uno(UNO)]); // reconnect attempt 0 fails; next due in 1s
        assert_eq!(link.io().probes.len(), 2);

        scan_after(&mut link, 500, vec![]); // unplugged…
        scan_after(&mut link, 1_500, vec![uno(UNO)]); // …and back after the retry was due

        assert_eq!(link.io().probes.len(), 3);
        assert_eq!(link.io().flashes, vec![UNO], "treated as a fresh candidate");
        for _ in 0..(60 * 4) {
            scan_after(&mut link, 250, vec![uno(UNO)]);
        }
        assert_eq!(link.io().probes.len(), 3, "no leftover retry probes it again");
    }

    #[test]
    fn one_probe_per_scan_so_port_facts_are_read_between_probes() {
        let adapter = |name: &str| usb(name, 0x067b, 0x2303);
        let (a, b, c) = ("/dev/cu.usbserial-a", "/dev/cu.usbserial-b", "/dev/cu.usbserial-c");
        let mut link = link_with_firmata(&[]);
        link.io_mut().probe_cost = Duration::from_secs(12);

        link.scan(vec![adapter(a), adapter(b), adapter(c)]);
        assert_eq!(probes(&link), vec![a]);
        // `c` is unplugged during that probe: the next scan sees it before
        // probing anything else.
        scan_after(&mut link, 250, vec![adapter(a), adapter(b)]);
        assert_eq!(link.io().left, vec![c]);
        assert_eq!(probes(&link), vec![a, b]);
        scan_after(&mut link, 250, vec![adapter(a), adapter(b)]);
        assert_eq!(probes(&link), vec![a, b]);
    }

    #[test]
    fn probe_failure_on_a_new_port_is_not_retried() {
        // An unrelated device is probed once when it appears, never again — each
        // probe is a DTR reset on somebody else's hardware.
        let mut link = link_with_firmata(&[]);
        for _ in 0..10 {
            scan_after(&mut link, 1_000, vec![gps()]);
        }
        assert_eq!(probes(&link), vec![GPS]);
        assert!(link.io().flashes.is_empty(), "an unrecognised device is never flashed");
        assert!(link.io().states.last().is_some_and(is_disconnected));
    }

    #[test]
    fn two_firmata_boards_keep_the_first_and_fail_over_to_the_second() {
        let mut link = link_with_firmata(&[UNO, UNO_2]);
        link.scan(vec![uno(UNO), uno(UNO_2)]);
        assert_eq!(link.board_port(), Some(UNO));
        assert_eq!(probes(&link), vec![UNO], "the second board is not reset");

        // The idle board leaving does not touch the live one…
        scan_after(&mut link, 250, vec![uno(UNO)]);
        assert_eq!(link.board_port(), Some(UNO));
        assert_eq!(link.io().closes, 0);

        // …and when the live board leaves, the untried one takes over.
        scan_after(&mut link, 250, vec![uno(UNO), uno(UNO_2)]);
        assert_eq!(probes(&link), vec![UNO], "arrived while connected: not probed yet");
        scan_after(&mut link, 250, vec![uno(UNO_2)]);
        assert_eq!(link.board_port(), Some(UNO_2));
        assert_eq!(probes(&link), vec![UNO, UNO_2]);
    }

    #[test]
    fn session_end_surfaces_disconnected_and_stale_ends_are_ignored() {
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)]);

        // A write error mid-session (reported by the actor as session 1 ending).
        link.session_ended(1);
        assert!(!link.is_connected());
        assert_eq!(link.io().closes, 1);
        assert!(link.io().states.last().is_some_and(is_disconnected));

        link.scan(vec![uno(UNO)]);
        assert_eq!(link.board_port(), Some(UNO), "reconnected as session 2");

        // A late report about session 1 must not tear down session 2.
        link.session_ended(1);
        assert_eq!(link.board_port(), Some(UNO));
        assert_eq!(link.io().closes, 1);
    }

    #[test]
    fn board_session_write_error_reaches_the_link_through_the_channel() {
        // Covers `BoardSession::write` → the session-ended channel →
        // `drain_session_ends` (the monitor tick's first step). Not covered:
        // `Actor::write_bytes` (it needs a Tauri `AppHandle`; it only drops the
        // session on `Err`) and the tick's real port scan.
        use crate::runtime::host::BoardSession;
        use std::io::{self, Read, Write};

        struct BrokenPort;
        impl Read for BrokenPort {
            fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
                Err(io::ErrorKind::TimedOut.into())
            }
        }
        impl Write for BrokenPort {
            fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "device unplugged"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)]);

        let (ended_tx, ended_rx) = std::sync::mpsc::channel();
        let mut session = BoardSession::new(1, Box::new(BrokenPort), ended_tx);
        assert!(session.write(&[0x90, 0x01, 0x00]).is_err());

        link.drain_session_ends(&ended_rx);
        assert!(!link.is_connected());
        assert!(link.io().states.last().is_some_and(is_disconnected));
    }

    const NANO: &str = "/dev/cu.wchusbserial1410";

    /// A CH340 Nano clone: the chip's VID/PID only suggests a Nano.
    fn ch340(name: &str) -> SerialPortInfo {
        usb(name, 0x1a86, 0x7523)
    }

    fn is_offer(state: &BoardState) -> bool {
        matches!(state, BoardState::ConfirmFlash { board, .. } if board == "nano")
    }

    #[test]
    fn official_board_without_firmata_is_flashed_unasked() {
        let mut link = link_with_firmata(&[]);
        link.io_mut().flash_ok = true;
        link.scan(vec![uno(UNO)]);
        assert_eq!(link.io().flashes, vec![UNO]);
        assert_eq!(link.board_port(), Some(UNO));
        assert!(!link.io().states.iter().any(|s| matches!(s, BoardState::ConfirmFlash { .. })));
    }

    #[test]
    fn bridge_chip_is_offered_then_flashed_only_once_confirmed() {
        let mut link = link_with_firmata(&[]);
        link.io_mut().flash_ok = true;
        link.scan(vec![ch340(NANO)]);
        assert!(link.io().flashes.is_empty(), "never flashed unasked");
        assert!(link.io().states.last().is_some_and(is_offer));
        assert!(matches!(
            link.io().states.last(),
            Some(BoardState::ConfirmFlash { port, .. }) if port == NANO
        ));

        // Scans while the offer is open neither re-probe nor flash.
        scan_after(&mut link, 250, vec![ch340(NANO)]);
        assert_eq!(probes(&link), vec![NANO]);
        assert!(link.io().flashes.is_empty());

        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(FlashAnswer::Confirm).expect("send");
        link.drain_flash_answers(&rx);
        assert_eq!(link.io().flashes, vec![NANO]);
        assert_eq!(probes(&link), vec![NANO, NANO], "re-probed after the flash");
        assert_eq!(link.board_port(), Some(NANO));
        assert!(matches!(link.io().states.last(), Some(BoardState::Connected { .. })));
    }

    #[test]
    fn declining_the_offer_leaves_the_device_alone() {
        let mut link = link_with_firmata(&[]);
        link.io_mut().flash_ok = true;
        link.scan(vec![ch340(NANO)]);
        link.answer_flash(FlashAnswer::Decline);
        assert!(link.io().states.last().is_some_and(is_disconnected));
        // A late yes after the no does nothing.
        link.answer_flash(FlashAnswer::Confirm);
        scan_after(&mut link, 250, vec![ch340(NANO)]);
        assert!(link.io().flashes.is_empty());
        assert_eq!(probes(&link), vec![NANO], "a declined device is not re-probed");
        assert_eq!(link.io().closes, 0, "the probe already closed the port");
    }

    #[test]
    fn unplug_while_offering_withdraws_the_offer() {
        let mut link = link_with_firmata(&[]);
        link.io_mut().flash_ok = true;
        link.scan(vec![ch340(NANO)]);
        scan_after(&mut link, 250, vec![]);
        assert!(link.io().states.last().is_some_and(is_disconnected));
        link.answer_flash(FlashAnswer::Confirm);
        assert!(link.io().flashes.is_empty(), "a yes after the unplug flashes nothing");
    }

    #[test]
    fn bridge_chip_with_firmata_connects_without_an_offer() {
        let mut link = link_with_firmata(&[NANO]);
        link.scan(vec![ch340(NANO)]);
        assert_eq!(link.board_port(), Some(NANO));
        assert!(!link.io().states.iter().any(|s| matches!(s, BoardState::ConfirmFlash { .. })));
    }

    #[test]
    fn late_answer_never_touches_a_live_board() {
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)]);
        link.answer_flash(FlashAnswer::Decline);
        link.answer_flash(FlashAnswer::Confirm);
        assert_eq!(link.board_port(), Some(UNO));
        assert_eq!(link.io().closes, 0);
        assert!(link.io().flashes.is_empty());
    }

    #[test]
    fn unknown_vid_is_never_flashed_or_offered() {
        let mut link = link_with_firmata(&[]);
        link.io_mut().flash_ok = true;
        // An unknown VID with the Uno's PID: PID-only matching once called it an Uno.
        link.scan(vec![usb("/dev/cu.usbserial-x", 0x1234, 0x0043)]);
        assert!(link.io().flashes.is_empty());
        assert!(!link.io().states.iter().any(|s| matches!(s, BoardState::ConfirmFlash { .. })));
        assert!(link.io().states.last().is_some_and(is_disconnected));
    }

    #[test]
    fn non_usb_and_system_ports_are_never_probed() {
        let mut link = link_with_firmata(&[]);
        let bluetooth = SerialPortInfo {
            port_type: "Bluetooth".to_string(),
            ..usb("/dev/cu.Bluetooth-Incoming-Port", 0, 0)
        };
        let debug_console = usb("/dev/cu.debug-console", 0x1234, 0x0001);
        link.scan(vec![bluetooth, debug_console]);
        assert!(link.io().probes.is_empty());
        assert_eq!(link.io().appeared.len(), 2);
    }

    #[test]
    fn backoff_doubles_from_one_second() {
        let secs: Vec<u64> = (0..5).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(secs, vec![0, 1, 2, 4, 8]);
    }
}
