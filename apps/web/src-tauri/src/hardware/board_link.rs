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
//! All I/O — the Firmata probe, flashing, handing the port to the runtime, and
//! the Tauri events — sits behind the [`LinkIo`] seam: the desktop adapter in
//! `hardware/mod.rs` performs it for real, a fake in the tests records it. The
//! bring-up *policy* stays in [`microflow_core::bringup`]; this module is the
//! desktop adapter's bookkeeping around it.

use super::port_monitor::{PortMonitor, SerialPortInfo};
use super::types::BoardState;
use crate::flasher::{BoardConfig, BoardType};
use microflow_core::bringup::{Action, BringUp, Event, Phase};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// Identifies one live board connection, minted by the link per probe. The
/// runtime actor holds the port under it and reports failures by it.
pub type SessionId = u64;

/// Reconnect attempts after the live connection drops with the port still
/// present (board reset, serial I/O error). The first is immediate.
const RETRY_ATTEMPTS: u32 = 5;
/// Backoff base: attempt `n ≥ 1` waits `RETRY_BASE × 2^(n-1)` (1s, 2s, 4s, 8s).
const RETRY_BASE: Duration = Duration::from_secs(1);

/// Everything the board link does to the outside world — the seam that keeps
/// it testable without a board, a serial port or a Tauri app.
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
    attempt: u32,
    due: Instant,
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
    /// Time of the fact being processed (drives retry scheduling).
    now: Instant,
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
            now: Instant::now(),
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
    /// connected — a due reconnect retry or the next untried candidate.
    pub fn scan(&mut self, ports: Vec<SerialPortInfo>, now: Instant) {
        self.now = now;
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
    pub fn session_ended(&mut self, session: SessionId, now: Instant) {
        if self.session != Some(session) {
            log::debug!("Ignoring end of stale session {session} (live: {:?})", self.session);
            return;
        }
        self.now = now;
        log::info!("Board session {session} ended without the port leaving; reconnecting");
        self.drive(Event::ConnectionLost);
    }

    fn is_board(&self, id: &str) -> bool {
        self.is_connected() && self.board.as_deref() == Some(id)
    }

    fn port_left(&mut self, id: &str) {
        let Some(known) = self.ports.remove(id) else { return };
        log::info!("Port disconnected: {}", known.info.port_name);
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

    /// While no board is connected, try the due reconnect first, then every
    /// untried candidate in order, until one connects or none are left.
    fn bring_up_next(&mut self) {
        while !self.is_connected() {
            if let Some(port) = self.take_due_retry() {
                self.attempt(&port, true);
                continue;
            }
            let Some(id) = self.ports.iter().find(|(_, k)| !k.probed).map(|(id, _)| id.clone())
            else {
                break;
            };
            self.attempt(&id, false);
        }
        if self.is_connected() {
            self.retry = None;
        }
    }

    /// The pending retry if it is due, re-armed for the attempt after it.
    fn take_due_retry(&mut self) -> Option<String> {
        let retry = self.retry.as_mut()?;
        if retry.due > self.now {
            return None;
        }
        let port = retry.port.clone();
        retry.attempt += 1;
        if retry.attempt < RETRY_ATTEMPTS {
            retry.due = self.now + backoff(retry.attempt);
        } else {
            log::warn!("Giving up reconnecting to {port} after {RETRY_ATTEMPTS} attempts");
            self.retry = None;
        }
        Some(port)
    }

    /// Start one bring-up attempt on `id`. A `reconnect` is a background
    /// attempt at a board that had Firmata moments ago: it never flashes and
    /// never surfaces an error.
    fn attempt(&mut self, id: &str, reconnect: bool) {
        let Some(known) = self.ports.get_mut(id) else { return };
        known.probed = true;
        let board_type = known
            .info
            .usb_ids()
            .and_then(|(vid, pid)| BoardConfig::detect_from_usb(vid, pid));
        log::info!(
            "Bring-up {} on {} (board: {board_type:?})",
            if reconnect { "reconnect" } else { "candidate" },
            known.info.port_name
        );
        self.board = Some(id.to_string());
        self.attempt_board = board_type;
        // A recognised board is flashed when it has no Firmata, and its failures
        // surface (a recognised board that won't connect is worth an error; a
        // random serial device is not).
        let recognised = board_type.is_some() && !reconnect;
        self.drive(Event::PortReady {
            board: board_type.map(|b| b.as_str().to_string()),
            auto_flash: recognised,
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
                    self.retry = Some(Retry { port, attempt: 0, due: self.now });
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
        let state = match phase {
            Phase::Connecting => BoardState::Connecting {},
            Phase::Flashing { board } => {
                BoardState::Flashing { port: self.attempt_port_name(), board: board.clone() }
            }
            Phase::Connected => self.last_connected.clone().unwrap_or_else(|| BoardState::Error {
                error: Some("probe succeeded but produced no board state".to_string()),
            }),
            Phase::Disconnected => BoardState::Disconnected {},
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

/// Delay before reconnect attempt `attempt` (0 = immediate).
fn backoff(attempt: u32) -> Duration {
    match attempt {
        0 => Duration::ZERO,
        n => RETRY_BASE * 2u32.saturating_pow(n - 1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    /// Records every side effect; probes answer from a scripted table.
    #[derive(Default)]
    struct FakeIo {
        /// Ports whose probe finds Firmata.
        firmata: HashSet<String>,
        /// Remaining probe failures per port before it answers.
        fail_next: HashMap<String, u32>,
        /// Every probe, in order — on real hardware each is a DTR reset.
        probes: Vec<String>,
        flashes: Vec<String>,
        closes: u32,
        states: Vec<BoardState>,
        appeared: Vec<String>,
        left: Vec<String>,
    }

    impl LinkIo for FakeIo {
        fn probe(&mut self, port: &str, _after_flash: bool, _session: SessionId) -> Option<BoardState> {
            self.probes.push(port.to_string());
            if let Some(n) = self.fail_next.get_mut(port).filter(|n| **n > 0) {
                *n -= 1;
                return None;
            }
            self.firmata.contains(port).then(|| connected(port))
        }
        fn flash(&mut self, port: &str, _board: BoardType) -> Result<(), String> {
            self.flashes.push(port.to_string());
            Err("no bootloader".to_string())
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
        let io = FakeIo {
            firmata: ports.iter().map(|p| (*p).to_string()).collect(),
            ..FakeIo::default()
        };
        BoardLink::new(io)
    }

    fn is_disconnected(state: &BoardState) -> bool {
        matches!(state, BoardState::Disconnected {})
    }

    #[test]
    fn unrelated_port_unplug_keeps_board_connected() {
        // The live bug: a port that appeared while the board was connected was
        // tagged `has_firmata`, so unplugging it sent `PortGone` and dropped the
        // board — which then re-probed with a DTR reset (reboot, flow state lost).
        let t0 = Instant::now();
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)], t0);
        assert_eq!(link.board_port(), Some(UNO));

        link.scan(vec![uno(UNO), gps()], t0 + Duration::from_millis(250));
        link.scan(vec![uno(UNO)], t0 + Duration::from_millis(500));

        assert_eq!(link.board_port(), Some(UNO), "board stays connected");
        assert_eq!(link.io().probes, vec![UNO], "no re-probe, so no DTR reset");
        assert_eq!(link.io().closes, 0);
        assert!(!link.io().states.iter().any(is_disconnected));
        assert_eq!(link.io().left, vec![GPS], "the port event still reaches the UI");
    }

    #[test]
    fn unrelated_port_present_at_startup_unplug_keeps_board_connected() {
        let t0 = Instant::now();
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![gps(), uno(UNO)], t0);
        assert_eq!(link.board_port(), Some(UNO));

        link.scan(vec![uno(UNO)], t0 + Duration::from_millis(250));

        assert_eq!(link.board_port(), Some(UNO));
        assert_eq!(link.io().closes, 0);
        assert!(!link.io().states.iter().any(is_disconnected));
    }

    #[test]
    fn board_unplug_disconnects_then_replug_reconnects() {
        let t0 = Instant::now();
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)], t0);
        assert!(link.is_connected());

        link.scan(vec![], t0 + Duration::from_millis(250));
        assert!(!link.is_connected());
        assert_eq!(link.io().closes, 1);
        assert!(link.io().states.last().is_some_and(is_disconnected));
        assert_eq!(link.io().probes.len(), 1, "an unplug does not retry");

        link.scan(vec![uno(UNO)], t0 + Duration::from_millis(500));
        assert_eq!(link.board_port(), Some(UNO));
        assert_eq!(link.io().probes.len(), 2);
        assert!(matches!(link.io().states.last(), Some(BoardState::Connected { .. })));
    }

    #[test]
    fn lost_session_retries_with_backoff_until_the_board_answers() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)], at(0));
        link.io_mut().fail_next.insert(UNO.to_string(), 3);

        link.session_ended(1, at(1_000));
        assert!(!link.is_connected());
        let probes = |link: &BoardLink<FakeIo>| link.io().probes.len();

        link.scan(vec![uno(UNO)], at(1_000)); // attempt 0: immediate, fails
        assert_eq!(probes(&link), 2);
        link.scan(vec![uno(UNO)], at(1_500));
        assert_eq!(probes(&link), 2, "backing off");
        link.scan(vec![uno(UNO)], at(2_000)); // attempt 1 (+1s), fails
        assert_eq!(probes(&link), 3);
        link.scan(vec![uno(UNO)], at(3_900));
        assert_eq!(probes(&link), 3, "backing off");
        link.scan(vec![uno(UNO)], at(4_000)); // attempt 2 (+2s), fails
        assert_eq!(probes(&link), 4);
        link.scan(vec![uno(UNO)], at(7_999));
        assert_eq!(probes(&link), 4, "backing off");
        link.scan(vec![uno(UNO)], at(8_000)); // attempt 3 (+4s), answers
        assert_eq!(probes(&link), 5);
        assert_eq!(link.board_port(), Some(UNO));

        assert!(link.io().flashes.is_empty(), "a reconnect never flashes");
        assert!(
            !link.io().states.iter().any(|s| matches!(s, BoardState::Error { .. })),
            "a reconnect never surfaces an error"
        );
        link.scan(vec![uno(UNO)], at(60_000));
        assert_eq!(probes(&link), 5, "no retry once connected");
    }

    #[test]
    fn reconnect_gives_up_after_bounded_attempts() {
        let t0 = Instant::now();
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)], t0);
        link.io_mut().fail_next.insert(UNO.to_string(), u32::MAX);
        link.session_ended(1, t0);

        for second in 0..120 {
            link.scan(vec![uno(UNO)], t0 + Duration::from_secs(second));
        }

        assert_eq!(link.io().probes.len(), 1 + RETRY_ATTEMPTS as usize);
        assert!(!link.is_connected());
    }

    #[test]
    fn retry_stops_when_the_port_leaves() {
        let t0 = Instant::now();
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)], t0);
        link.io_mut().fail_next.insert(UNO.to_string(), u32::MAX);
        link.session_ended(1, t0);
        link.scan(vec![uno(UNO)], t0);
        assert_eq!(link.io().probes.len(), 2);

        link.scan(vec![], t0 + Duration::from_secs(1));
        link.scan(vec![], t0 + Duration::from_secs(30));
        assert_eq!(link.io().probes.len(), 2, "no retry against an absent port");
    }

    #[test]
    fn probe_failure_on_a_new_port_is_not_retried() {
        // An unrelated device is probed once when it appears, never again — each
        // probe is a DTR reset on somebody else's hardware.
        let t0 = Instant::now();
        let mut link = link_with_firmata(&[]);
        for second in 0..10 {
            link.scan(vec![gps()], t0 + Duration::from_secs(second));
        }
        assert_eq!(link.io().probes, vec![GPS]);
        assert!(link.io().flashes.is_empty(), "an unrecognised device is never flashed");
        assert!(link.io().states.last().is_some_and(is_disconnected));
    }

    #[test]
    fn two_firmata_boards_keep_the_first_and_fail_over_to_the_second() {
        let t0 = Instant::now();
        let mut link = link_with_firmata(&[UNO, UNO_2]);
        link.scan(vec![uno(UNO), uno(UNO_2)], t0);
        assert_eq!(link.board_port(), Some(UNO));
        assert_eq!(link.io().probes, vec![UNO], "the second board is not reset");

        // The idle board leaving does not touch the live one…
        link.scan(vec![uno(UNO)], t0 + Duration::from_millis(250));
        assert_eq!(link.board_port(), Some(UNO));
        assert_eq!(link.io().closes, 0);

        // …and when the live board leaves, the untried one takes over.
        link.scan(vec![uno(UNO), uno(UNO_2)], t0 + Duration::from_millis(500));
        assert_eq!(link.io().probes, vec![UNO], "arrived while connected: not probed yet");
        link.scan(vec![uno(UNO_2)], t0 + Duration::from_millis(750));
        assert_eq!(link.board_port(), Some(UNO_2));
        assert_eq!(link.io().probes, vec![UNO, UNO_2]);
    }

    #[test]
    fn session_end_surfaces_disconnected_and_stale_ends_are_ignored() {
        let t0 = Instant::now();
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)], t0);

        // A write error mid-session (reported by the actor as session 1 ending).
        link.session_ended(1, t0);
        assert!(!link.is_connected());
        assert_eq!(link.io().closes, 1);
        assert!(link.io().states.last().is_some_and(is_disconnected));

        link.scan(vec![uno(UNO)], t0);
        assert_eq!(link.board_port(), Some(UNO), "reconnected as session 2");

        // A late report about session 1 must not tear down session 2.
        link.session_ended(1, t0 + Duration::from_millis(10));
        assert_eq!(link.board_port(), Some(UNO));
        assert_eq!(link.io().closes, 1);
    }

    #[test]
    fn write_error_in_the_runtime_session_disconnects_the_link() {
        // End to end across the seam: the actor's session fails a write, reports
        // its id over the channel, and the link (fed that fact) disconnects.
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

        let t0 = Instant::now();
        let mut link = link_with_firmata(&[UNO]);
        link.scan(vec![uno(UNO)], t0);

        let (ended_tx, ended_rx) = std::sync::mpsc::channel();
        let mut session = BoardSession::new(1, Box::new(BrokenPort), ended_tx);
        assert!(session.write(&[0x90, 0x01, 0x00]).is_err());

        for id in ended_rx.try_iter() {
            link.session_ended(id, t0);
        }
        assert!(!link.is_connected());
        assert!(link.io().states.last().is_some_and(is_disconnected));
    }

    #[test]
    fn non_usb_and_system_ports_are_never_probed() {
        let t0 = Instant::now();
        let mut link = link_with_firmata(&[]);
        let bluetooth = SerialPortInfo {
            port_type: "Bluetooth".to_string(),
            ..usb("/dev/cu.Bluetooth-Incoming-Port", 0, 0)
        };
        let debug_console = usb("/dev/cu.debug-console", 0x1234, 0x0001);
        link.scan(vec![bluetooth, debug_console], t0);
        assert!(link.io().probes.is_empty());
        assert_eq!(link.io().appeared.len(), 2);
    }

    #[test]
    fn backoff_doubles_from_one_second() {
        let secs: Vec<u64> = (0..5).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(secs, vec![0, 1, 2, 4, 8]);
    }
}
