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
//! [`HardwareComponent::restore_output`]: crate::runtime::HardwareComponent::restore_output

use super::{reconcile, BufferBoardWriter, ComponentValue, FlowRuntime, RuntimeContext, ScheduleRequests};
use crate::firmata::Message;
use std::collections::HashMap;

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
        for (id, last) in &rebuilt {
            self.start_node(id, out, reqs);
            self.restore_output(id, last, out, reqs);
        }
        plan.encode_arm(&mut BufferBoardWriter::new(&mut self.client, out));
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
