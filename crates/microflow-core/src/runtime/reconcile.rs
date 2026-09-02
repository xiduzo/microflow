//! Board reconcile planner — the outbound-setup twin of [`FlowRouter`].
//!
//! [`FlowRouter`](crate::runtime::FlowRouter) is the seam for one *inbound* event's
//! fanout; this module is the seam for one `update_flow`'s *outbound* board setup.
//! Given the previous board state and the wiring the live components want this
//! turn, [`plan_board`] returns a [`BoardPlan`] — the ordered board operations to
//! emit — as a **pure value**. `FlowRuntime::update_flow` does nothing but gather
//! the inputs, call `plan_board`, and encode the plan onto the wire; every
//! protocol quirk that used to be smeared across the executor (the digital
//! per-PORT diff, the MAX-vote folds, the `StandardFirmata` stop-count drain)
//! lives here, in one deep module, testable without a board or a runtime.
//!
//! The plan is split into two phases because per-node `HardwareComponent::initialize`
//! (device power-on writes) must run *between* them: a device is configured before
//! its continuous read is armed.
//! - **setup** (before init): reporting reconcile, I2C bus config, sampling interval.
//! - **arm** (after init): drain existing continuous reads, then start the desired set.

use crate::runtime::board::BoardWriter;
use crate::runtime::wiring::{BoardWiring, I2cContinuousRead, ListenerWiring};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// The desired board configuration gathered from the live components this turn.
/// Built by `update_flow` while it walks `listener_wiring()` / `board_wiring()`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DesiredBoard {
    /// pin → `is_analog` wanted this turn (the reporting set).
    pub report: HashMap<u8, bool>,
    /// Whether any component registered an I2C listener (⇒ enable the bus even if
    /// nothing streams, e.g. a command/response PN532).
    pub has_i2c_listeners: bool,
    /// MAX sampling-interval vote (ms) across components, if any streams.
    pub max_interval_ms: Option<u32>,
    /// MAX I2C read-delay vote (µs) across components, if any no-hold sensor needs one.
    pub max_i2c_delay_us: Option<u32>,
    /// Continuous reads to arm this turn.
    pub i2c_reads: Vec<I2cContinuousRead>,
}

/// The ordered board operations one `update_flow` must emit. Fields are grouped by
/// the two apply phases (see the module docs); within a phase they encode in field
/// order. Vecs are sorted so the plan — and therefore the emitted bytes — are
/// deterministic regardless of `HashMap` iteration order.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct BoardPlan {
    // --- setup phase (before per-node initialize) ---
    /// Analog channels to start reporting (pin numbers; independent per channel).
    pub analog_enable: Vec<u8>,
    /// Analog channels to stop reporting.
    pub analog_disable: Vec<u8>,
    /// Digital ports to start reporting, as pin selectors (`port * 8`).
    pub digital_enable: Vec<u8>,
    /// Digital ports to stop reporting, as pin selectors (`port * 8`).
    pub digital_disable: Vec<u8>,
    /// I2C bus config with the reconciled read-delay (µs), if any I2C listener.
    pub i2c_config_delay: Option<i32>,
    /// The global sampling interval (ms) to set, if any component voted.
    pub sampling_interval_ms: Option<i32>,
    // --- arm phase (after per-node initialize) ---
    /// I2C addresses to `stop_reading`, one entry per previously-armed query.
    pub i2c_stops: Vec<i32>,
    /// I2C continuous reads to arm.
    pub i2c_reads: Vec<I2cContinuousRead>,
}

/// The inbound routing tables one `update_flow` rebuilds from the live
/// components' [`ListenerWiring`]. Runtime state, not board state — the board
/// half of the same walk is the [`DesiredBoard`] gathered alongside it.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ListenerTables {
    /// Pin → listening component ids (the inbound `_pin_change` routing table).
    pub pin_listeners: HashMap<u8, Vec<Arc<str>>>,
    /// I2C address → `(register, component id)` listeners.
    pub i2c_listeners: HashMap<u8, Vec<(u8, Arc<str>)>>,
    /// Hotkey accelerator (lowercased) → listening component ids.
    pub key_listeners: HashMap<String, Vec<Arc<str>>>,
}

/// Walk every live component's wiring once, splitting it into the inbound
/// routing tables and the [`DesiredBoard`] the planner reconciles.
///
/// Takes the wiring as plain data rather than the component map, so the gather
/// is testable as a value — no `Component` to construct, no runtime.
///
/// Hotkeys are delivered by the host (keyboard) via `dispatch_key_event`, not
/// the board, so they land in the tables and contribute nothing to the board.
pub fn gather_wiring<'a, I>(wirings: I) -> (ListenerTables, DesiredBoard)
where
    I: IntoIterator<Item = (&'a str, Vec<ListenerWiring>, BoardWiring)>,
{
    let mut tables = ListenerTables::default();
    let mut desired = DesiredBoard::default();
    let mut report: HashMap<u8, bool> = HashMap::new();

    for (id, listeners, board) in wirings {
        for wiring in listeners {
            match wiring {
                ListenerWiring::DigitalPin { pin } => {
                    tables.pin_listeners.entry(pin).or_default().push(Arc::from(id));
                    report.insert(pin, false);
                }
                ListenerWiring::AnalogPin { pin, .. } => {
                    tables.pin_listeners.entry(pin).or_default().push(Arc::from(id));
                    report.insert(pin, true);
                }
                ListenerWiring::I2cAddress { address, register } => {
                    tables.i2c_listeners.entry(address).or_default().push((register, Arc::from(id)));
                }
                ListenerWiring::HotKey { accelerator } => {
                    tables.key_listeners.entry(accelerator).or_default().push(Arc::from(id));
                }
            }
        }

        // Board-wide votes: the slowest sensor sets the shared pace/read-delay
        // (reconciled to the MAX in the planner), and each streamer contributes
        // one continuous read.
        if let Some(ms) = board.sampling_interval_ms {
            desired.max_interval_ms = desired.max_interval_ms.max(Some(ms));
        }
        if let Some(us) = board.i2c_read_delay_us {
            desired.max_i2c_delay_us = desired.max_i2c_delay_us.max(Some(us));
        }
        if let Some(r) = board.i2c_continuous_read {
            desired.i2c_reads.push(r);
        }
    }

    desired.has_i2c_listeners = !tables.i2c_listeners.is_empty();
    desired.report = report;
    (tables, desired)
}

impl BoardPlan {
    /// Emit the **setup** phase: reporting reconcile, I2C bus config, sampling
    /// interval. Runs *before* per-node `HardwareComponent::initialize`, so the
    /// board is configured before any device's power-on writes land.
    ///
    /// A failed op is logged and skipped rather than aborting the phase: one
    /// unusable pin must not stop the rest of the board coming up.
    pub fn encode_setup(&self, writer: &mut impl BoardWriter) {
        for &pin in &self.analog_enable {
            // A failure here (pin not flagged analog in the seeded table) means
            // the board will never stream this pin — surface it; a silent drop
            // here cost a full debugging session.
            if let Err(e) = writer.enable_analog_reporting(pin) {
                log::warn!("enable analog reporting failed for pin {pin}: {e}");
            }
        }
        for &pin in &self.analog_disable {
            let _ = writer.disable_analog_reporting(pin);
        }
        for &sel in &self.digital_enable {
            if let Err(e) = writer.enable_digital_reporting(sel) {
                log::warn!("enable digital reporting failed for selector {sel}: {e}");
            }
        }
        for &sel in &self.digital_disable {
            let _ = writer.disable_digital_reporting(sel);
        }
        if let Some(delay) = self.i2c_config_delay {
            if let Err(e) = writer.i2c_config(delay) {
                log::warn!("i2c_config (read-delay {delay}us) failed: {e}");
            }
        }
        if let Some(ms) = self.sampling_interval_ms {
            if let Err(e) = writer.sampling_interval(ms) {
                log::warn!("set sampling interval {ms}ms failed: {e}");
            }
        }
    }

    /// Emit the **arm** phase: drain every previously-armed continuous read,
    /// then start the desired set. Runs *after* per-node initialize, so each
    /// device is configured before its stream starts.
    pub fn encode_arm(&self, writer: &mut impl BoardWriter) {
        for &addr in &self.i2c_stops {
            if let Err(e) = writer.i2c_stop_reading(addr) {
                log::warn!("i2c_stop_reading 0x{addr:02X} failed: {e}");
            }
        }
        for r in &self.i2c_reads {
            if let Err(e) = writer.i2c_read_continuous(
                i32::from(r.address),
                i32::from(r.register),
                i32::from(r.length),
            ) {
                log::warn!("i2c_read_continuous 0x{:02X} failed: {e}", r.address);
            }
        }
    }
}

/// Group a reporting set's *digital* pins into the 8-pin PORTs they belong to.
/// `REPORT_DIGITAL(port)` covers pins `port*8 ..= port*8+7`, so digital reporting
/// must reconcile at PORT granularity — a port stays enabled while *any* listened
/// pin maps to it. (Reconciling per pin disabled the whole port when one sibling
/// pin vanished, silently killing the other inputs on it.)
fn digital_ports(report: &HashMap<u8, bool>) -> HashSet<u8> {
    report.iter().filter(|(_, &is_analog)| !is_analog).map(|(&pin, _)| pin / 8).collect()
}

fn sorted<T: Ord>(mut v: Vec<T>) -> Vec<T> {
    v.sort_unstable();
    v
}

/// Compute the board operations for one `update_flow` from the previous state and
/// the desired wiring. Pure: same inputs → same plan.
///
/// - `prev_report` — the reporting set currently enabled on the wire (`pin →
///   is_analog`), diffed against `desired.report`.
/// - `prev_i2c_counts` — `address → number of continuous queries` currently armed
///   on the board, so the drain can stop each address *exactly* that many times.
// Always called with the runtime's std `HashMap`s; generalizing an internal
// planner over hashers would be noise for zero caller benefit.
#[allow(clippy::implicit_hasher)]
#[must_use]
pub fn plan_board(
    prev_report: &HashMap<u8, bool>,
    prev_i2c_counts: &HashMap<u8, usize>,
    desired: &DesiredBoard,
) -> BoardPlan {
    // Analog: independent per channel — enable newly-needed, disable gone.
    let analog_enable = sorted(
        desired
            .report
            .iter()
            .filter(|(pin, &is_analog)| is_analog && !prev_report.contains_key(pin))
            .map(|(&pin, _)| pin)
            .collect(),
    );
    let analog_disable = sorted(
        prev_report
            .iter()
            .filter(|(pin, &is_analog)| is_analog && !desired.report.contains_key(pin))
            .map(|(&pin, _)| pin)
            .collect(),
    );

    // Digital: per PORT — a port is needed while any digital pin maps to it. The
    // selector is the port's first pin (`port * 8`), which `enable_digital_reporting`
    // keys back to the port via `pin / 8`.
    let needed = digital_ports(&desired.report);
    let prev = digital_ports(prev_report);
    let digital_enable = sorted(needed.difference(&prev).map(|&p| p * 8).collect());
    let digital_disable = sorted(prev.difference(&needed).map(|&p| p * 8).collect());

    // I2C bus config (read-delay) once if any I2C listener — done centrally, not
    // per-node, so the last node can't zero another's required delay. MAX vote; 0
    // when no no-hold sensor needs a gap.
    let i2c_config_delay = desired
        .has_i2c_listeners
        .then(|| i32::try_from(desired.max_i2c_delay_us.unwrap_or(0)).unwrap_or(i32::MAX));

    // Global sampling interval to the slowest sensor's rate. None ⇒ leave the
    // firmware default untouched.
    let sampling_interval_ms =
        desired.max_interval_ms.map(|ms| i32::try_from(ms).unwrap_or(i32::MAX));

    // Arm: STOP each address exactly as many times as it previously had queries —
    // enough to drain it, never more (an extra stop clears an innocent sibling's
    // lone query on StandardFirmata). The arm-all that follows repairs any
    // accidental clear, so the board always ends equal to the desired set.
    let mut i2c_stops = Vec::new();
    for addr in sorted(prev_i2c_counts.keys().copied().collect()) {
        for _ in 0..prev_i2c_counts[&addr] {
            i2c_stops.push(i32::from(addr));
        }
    }
    let mut i2c_reads = desired.i2c_reads.clone();
    i2c_reads.sort_unstable_by_key(|r| (r.address, r.register, r.length));

    BoardPlan {
        analog_enable,
        analog_disable,
        digital_enable,
        digital_disable,
        i2c_config_delay,
        sampling_interval_ms,
        i2c_stops,
        i2c_reads,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firmata::{FirmataClient, Pin, I2C_MODE_READ_CONTINUOUS};
    use crate::runtime::board::BufferBoardWriter;

    fn report(pins: &[(u8, bool)]) -> HashMap<u8, bool> {
        pins.iter().copied().collect()
    }

    /// A 20-pin board whose `analog` pins are flagged, so `encode_setup` can
    /// resolve an analog channel the way the live codec does.
    fn client_with_analog(analog: &[u8]) -> FirmataClient {
        let mut client = FirmataClient::new();
        client.pins = vec![Pin::default(); 20];
        for &pin in analog {
            client.pins[pin as usize].analog = true;
        }
        client
    }

    fn setup_bytes(plan: &BoardPlan, analog: &[u8]) -> Vec<u8> {
        let mut client = client_with_analog(analog);
        let mut out = Vec::new();
        plan.encode_setup(&mut BufferBoardWriter::new(&mut client, &mut out));
        out
    }

    fn arm_bytes(plan: &BoardPlan) -> Vec<u8> {
        let mut client = client_with_analog(&[]);
        let mut out = Vec::new();
        plan.encode_arm(&mut BufferBoardWriter::new(&mut client, &mut out));
        out
    }

    #[test]
    fn unchanged_flow_plans_nothing() {
        // Re-applying the same reporting set + no I2C ⇒ an all-empty plan (no bytes).
        let set = report(&[(2, false), (14, true)]);
        let desired = DesiredBoard { report: set.clone(), ..Default::default() };
        assert_eq!(plan_board(&set, &HashMap::new(), &desired), BoardPlan::default());
    }

    #[test]
    fn analog_channels_enable_and_disable_by_diff() {
        let prev = report(&[(14, true)]);
        let desired = DesiredBoard { report: report(&[(15, true)]), ..Default::default() };
        let plan = plan_board(&prev, &HashMap::new(), &desired);
        assert_eq!(plan.analog_enable, vec![15]);
        assert_eq!(plan.analog_disable, vec![14]);
    }

    #[test]
    fn digital_reporting_reconciles_per_port_not_per_pin() {
        // Two pins share port 0; dropping one must NOT disable the port.
        let prev = report(&[(2, false), (3, false)]);
        let desired = DesiredBoard { report: report(&[(2, false)]), ..Default::default() };
        let plan = plan_board(&prev, &HashMap::new(), &desired);
        assert!(plan.digital_disable.is_empty(), "sibling pin still needs the port");

        // Once the last pin on the port goes, the port IS disabled (selector 0).
        let cleared = DesiredBoard::default();
        let plan = plan_board(&prev, &HashMap::new(), &cleared);
        assert_eq!(plan.digital_disable, vec![0]);
    }

    #[test]
    fn i2c_config_fires_for_a_listener_even_with_no_stream() {
        // A command/response device (PN532) registers a listener but streams
        // nothing — the bus must still be enabled, at delay 0.
        let desired = DesiredBoard { has_i2c_listeners: true, ..Default::default() };
        let plan = plan_board(&HashMap::new(), &HashMap::new(), &desired);
        assert_eq!(plan.i2c_config_delay, Some(0));
        assert!(plan.i2c_reads.is_empty() && plan.i2c_stops.is_empty());
    }

    #[test]
    fn votes_reconcile_to_the_max() {
        let desired = DesiredBoard {
            has_i2c_listeners: true,
            max_interval_ms: Some(150),
            max_i2c_delay_us: Some(16_000),
            ..Default::default()
        };
        let plan = plan_board(&HashMap::new(), &HashMap::new(), &desired);
        assert_eq!(plan.sampling_interval_ms, Some(150));
        assert_eq!(plan.i2c_config_delay, Some(16_000));
    }

    #[test]
    fn drains_each_address_exactly_its_prior_query_count_then_arms_desired() {
        // 0x40 had one query, 0x68 had two (accel + gyro). The drain stops 0x40
        // once and 0x68 twice — never more, or a sibling's lone query is cleared.
        let prev_counts: HashMap<u8, usize> = [(0x40, 1), (0x68, 2)].into_iter().collect();
        let reads = vec![
            I2cContinuousRead { address: 0x68, register: 0x43, length: 6 },
            I2cContinuousRead { address: 0x68, register: 0x3B, length: 6 },
        ];
        let desired =
            DesiredBoard { has_i2c_listeners: true, i2c_reads: reads, ..Default::default() };
        let plan = plan_board(&HashMap::new(), &prev_counts, &desired);
        assert_eq!(plan.i2c_stops, vec![0x40, 0x68, 0x68], "drain count == prior queries");
        // Reads are sorted deterministically by (address, register, length).
        assert_eq!(plan.i2c_reads[0].register, 0x3B);
        assert_eq!(plan.i2c_reads[1].register, 0x43);
    }

    #[test]
    fn gather_splits_listeners_from_board_votes() {
        // One walk, two outputs: a hotkey is pure routing state and must not
        // reach the board, while a sampling vote is pure board state.
        let (tables, desired) = gather_wiring([
            (
                "btn",
                vec![ListenerWiring::DigitalPin { pin: 2 }],
                BoardWiring::default(),
            ),
            (
                "pot",
                vec![ListenerWiring::AnalogPin { pin: 14, threshold: 2 }],
                BoardWiring { sampling_interval_ms: Some(40), ..Default::default() },
            ),
            (
                "key",
                vec![ListenerWiring::HotKey { accelerator: "ctrl+a".into() }],
                BoardWiring::default(),
            ),
        ]);

        assert_eq!(desired.report, report(&[(2, false), (14, true)]));
        assert_eq!(desired.max_interval_ms, Some(40));
        assert!(!desired.has_i2c_listeners);
        assert_eq!(tables.pin_listeners.len(), 2);
        assert_eq!(tables.key_listeners["ctrl+a"].len(), 1);
    }

    #[test]
    fn gather_reconciles_votes_to_the_max_and_keeps_every_listener() {
        // Two devices on one address reading different registers each keep their
        // own listener, and the slowest read-delay wins for the shared bus.
        let (tables, desired) = gather_wiring([
            (
                "accel",
                vec![ListenerWiring::I2cAddress { address: 0x68, register: 0x3B }],
                BoardWiring { i2c_read_delay_us: Some(100), ..Default::default() },
            ),
            (
                "gyro",
                vec![ListenerWiring::I2cAddress { address: 0x68, register: 0x43 }],
                BoardWiring { i2c_read_delay_us: Some(300), ..Default::default() },
            ),
        ]);

        assert!(desired.has_i2c_listeners);
        assert_eq!(desired.max_i2c_delay_us, Some(300), "the longest conversion sets the delay");
        assert_eq!(tables.i2c_listeners[&0x68].len(), 2, "both registers stay routed");
    }

    #[test]
    fn gather_of_nothing_wants_nothing() {
        let (tables, desired) = gather_wiring([]);
        assert_eq!(tables, ListenerTables::default());
        assert_eq!(desired, DesiredBoard::default());
    }

    #[test]
    fn an_empty_plan_writes_nothing() {
        // The common case: a node moved, nothing about the board changed. An
        // empty plan must be silent on the wire, not merely harmless.
        assert!(setup_bytes(&BoardPlan::default(), &[]).is_empty());
        assert!(arm_bytes(&BoardPlan::default()).is_empty());
    }

    #[test]
    fn setup_emits_reporting_then_bus_then_rate() {
        // Field order is the apply order. Reporting toggles first, then the I2C
        // bus config, then the shared sampling rate — a rate set before the bus
        // is configured is a rate the bus never honours.
        let plan = BoardPlan {
            analog_enable: vec![14],
            digital_enable: vec![0],
            i2c_config_delay: Some(100),
            sampling_interval_ms: Some(40),
            ..Default::default()
        };
        let bytes = setup_bytes(&plan, &[14]);

        // REPORT_ANALOG(channel 0) | REPORT_DIGITAL(port 0) | then two sysex.
        assert_eq!(&bytes[0..2], &[0xC0, 0x01], "analog reporting first");
        assert_eq!(&bytes[2..4], &[0xD0, 0x01], "digital reporting second");
        let sysex_start = bytes.iter().position(|&b| b == 0xF0).expect("a sysex follows");
        assert_eq!(sysex_start, 4, "reporting toggles precede every sysex");
        // I2C_CONFIG (0x78) before SAMPLING_INTERVAL (0x7A).
        let i2c = bytes.iter().position(|&b| b == 0x78).expect("i2c config emitted");
        let rate = bytes.iter().position(|&b| b == 0x7A).expect("sampling interval emitted");
        assert!(i2c < rate, "bus config precedes the sampling rate");
    }

    #[test]
    fn setup_skips_an_analog_pin_the_board_cannot_stream() {
        // Pin 14 is not flagged analog in the seeded table, so the op fails.
        // One unusable pin must not stop the rest of the phase.
        let plan = BoardPlan {
            analog_enable: vec![14],
            digital_enable: vec![0],
            ..Default::default()
        };
        let bytes = setup_bytes(&plan, &[]);
        assert_eq!(bytes, vec![0xD0, 0x01], "digital reporting still emitted");
    }

    /// `[addr, mode << 3]` — the two bytes that identify an I2C request's target
    /// and intent inside its sysex frame.
    const fn i2c_op(address: u8, mode: u8) -> [u8; 2] {
        [address, mode << 3]
    }
    const STOP_MODE: u8 = 0b11;

    #[test]
    fn arm_drains_before_it_starts() {
        // A stop after a start would tear down the read just armed.
        let plan = BoardPlan {
            i2c_stops: vec![0x68],
            i2c_reads: vec![I2cContinuousRead { address: 0x68, register: 0x3B, length: 6 }],
            ..Default::default()
        };
        let bytes = arm_bytes(&plan);
        let stop = bytes
            .windows(2)
            .position(|w| w == i2c_op(0x68, STOP_MODE))
            .expect("stop emitted");
        let start = bytes
            .windows(2)
            .position(|w| w == i2c_op(0x68, I2C_MODE_READ_CONTINUOUS))
            .expect("continuous read armed");
        assert!(stop < start, "every drain precedes every arm");
    }

    #[test]
    fn the_two_phases_stay_disjoint() {
        // `update_flow` runs per-node initialize between them, so an op that
        // leaked from one phase into the other would land on the wrong side of
        // every device's power-on writes.
        let plan = BoardPlan {
            analog_enable: vec![14],
            i2c_config_delay: Some(0),
            i2c_stops: vec![0x68],
            i2c_reads: vec![I2cContinuousRead { address: 0x68, register: 0x3B, length: 6 }],
            ..Default::default()
        };
        let setup = setup_bytes(&plan, &[14]);
        let arm = arm_bytes(&plan);
        assert!(!setup.is_empty() && !arm.is_empty());
        assert!(
            !setup.windows(2).any(|w| w == i2c_op(0x68, I2C_MODE_READ_CONTINUOUS)),
            "no arm in the setup phase"
        );
        assert!(!arm.contains(&0xC0), "no reporting toggle in the arm phase");
    }
}
