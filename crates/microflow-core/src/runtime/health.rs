//! Node health — the runtime's own ledger of what is wrong with each node.
//!
//! A node can fall out of a running flow in four ways the node itself never
//! sees: its config does not deserialize (or its type is unknown), its
//! `initialize` / `on_start` fails, one of its inputs is rejected by
//! `dispatch`, or it is part of a loop that blows the turn budget. Each used to
//! be a `log::warn!` the UI never showed. This module is the seam that turns
//! them into [`NodeDiagnostic`]s on the existing per-node badge channel
//! ([`Effects::node_diagnostics`](super::Effects)) — attributed to the node,
//! raised on a transition only, and cleared when the cause goes away.
//!
//! The ledger keeps every fault it knows about per node and projects the most
//! severe one: build > start > runaway > pin (errors) > overload > rejected
//! input > pin (warnings) — a pin the board cannot use (`runtime::pin_check`)
//! is judged once per build, so it ranks under the faults that come and go. Everything it emits is tagged [`DiagnosticOrigin::Runtime`], so
//! the UI keeps it apart from what a node reports about itself (I2C NACK, Music
//! "no songs", [`DiagnosticOrigin::Node`]): neither origin can clear or
//! downgrade the other's diagnostic.

use crate::runtime::{DiagnosticLevel, DiagnosticOrigin, NodeDiagnostic};
use std::collections::HashMap;

/// What the runtime knows is wrong with one node.
#[derive(Default)]
struct NodeFaults {
    /// The node could not be built — it is not running at all.
    build: Option<String>,
    /// The node was built but its `initialize` / `on_start` failed.
    start: Option<String>,
    /// The node is paused because it sits in a loop that blew the turn budget.
    runaway: Option<String>,
    /// A turn ran out of budget at this node without a loop (fan-out). Nothing
    /// is paused; cleared by the next flow update.
    overload: Option<String>,
    /// Inputs (`dispatch` methods) currently being rejected, in failure order.
    rejected: Vec<(String, String)>,
    /// The node sits on a pin the connected board cannot use the way it needs
    /// (`runtime::pin_check`): an error when it cannot work, a warning when it
    /// works degraded. Judged once per build.
    pins: Option<(DiagnosticLevel, String)>,
    /// The diagnostic last sent for this node, so only transitions are sent.
    shown: Option<(DiagnosticLevel, String)>,
}

impl NodeFaults {
    fn project(&self) -> Option<(DiagnosticLevel, String)> {
        if let Some(m) = self.build.as_ref().or(self.start.as_ref()).or(self.runaway.as_ref()) {
            return Some((DiagnosticLevel::Error, m.clone()));
        }
        if let Some((DiagnosticLevel::Error, m)) = &self.pins {
            return Some((DiagnosticLevel::Error, m.clone()));
        }
        self.overload
            .as_ref()
            .or(self.rejected.last().map(|(_, m)| m))
            .map(|m| (DiagnosticLevel::Warning, m.clone()))
            .or_else(|| self.pins.clone())
    }

    fn is_healthy(&self) -> bool {
        self.build.is_none()
            && self.start.is_none()
            && self.runaway.is_none()
            && self.overload.is_none()
            && self.rejected.is_empty()
            && self.pins.is_none()
    }
}

/// The per-node fault ledger. Mutators only record; [`flush`](Self::flush) runs
/// once at the end of a turn and emits one [`NodeDiagnostic`] per node whose
/// projected badge changed during it — so a rebuild that fails the same way
/// again sends nothing, and a raise-then-clear inside one turn sends nothing.
#[derive(Default)]
pub(crate) struct NodeHealth {
    nodes: HashMap<String, NodeFaults>,
    /// Nodes touched this turn, in first-touch order.
    dirty: Vec<String>,
}

impl NodeHealth {
    /// The node was (re)built: forget every fault from its previous build. The
    /// caller then records the new build's outcome.
    pub(crate) fn rebuilt(&mut self, id: &str) {
        self.touch(id, |f| {
            f.build = None;
            f.start = None;
            f.runaway = None;
            f.overload = None;
            f.rejected.clear();
            f.pins = None;
        });
    }

    /// The freshly built node's pin fault on this board, if any.
    pub(crate) fn pin_fault(&mut self, id: &str, fault: Option<(DiagnosticLevel, String)>) {
        self.touch(id, |f| f.pins = fault);
    }

    /// Warn (`Some`) or clear (`None`) a node where a loop-free turn ran out of
    /// budget.
    pub(crate) fn overloaded(&mut self, id: &str, message: Option<String>) {
        self.touch(id, |f| f.overload = message);
    }

    /// Clear every overload warning — a flow update re-judges the flow.
    pub(crate) fn clear_overloads(&mut self) {
        let flagged: Vec<String> = self
            .nodes
            .iter()
            .filter(|(_, f)| f.overload.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        for id in flagged {
            self.overloaded(&id, None);
        }
    }

    /// The node left the flow: clear any badge the runtime put on it, so an undo
    /// that restores the same id does not resurrect a stale fault.
    pub(crate) fn removed(&mut self, id: &str) {
        self.rebuilt(id);
    }

    /// Forget (and clear the badge of) every faulted node `keep` rejects — the
    /// nodes that left the flow, including ones that never built.
    pub(crate) fn retain(&mut self, keep: impl Fn(&str) -> bool) {
        let gone: Vec<String> = self.nodes.keys().filter(|id| !keep(id)).cloned().collect();
        for id in gone {
            self.removed(&id);
        }
    }

    pub(crate) fn build_failed(&mut self, id: &str, message: String) {
        self.touch(id, |f| f.build = Some(message));
    }

    pub(crate) fn start_failed(&mut self, id: &str, message: String) {
        self.touch(id, |f| f.start = Some(message));
    }

    /// Pause (`Some`) or release (`None`) a node for the turn budget.
    pub(crate) fn runaway(&mut self, id: &str, message: Option<String>) {
        self.touch(id, |f| f.runaway = message);
    }

    /// `method` rejected its input. Re-raising the same failure is a no-op.
    pub(crate) fn input_rejected(&mut self, id: &str, method: &str, message: String) {
        self.touch(id, |f| {
            if let Some(slot) = f.rejected.iter_mut().find(|(m, _)| m == method) {
                slot.1 = message;
            } else {
                f.rejected.push((method.to_string(), message));
            }
        });
    }

    /// `method` accepted an input. On the hot dispatch path: one emptiness check
    /// when no node is faulted, one lookup otherwise.
    pub(crate) fn input_accepted(&mut self, id: &str, method: &str) {
        if self.nodes.is_empty() {
            return;
        }
        let rejected = self
            .nodes
            .get(id)
            .is_some_and(|f| f.rejected.iter().any(|(m, _)| m == method));
        if rejected {
            self.touch(id, |f| f.rejected.retain(|(m, _)| m != method));
        }
    }

    /// Forget rejected inputs `keep` rejects — after a flow update, the inputs
    /// no edge feeds any more (deleting a bad edge is the fix, and that input
    /// will never succeed again to clear itself).
    pub(crate) fn retain_inputs(&mut self, keep: impl Fn(&str, &str) -> bool) {
        let stale: Vec<String> = self
            .nodes
            .iter()
            .filter(|(id, f)| f.rejected.iter().any(|(m, _)| !keep(id, m)))
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            self.touch(&id, |f| f.rejected.retain(|(m, _)| keep(&id, m)));
        }
    }

    /// Emit the turn's badge transitions into `out` and forget healthy nodes.
    pub(crate) fn flush(&mut self, out: &mut Vec<NodeDiagnostic>) {
        for id in self.dirty.drain(..) {
            let Some(faults) = self.nodes.get_mut(&id) else { continue };
            let next = faults.project();
            if next != faults.shown {
                out.push(NodeDiagnostic {
                    node: id.clone(),
                    level: next.as_ref().map_or(DiagnosticLevel::Error, |(level, _)| *level),
                    message: next.as_ref().map(|(_, m)| m.clone()),
                    origin: DiagnosticOrigin::Runtime,
                });
                faults.shown = next;
            }
            if faults.is_healthy() && faults.shown.is_none() {
                self.nodes.remove(&id);
            }
        }
    }

    fn touch(&mut self, id: &str, change: impl FnOnce(&mut NodeFaults)) {
        if let Some(faults) = self.nodes.get_mut(id) {
            change(faults);
        } else {
            let mut faults = NodeFaults::default();
            change(&mut faults);
            if faults.is_healthy() {
                // Nothing raised and nothing shown: no entry, no transition.
                return;
            }
            self.nodes.insert(id.to_string(), faults);
        }
        if !self.dirty.iter().any(|d| d == id) {
            self.dirty.push(id.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flushed(health: &mut NodeHealth) -> Vec<(Option<String>, DiagnosticLevel)> {
        let mut out = Vec::new();
        health.flush(&mut out);
        out.into_iter().map(|d| (d.message, d.level)).collect()
    }

    #[test]
    fn a_healthy_node_produces_nothing() {
        let mut health = NodeHealth::default();
        health.rebuilt("n");
        health.input_accepted("n", "value");
        health.removed("n");
        assert!(flushed(&mut health).is_empty(), "the ledger must never clear what it did not raise");
    }

    #[test]
    fn a_rejected_input_raises_once_and_clears_on_success() {
        let mut health = NodeHealth::default();
        health.input_rejected("n", "value", "bad".into());
        assert_eq!(flushed(&mut health), vec![(Some("bad".into()), DiagnosticLevel::Warning)]);
        health.input_rejected("n", "value", "bad".into());
        assert!(flushed(&mut health).is_empty(), "a repeat failure must not spam");

        health.input_accepted("n", "other");
        assert!(flushed(&mut health).is_empty(), "another input succeeding does not clear this one");
        health.input_accepted("n", "value");
        assert_eq!(flushed(&mut health), vec![(None, DiagnosticLevel::Error)]);
        assert!(health.nodes.is_empty(), "a recovered node leaves the ledger");
    }

    #[test]
    fn the_most_severe_fault_wins_the_badge() {
        let mut health = NodeHealth::default();
        health.input_rejected("n", "value", "input".into());
        health.start_failed("n", "start".into());
        assert_eq!(flushed(&mut health), vec![(Some("start".into()), DiagnosticLevel::Error)]);

        health.rebuilt("n");
        assert_eq!(flushed(&mut health), vec![(None, DiagnosticLevel::Error)], "a rebuild clears every fault");
    }

    #[test]
    fn an_overload_warns_and_any_flow_update_clears_it() {
        let mut health = NodeHealth::default();
        health.overloaded("n", Some("fans out".into()));
        assert_eq!(flushed(&mut health), vec![(Some("fans out".into()), DiagnosticLevel::Warning)]);
        health.clear_overloads();
        assert_eq!(flushed(&mut health), vec![(None, DiagnosticLevel::Error)]);
    }

    #[test]
    fn everything_the_ledger_sends_is_tagged_runtime() {
        let mut health = NodeHealth::default();
        health.build_failed("n", "broken".into());
        let mut out = Vec::new();
        health.flush(&mut out);
        assert!(out.iter().all(|d| d.origin == DiagnosticOrigin::Runtime));
    }

    #[test]
    fn a_pin_warning_sits_under_transient_faults_and_clears_on_rebuild() {
        let mut health = NodeHealth::default();
        health.pin_fault("n", Some((DiagnosticLevel::Warning, "no PWM".into())));
        assert_eq!(flushed(&mut health), vec![(Some("no PWM".into()), DiagnosticLevel::Warning)]);
        health.input_rejected("n", "value", "bad".into());
        assert_eq!(flushed(&mut health), vec![(Some("bad".into()), DiagnosticLevel::Warning)]);
        health.input_accepted("n", "value");
        assert_eq!(flushed(&mut health), vec![(Some("no PWM".into()), DiagnosticLevel::Warning)]);
        health.rebuilt("n");
        assert_eq!(flushed(&mut health), vec![(None, DiagnosticLevel::Error)]);
    }

    #[test]
    fn a_rebuild_that_fails_the_same_way_sends_nothing() {
        let mut health = NodeHealth::default();
        health.build_failed("n", "broken".into());
        assert_eq!(flushed(&mut health).len(), 1);
        health.rebuilt("n");
        health.build_failed("n", "broken".into());
        assert!(flushed(&mut health).is_empty(), "same badge before and after the turn");
    }
}
