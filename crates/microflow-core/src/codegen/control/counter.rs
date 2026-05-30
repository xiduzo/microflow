//! Counter emitter — mirrors `runtime/control/counter.rs`.
//!
//! The live Counter starts at `0.0` and increments by one each time its
//! `increment` port receives a signal. In the generated single-driver value
//! model a Counter has one wired input that pulses it; the Sketch increments the
//! running count on the *rising edge* of that driver (a transition from falsey
//! to truthy), matching one signal == one increment. The count is a module-level
//! `double` so it persists across `loop()` iterations exactly as the runtime's
//! `ComponentBase` value persists across signals — the on-device count never
//! resets between iterations.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::flow::FlowNode;

/// The C++ `double` variable holding this Counter Node's running count. Exposed
/// as the Node's readable value for downstream Nodes.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("counter_{}_count", node.id_token())
}

/// Emit C++ for a Counter Node. `driver` is the wired pulse input, or `None`
/// when nothing is connected (the runtime never increments without a signal).
///
/// The count and a `_prev` edge-tracking flag are module-level so they persist
/// across loop iterations; the increment only fires on a rising edge so a driver
/// that stays truthy counts once, mirroring discrete signals.
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let token = node.id_token();
    let var = value_var(node);
    let prev = format!("counter_{token}_prev");

    let mut e = NodeEmission {
        declarations: vec![format!("double {var} = 0.0;")],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        // Track the previous truthiness so a sustained-high driver counts once.
        e.declarations.push(format!("bool {prev} = false;"));
        e.loop_body.push(format!("bool counter_{token}_now = (bool)({expr});"));
        e.loop_body
            .push(format!("if (counter_{token}_now && !{prev}) {{ {var} += 1.0; }}"));
        e.loop_body.push(format!("{prev} = counter_{token}_now;"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn counter(id: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Counter".to_string()),
            data: json!({}),
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn count_starts_at_zero_and_persists() {
        let e = emit(&counter("ct-1"), Some("v"));
        // Module-level declaration => persists across loop iterations.
        assert!(e.declarations.iter().any(|d| d.contains("double counter_ct_1_count = 0.0")));
    }

    #[test]
    fn increments_on_rising_edge_only() {
        let e = emit(&counter("ct-1"), Some("v"));
        assert!(e.loop_body.iter().any(|l| l.contains("+= 1.0")), "must increment");
        assert!(
            e.loop_body.iter().any(|l| l.contains("&& !counter_ct_1_prev")),
            "increment must be guarded by a rising edge"
        );
    }

    #[test]
    fn no_driver_keeps_count_static() {
        let e = emit(&counter("ct-1"), None);
        assert!(e.loop_body.is_empty(), "no input => no increment");
        assert!(e.declarations.iter().any(|d| d.contains("= 0.0")));
    }

    #[test]
    fn emits_deterministically() {
        let n = counter("ct-1");
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }
}
