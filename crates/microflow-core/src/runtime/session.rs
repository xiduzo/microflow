//! Board session health — keeping what the runtime believes about the board
//! true for as long as the port stays open.
//!
//! A board can reboot without its port closing: a DTR pulse, the watchdog, a
//! brown-out, an AVR reset over an external USB-serial chip. It comes back in
//! `systemResetCallback`'s defaults — no pin modes, no reporting, no I2C
//! queries, no extension state — and re-announces itself with `REPORT_VERSION`
//! and `REPORT_FIRMWARE`. Nothing closes, so no host reconnects; unless the
//! runtime reacts, the flow goes silent while the UI still says "connected".
//!
//! The re-announce is read from the runtime's own decode, never from the
//! detection codec (ADR-0018 keeps that one out of the steady-state path): the
//! runtime is the one that has to re-apply the flow. It forgets what it
//! believed about the board, rebuilds every hardware node so node state and
//! board state start out together, replays the board setup against an empty
//! board, and re-drives the last output of the nodes that say it is safe to
//! ([`HardwareComponent::restore_output`]). Nodes with no board — timers,
//! counters, cloud nodes — keep running untouched.
//!
//! Restoring can be what resets the board: a relay coil or a motor on the
//! board's own 5 V rail browns it out the moment it is re-driven, the board
//! resets and re-announces, and the runtime would re-drive it forever. So
//! [`RESET_STORM_COUNT`] re-announces inside [`RESET_STORM_WINDOW_MS`] is a
//! **reset storm**: the flow is still re-applied, but the outputs a restore
//! would re-drive are held at the safe state, each with a runtime-origin
//! warning on its node. The storm ends when the board has been quiet for
//! [`RESET_STORM_QUIET_MS`] (the held outputs are then restored) or when the
//! flow is updated (the badges clear; the flow drives its outputs again).
//!
//! [`HardwareComponent::restore_output`]: crate::runtime::HardwareComponent::restore_output

use super::{reconcile, BufferBoardWriter, ComponentValue, FlowRuntime, RuntimeContext, ScheduleRequests};
use crate::firmata::Message;
use std::collections::{BTreeMap, HashMap, VecDeque};

/// Re-announces inside [`RESET_STORM_WINDOW_MS`] that make a reset storm.
pub const RESET_STORM_COUNT: usize = 3;
/// The window [`RESET_STORM_COUNT`] re-announces must fall in.
pub const RESET_STORM_WINDOW_MS: f64 = 30_000.0;
/// How long the board must go without re-announcing for a storm to end.
pub const RESET_STORM_QUIET_MS: f64 = 30_000.0;

/// The badge on an output held at the safe state during a reset storm.
const HELD_MESSAGE: &str =
    "The board keeps resetting, so this output is held off. Check the board's power supply: \
     a relay, motor or LED strip on the board's 5 V pin can brown it out.";

/// Recent re-announces, and the outputs held while the board keeps resetting.
#[derive(Debug, Default)]
pub(super) struct ResetGuard {
    /// Host-clock times of the re-announces inside the window.
    recent: VecDeque<f64>,
    /// Outputs held at the safe state, with the value to restore once the
    /// board is quiet. Empty ⇔ no storm.
    held: BTreeMap<String, ComponentValue>,
}

impl ResetGuard {
    /// Record a re-announce at `now`; whether the board is now in a storm.
    fn note(&mut self, now: f64) -> bool {
        while self.recent.front().is_some_and(|&t| now - t > RESET_STORM_WINDOW_MS) {
            self.recent.pop_front();
        }
        self.recent.push_back(now);
        self.recent.len() >= RESET_STORM_COUNT
    }

    /// The storm is over: the board has not re-announced for the quiet period.
    fn has_calmed(&self, now: f64) -> bool {
        !self.held.is_empty() && self.recent.back().is_some_and(|&t| now - t >= RESET_STORM_QUIET_MS)
    }
}

impl FlowRuntime {
    /// Whether this chunk's decode carries a firmware announcement. On a live
    /// session that is the board saying it rebooted: the handshake's own
    /// `REPORT_FIRMWARE` answer reaches the detection codec before a runtime
    /// exists (ADR-0018 D3), so the runtime only sees one when the board
    /// announces itself again.
    pub(super) fn is_reannounce(parsed: &[Message]) -> bool {
        parsed.contains(&Message::ReportFirmware)
    }

    /// The board rebooted under a live session: re-seed the pin table, rebuild
    /// the hardware nodes, replay the board setup from scratch and restore the
    /// outputs that are safe to restore. Writes into the current turn.
    pub(super) fn board_reannounced(&mut self, out: &mut Vec<u8>, reqs: &mut ScheduleRequests) {
        log::warn!("board re-announced its firmware mid-session (it reset); re-applying the flow");
        let storm = self.reset_guard.note(self.now_ms);
        if storm {
            log::warn!(
                "board reset {} times within {}s; holding its outputs at the safe state — check its power supply",
                self.reset_guard.recent.len(),
                RESET_STORM_WINDOW_MS / 1000.0,
            );
        }

        // 1. What the runtime believed about the board went with the board's
        //    RAM: every pin is back in its default mode at 0. The capability
        //    half of the table (modes, analog) describes the same firmware and
        //    stays.
        for pin in &mut self.client.pins {
            pin.mode = crate::firmata::Pin::default().mode;
            pin.value = 0;
        }
        self.client.i2c_data.clear();
        // The zeroed table is not news from the board: record it as last seen,
        // so only the board's own reports after the re-apply count as changes.
        // (Change detection runs later in this same turn, before the board has
        // answered; a pull-up button would read the zero as a press.)
        for &pin in &self.active_pins {
            self.pin_values.insert(pin, 0);
        }

        // 2. Rebuild every hardware node from its stored data, so no node keeps
        //    state about a board that no longer has it (an LED that thinks its
        //    pin is in PWM mode, a stepper that thinks it is configured).
        let mut hardware: Vec<String> = self
            .components
            .iter_mut()
            .filter_map(|(id, c)| c.as_hardware_mut().map(|_| id.clone()))
            .collect();
        hardware.sort_unstable();
        let mut rebuilt: Vec<(String, ComponentValue)> = Vec::new();
        for id in hardware {
            let (Some(old), Some(data)) = (self.components.get(&id), self.node_data.get(&id)) else {
                continue;
            };
            let instance = data
                .get("instance")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_else(|| old.component_type())
                .to_string();
            let last = old.value();
            match self.registry.create(&id, &instance, data) {
                Ok(fresh) => {
                    self.remove_component(&id);
                    self.add_component(&id, fresh);
                    rebuilt.push((id, last));
                }
                // The same data built before; keep the old instance rather than
                // lose the node, and let `initialize` re-set its pins.
                Err(e) => {
                    tracing::warn!(node = %id, instance, error = %e, "rebuild after re-announce failed");
                    rebuilt.push((id, ComponentValue::default()));
                }
            }
        }

        // 3. Replay the board setup against an empty board: nothing reports and
        //    nothing streams, so every enable and every continuous read is sent
        //    and no I2C stop is (a stop would only clear a query the board no
        //    longer has). Same two phases as `update_flow`, so modes are still
        //    set before reporting is switched on.
        let (_, desired) = reconcile::gather_wiring(
            self.components
                .iter()
                .map(|(id, c)| (id.as_str(), c.listener_wiring(), c.board_wiring())),
        );
        let plan = reconcile::plan_board(&HashMap::new(), &HashMap::new(), &desired);
        plan.encode_setup(&mut BufferBoardWriter::new(&mut self.client, out));
        self.report_set = desired.report;
        for (id, last) in rebuilt {
            self.start_node(&id, out, reqs);
            // A node already held keeps the value from before the storm: its
            // rebuilt instance never had it restored.
            let last = self.reset_guard.held.get(&id).cloned().unwrap_or(last);
            if !self.would_restore(&id, &last) {
                continue;
            }
            if storm {
                self.health.board_resetting(&id, Some(HELD_MESSAGE.to_string()));
                self.reset_guard.held.insert(id, last);
            } else {
                self.restore_output(&id, &last, out, reqs);
            }
        }
        plan.encode_arm(&mut BufferBoardWriter::new(&mut self.client, out));
    }

    /// Once the board has been quiet for [`RESET_STORM_QUIET_MS`], restore the
    /// outputs held during the storm and clear their badges. Checked on every
    /// inbound chunk that is not itself a re-announce.
    pub(super) fn resume_after_reset_storm(&mut self, out: &mut Vec<u8>, reqs: &mut ScheduleRequests) {
        if !self.reset_guard.has_calmed(self.now_ms) {
            return;
        }
        log::info!("board quiet for {}s; restoring the outputs held during the reset storm", RESET_STORM_QUIET_MS / 1000.0);
        self.reset_guard.recent.clear();
        for (id, last) in std::mem::take(&mut self.reset_guard.held) {
            self.health.board_resetting(&id, None);
            if self.would_restore(&id, &last) {
                self.restore_output(&id, &last, out, reqs);
            }
        }
    }

    /// A flow update ends a storm: badges clear, nothing is re-driven (the flow
    /// drives its outputs again), and the count starts over.
    pub(super) fn end_reset_storm(&mut self) {
        self.reset_guard.recent.clear();
        for id in std::mem::take(&mut self.reset_guard.held).into_keys() {
            self.health.board_resetting(&id, None);
        }
    }

    fn would_restore(&mut self, id: &str, last: &ComponentValue) -> bool {
        self.components
            .get_mut(id)
            .and_then(|c| c.as_hardware_mut())
            .is_some_and(|hw| hw.restores_output(last))
    }

    /// Re-drive `id`'s last output where the node says that is safe.
    fn restore_output(&mut self, id: &str, last: &ComponentValue, out: &mut Vec<u8>, reqs: &mut ScheduleRequests) {
        let Some(hw) = self.components.get_mut(id).and_then(|c| c.as_hardware_mut()) else {
            return;
        };
        let mut writer = BufferBoardWriter::new(&mut self.client, out);
        let mut ctx = RuntimeContext::new(&mut writer, self.now_ms, id, reqs);
        if let Err(e) = hw.restore_output(last, &mut ctx) {
            tracing::warn!(node = %id, error = %e, "restoring the last output failed");
        }
    }
}
