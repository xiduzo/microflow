//! Board bring-up policy — one sans-IO state machine shared by both Runtime
//! Hosts (browser `board-controller.ts`, desktop `hardware/mod.rs`).
//!
//! The policy — probe for Firmata → flash `StandardFirmata` if missing →
//! re-probe → connected, plus auto-reconnect on reset/unplug and the
//! disconnected→connecting→flashing→connected→error transitions — lives here
//! once, as a value. Mirrors the runtime's `Effects`/`EffectsSink` discipline
//! (ADR-0006/0008): the machine takes [`Event`]s and returns [`Action`]s; the
//! hosts own all I/O, timers, toasts, and stores.
//!
//! Bring-up is *pre-runtime* hardware setup: this module is independent of the
//! flow engine and ungated, so the lean `microflow-firmata-wasm` crate can ship
//! it to the browser.

use serde::{Deserialize, Serialize};

/// What happened in the host, fed into [`BringUp::handle`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    /// A candidate port is ready to bring up (user gesture, load scan, plug-in
    /// event, or the desktop poll finding a new port).
    ///
    /// `board` is the recognised board id (from USB vid/pid), if any.
    /// `auto_flash` allows flashing `StandardFirmata` when the probe misses.
    /// `explicit` means someone is watching this attempt: failures surface as
    /// `Error` (browser: a user gesture; desktop: any recognised board).
    PortReady {
        board: Option<String>,
        auto_flash: bool,
        explicit: bool,
    },
    /// The Firmata probe/handshake succeeded (the host holds the connection).
    ProbeOk,
    /// The probe found no Firmata (the host tore its probe I/O down itself).
    ProbeFailed,
    /// Flash progress, in flash-driver units.
    FlashProgress { done: u32, total: u32 },
    /// Flashing finished successfully.
    FlashOk,
    /// Flashing failed; `detail` is the driver's error text.
    FlashFailed { detail: String },
    /// The live connection dropped mid-session (board reset; port still there).
    ConnectionLost,
    /// The port physically disappeared (USB unplug).
    PortGone,
    /// The user asked to disconnect.
    DisconnectRequested,
}

/// UI-facing bring-up phase. Hosts map this onto their `BoardState` payload
/// (the desktop fills in port/pins/firmware from its probe result).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Phase {
    Disconnected,
    Connecting,
    Flashing { board: String },
    Connected,
    /// `detail` must reach the user verbatim (commit `7c8f7e2` — board error
    /// details surfaced in the UI); hosts must not collapse it to a bare label.
    Error { detail: String },
}

/// What the host must do next, in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Action {
    /// Run the Firmata probe/handshake on the attempt's port, then feed back
    /// `ProbeOk` / `ProbeFailed`. `after_flash: true` ⇒ the board just got
    /// flashed: wait for its reboot and tolerate USB re-enumeration.
    Probe { after_flash: bool },
    /// Flash `StandardFirmata` for `board` onto the attempt's port, then feed
    /// back `FlashOk` / `FlashFailed` (progress via `FlashProgress`).
    Flash { board: String },
    /// Tear down the live connection / close the port.
    ClosePort,
    /// Try to recover: rescan for the board and feed `PortReady` again.
    ScheduleRetry,
    /// Publish the new phase to the UI.
    Notify { phase: Phase },
    /// Update flash-progress UI (single toast / progress line).
    NotifyFlashProgress { percent: u8 },
}

/// One bring-up attempt's facts, captured at `PortReady`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Attempt {
    board: Option<String>,
    auto_flash: bool,
    explicit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    Idle,
    Probing(Attempt),
    Flashing(Attempt),
    /// Post-flash probe: the board was just flashed and is rebooting.
    Reprobing(Attempt),
    Connected,
}

/// The bring-up state machine. No I/O, no timers, no clock — feed it
/// [`Event`]s, perform the returned [`Action`]s.
#[derive(Debug)]
pub struct BringUp {
    state: State,
}

impl Default for BringUp {
    fn default() -> Self {
        Self::new()
    }
}

impl BringUp {
    #[must_use]
    pub fn new() -> Self {
        Self { state: State::Idle }
    }

    /// True once a probe succeeded and nothing has torn the connection down.
    #[must_use]
    pub fn is_connected(&self) -> bool {
        self.state == State::Connected
    }

    /// Advance the machine. Returns the actions the host must perform, in
    /// order. Events that don't apply to the current state (stale probe
    /// results, a port appearing while already connected) return no actions.
    #[must_use]
    pub fn handle(&mut self, event: Event) -> Vec<Action> {
        // Teardown events share one shape regardless of state.
        match &event {
            Event::DisconnectRequested => {
                let was_idle = self.state == State::Idle;
                self.state = State::Idle;
                return if was_idle {
                    vec![notify(Phase::Disconnected)]
                } else {
                    vec![Action::ClosePort, notify(Phase::Disconnected)]
                };
            }
            Event::PortGone => {
                return match core::mem::replace(&mut self.state, State::Idle) {
                    // Nothing in flight (e.g. the port of a failed attempt was
                    // unplugged) — keep whatever phase the UI shows (an error
                    // must not be overwritten by `disconnected`).
                    State::Idle => {
                        vec![]
                    }
                    State::Connected => vec![Action::ClosePort, notify(Phase::Disconnected)],
                    // Mid-attempt the probe/flash owns its own port teardown.
                    _ => vec![notify(Phase::Disconnected)],
                };
            }
            Event::ConnectionLost => {
                if self.state == State::Connected {
                    self.state = State::Idle;
                    // The port is still present after a reset — retry, mirroring
                    // the desktop poll re-detect and the browser granted rescan.
                    return vec![
                        Action::ClosePort,
                        notify(Phase::Disconnected),
                        Action::ScheduleRetry,
                    ];
                }
                return vec![];
            }
            _ => {}
        }

        match core::mem::replace(&mut self.state, State::Idle) {
            State::Idle => match event {
                Event::PortReady { board, auto_flash, explicit } => {
                    self.state = State::Probing(Attempt { board, auto_flash, explicit });
                    vec![notify(Phase::Connecting), Action::Probe { after_flash: false }]
                }
                _ => vec![],
            },
            State::Probing(attempt) => match event {
                Event::ProbeOk => {
                    self.state = State::Connected;
                    vec![notify(Phase::Connected)]
                }
                Event::ProbeFailed => match attempt.board.clone() {
                    Some(board) if attempt.auto_flash => {
                        self.state = State::Flashing(attempt);
                        vec![
                            notify(Phase::Flashing { board: board.clone() }),
                            Action::Flash { board },
                        ]
                    }
                    board if attempt.explicit => vec![notify(Phase::Error {
                        detail: no_firmata_detail(board.as_deref()),
                    })],
                    // Background attempt (auto-reconnect / plug-in / unknown
                    // device): stay quietly disconnected, no error spam.
                    _ => vec![notify(Phase::Disconnected)],
                },
                other => stay(&mut self.state, State::Probing(attempt), &other),
            },
            State::Flashing(attempt) => match event {
                Event::FlashProgress { done, total } => {
                    self.state = State::Flashing(attempt);
                    vec![Action::NotifyFlashProgress { percent: percent(done, total) }]
                }
                Event::FlashOk => {
                    self.state = State::Reprobing(attempt);
                    vec![notify(Phase::Connecting), Action::Probe { after_flash: true }]
                }
                Event::FlashFailed { detail } => vec![notify(Phase::Error {
                    detail: format!("Flash failed: {detail}"),
                })],
                other => stay(&mut self.state, State::Flashing(attempt), &other),
            },
            State::Reprobing(attempt) => match event {
                Event::ProbeOk => {
                    self.state = State::Connected;
                    vec![notify(Phase::Connected)]
                }
                Event::ProbeFailed => {
                    let board = attempt.board.as_deref().unwrap_or("board");
                    vec![notify(Phase::Error {
                        detail: format!(
                            "Flashed {board}, but it did not come back up with Firmata."
                        ),
                    })]
                }
                other => stay(&mut self.state, State::Reprobing(attempt), &other),
            },
            State::Connected => {
                // Already connected: a new port appearing must not steal the
                // live connection; stale probe/flash results are ignored.
                self.state = State::Connected;
                vec![]
            }
        }
    }
}

/// Restore `state` for an event that doesn't apply to it; no actions.
fn stay(slot: &mut State, state: State, _event: &Event) -> Vec<Action> {
    *slot = state;
    vec![]
}

fn notify(phase: Phase) -> Action {
    Action::Notify { phase }
}

fn percent(done: u32, total: u32) -> u8 {
    if total == 0 {
        return 0;
    }
    ((u64::from(done) * 100 + u64::from(total) / 2) / u64::from(total)).min(100) as u8
}

fn no_firmata_detail(board: Option<&str>) -> String {
    match board {
        Some(board) => format!("No Firmata on {board}."),
        None => "No Firmata firmware responded and the board could not be identified.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port_ready(board: Option<&str>, auto_flash: bool, explicit: bool) -> Event {
        Event::PortReady {
            board: board.map(str::to_string),
            auto_flash,
            explicit,
        }
    }

    #[test]
    fn missing_firmware_flashes_then_connects() {
        let mut m = BringUp::new();
        assert_eq!(
            m.handle(port_ready(Some("nano"), true, true)),
            vec![notify(Phase::Connecting), Action::Probe { after_flash: false }]
        );
        assert_eq!(
            m.handle(Event::ProbeFailed),
            vec![
                notify(Phase::Flashing { board: "nano".into() }),
                Action::Flash { board: "nano".into() }
            ]
        );
        assert_eq!(
            m.handle(Event::FlashOk),
            vec![notify(Phase::Connecting), Action::Probe { after_flash: true }]
        );
        assert_eq!(m.handle(Event::ProbeOk), vec![notify(Phase::Connected)]);
        assert!(m.is_connected());
    }

    #[test]
    fn flash_failure_surfaces_error_with_detail() {
        let mut m = BringUp::new();
        let _ = m.handle(port_ready(Some("uno"), true, true));
        let _ = m.handle(Event::ProbeFailed);
        assert_eq!(
            m.handle(Event::FlashFailed { detail: "sync failed after 3 attempts".into() }),
            vec![notify(Phase::Error { detail: "Flash failed: sync failed after 3 attempts".into() })]
        );
        assert!(!m.is_connected());
    }

    #[test]
    fn post_flash_probe_failure_names_the_board() {
        let mut m = BringUp::new();
        let _ = m.handle(port_ready(Some("nano"), true, true));
        let _ = m.handle(Event::ProbeFailed);
        let _ = m.handle(Event::FlashOk);
        assert_eq!(
            m.handle(Event::ProbeFailed),
            vec![notify(Phase::Error {
                detail: "Flashed nano, but it did not come back up with Firmata.".into()
            })]
        );
    }

    #[test]
    fn reset_mid_session_reconnects() {
        let mut m = BringUp::new();
        let _ = m.handle(port_ready(Some("uno"), false, false));
        let _ = m.handle(Event::ProbeOk);
        assert!(m.is_connected());
        // Board reset: connection dropped, port still present → retry.
        assert_eq!(
            m.handle(Event::ConnectionLost),
            vec![Action::ClosePort, notify(Phase::Disconnected), Action::ScheduleRetry]
        );
        // The retry finds the board again.
        assert_eq!(
            m.handle(port_ready(Some("uno"), false, false)),
            vec![notify(Phase::Connecting), Action::Probe { after_flash: false }]
        );
        assert_eq!(m.handle(Event::ProbeOk), vec![notify(Phase::Connected)]);
    }

    #[test]
    fn unplug_while_flashing_goes_disconnected() {
        let mut m = BringUp::new();
        let _ = m.handle(port_ready(Some("nano"), true, true));
        let _ = m.handle(Event::ProbeFailed);
        assert_eq!(m.handle(Event::PortGone), vec![notify(Phase::Disconnected)]);
        // The flash's eventual failure report is stale — ignored.
        assert_eq!(m.handle(Event::FlashFailed { detail: "port closed".into() }), vec![]);
    }

    #[test]
    fn user_disconnect_during_connect_ignores_stale_probe() {
        let mut m = BringUp::new();
        let _ = m.handle(port_ready(None, false, true));
        assert_eq!(
            m.handle(Event::DisconnectRequested),
            vec![Action::ClosePort, notify(Phase::Disconnected)]
        );
        // A late probe success must not resurrect the connection.
        assert_eq!(m.handle(Event::ProbeOk), vec![]);
        assert!(!m.is_connected());
    }

    #[test]
    fn background_probe_failure_stays_quiet() {
        let mut m = BringUp::new();
        let _ = m.handle(port_ready(Some("uno"), false, false));
        assert_eq!(m.handle(Event::ProbeFailed), vec![notify(Phase::Disconnected)]);
    }

    #[test]
    fn explicit_probe_failure_details_the_error() {
        let mut m = BringUp::new();
        let _ = m.handle(port_ready(None, true, true));
        assert_eq!(
            m.handle(Event::ProbeFailed),
            vec![notify(Phase::Error {
                detail: "No Firmata firmware responded and the board could not be identified."
                    .into()
            })]
        );

        let _ = m.handle(port_ready(Some("mega"), false, true));
        assert_eq!(
            m.handle(Event::ProbeFailed),
            vec![notify(Phase::Error { detail: "No Firmata on mega.".into() })]
        );
    }

    #[test]
    fn second_port_while_connected_is_ignored() {
        let mut m = BringUp::new();
        let _ = m.handle(port_ready(Some("uno"), false, false));
        let _ = m.handle(Event::ProbeOk);
        assert_eq!(m.handle(port_ready(Some("nano"), true, true)), vec![]);
        assert!(m.is_connected());
    }

    #[test]
    fn unplug_after_failed_attempt_keeps_error_phase() {
        let mut m = BringUp::new();
        let _ = m.handle(port_ready(Some("uno"), true, true));
        let _ = m.handle(Event::ProbeFailed);
        let _ = m.handle(Event::FlashFailed { detail: "boom".into() });
        // Unplugging the failed board must not overwrite the error the user is
        // reading with `disconnected`.
        assert_eq!(m.handle(Event::PortGone), vec![]);
    }

    #[test]
    fn flash_progress_maps_to_rounded_percent() {
        let mut m = BringUp::new();
        let _ = m.handle(port_ready(Some("uno"), true, true));
        let _ = m.handle(Event::ProbeFailed);
        assert_eq!(
            m.handle(Event::FlashProgress { done: 1, total: 3 }),
            vec![Action::NotifyFlashProgress { percent: 33 }]
        );
        assert_eq!(
            m.handle(Event::FlashProgress { done: 3, total: 3 }),
            vec![Action::NotifyFlashProgress { percent: 100 }]
        );
        assert_eq!(percent(0, 0), 0);
    }

    #[test]
    fn unexpected_disconnect_from_usb_gone_stops_retry() {
        let mut m = BringUp::new();
        let _ = m.handle(port_ready(Some("uno"), false, false));
        let _ = m.handle(Event::ProbeOk);
        // Physical unplug: no retry (a future plug-in feeds PortReady itself).
        assert_eq!(
            m.handle(Event::PortGone),
            vec![Action::ClosePort, notify(Phase::Disconnected)]
        );
    }

    #[test]
    fn wire_shapes_are_camel_case_tagged() {
        let event: Event =
            serde_json::from_str(r#"{"type":"portReady","board":"nano","autoFlash":true,"explicit":true}"#)
                .expect("event json");
        assert_eq!(event, port_ready(Some("nano"), true, true));
        let json = serde_json::to_string(&Action::Notify {
            phase: Phase::Flashing { board: "nano".into() },
        })
        .expect("action json");
        assert_eq!(json, r#"{"type":"notify","phase":{"kind":"flashing","board":"nano"}}"#);
    }
}
