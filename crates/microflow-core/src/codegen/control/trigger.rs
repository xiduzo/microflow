//! Trigger emitter — mirrors `runtime/control/trigger.rs`.
//!
//! The live Trigger watches a numeric signal and emits a boolean "bang" when the
//! value moves past `threshold` in the configured direction (`increasing` /
//! `decreasing`) within a recent window. It keeps a baseline from which the
//! difference is measured. The generated Sketch reproduces this with a
//! module-level baseline `double` and a boolean output: each loop iteration it
//! compares the current driver value against the baseline and sets the output
//! when the threshold is crossed in the correct direction. `relative` switches
//! the comparison to a percentage of the baseline, matching the runtime. State
//! persists across iterations so the baseline survives, and the output `bool` is
//! read by downstream Nodes.

use crate::codegen::emit::{bool_flag, cpp_double, f64_or_default, str_or_default, NodeEmission, NodeToken};
use crate::flow::FlowNode;

/// The C++ `bool` variable holding this Trigger Node's latest bang state.
#[must_use]
pub fn state_var(node: &FlowNode) -> String {
    format!("trigger_{}_result", node.id_token())
}

/// Emit C++ for a Trigger Node. `driver` is the wired numeric input, or `None`
/// when nothing is connected (the runtime never bangs without a signal).
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let token = node.id_token();
    let var = state_var(node);
    let baseline = format!("trigger_{token}_baseline");
    let seeded = format!("trigger_{token}_seeded");
    let threshold = cpp_double(f64_or_default(node, "threshold", 5.0));
    let behaviour = str_or_default(node, "behaviour", "decreasing");
    let relative = bool_flag(node, "relative");

    let mut e = NodeEmission {
        declarations: vec![format!("bool {var} = false;")],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        e.declarations.push(format!("double {baseline} = 0.0;"));
        e.declarations.push(format!("bool {seeded} = false;"));

        e.loop_body.push(format!("double trigger_{token}_now = (double)({expr});"));
        // Seed the baseline from the first reading, like the runtime's first sample.
        e.loop_body
            .push(format!("if (!{seeded}) {{ {baseline} = trigger_{token}_now; {seeded} = true; }}"));
        e.loop_body
            .push(format!("double trigger_{token}_diff = trigger_{token}_now - {baseline};"));

        // Direction check mirrors `value_changes_in_correct_direction`.
        let direction = if behaviour == "increasing" {
            format!("trigger_{token}_diff > 0.0")
        } else {
            format!("trigger_{token}_diff <= 0.0")
        };
        // Magnitude check mirrors relative vs absolute threshold.
        let magnitude = if relative {
            format!("(fabs(trigger_{token}_diff / {baseline}) * 100.0) >= {threshold}")
        } else {
            format!("fabs(trigger_{token}_diff) >= {threshold}")
        };
        e.loop_body
            .push(format!("{var} = ({direction}) && ({magnitude});"));
        // Track the latest value as the new baseline for the next comparison.
        e.loop_body.push(format!("{baseline} = trigger_{token}_now;"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn trigger(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Trigger".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn bangs_on_absolute_threshold() {
        let e = emit(&trigger("tg-1", json!({ "threshold": 10.0 })), Some("v"));
        assert!(e.declarations.iter().any(|d| d.contains("bool trigger_tg_1_result")));
        assert!(
            e.loop_body.iter().any(|l| l.contains(">= 10.0")),
            "must compare against the configured threshold"
        );
    }

    #[test]
    fn decreasing_is_the_default_direction() {
        let e = emit(&trigger("tg-1", json!({})), Some("v"));
        assert!(
            e.loop_body.iter().any(|l| l.contains("diff <= 0.0")),
            "default behaviour is decreasing"
        );
    }

    #[test]
    fn increasing_flips_the_direction() {
        let e = emit(&trigger("tg-1", json!({ "behaviour": "increasing" })), Some("v"));
        assert!(e.loop_body.iter().any(|l| l.contains("diff > 0.0")));
    }

    #[test]
    fn relative_uses_percentage() {
        let e = emit(&trigger("tg-1", json!({ "relative": true, "threshold": 20.0 })), Some("v"));
        assert!(e.loop_body.iter().any(|l| l.contains("* 100.0")), "relative => percent compare");
    }

    #[test]
    fn no_driver_leaves_false() {
        let e = emit(&trigger("tg-1", json!({})), None);
        assert!(e.loop_body.is_empty());
        assert!(e.declarations.iter().any(|d| d.contains("= false;")));
    }

    #[test]
    fn emits_deterministically() {
        let n = trigger("tg-1", json!({ "threshold": 3.0, "behaviour": "increasing" }));
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }
}
