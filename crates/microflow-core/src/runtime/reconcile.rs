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

use crate::runtime::wiring::I2cContinuousRead;
use std::collections::{HashMap, HashSet};

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

    fn report(pins: &[(u8, bool)]) -> HashMap<u8, bool> {
        pins.iter().copied().collect()
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
}
