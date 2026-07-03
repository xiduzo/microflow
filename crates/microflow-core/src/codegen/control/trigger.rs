//! Trigger emitter — mirrors `runtime/control/trigger.rs`.
//!
//! The live Trigger watches the numeric signal on its `value` port and emits a
//! `bang` (carrying the crossing value) when the value moves past `threshold`
//! in the configured direction (`increasing` / `decreasing`). The generated
//! Sketch reproduces this with a module-level baseline `double` and a boolean
//! output: each loop iteration it compares the current input against the
//! baseline and sets the output when the threshold is crossed in the correct
//! direction — so the output `bool` is true exactly on crossing ticks, the
//! on-device twin of the `bang` emission. The crossing value is captured into
//! a payload variable for downstream consumers of the bang's value. `relative`
//! switches the comparison to a percentage of the baseline, matching the
//! runtime. Trigger does not aggregate: extra sources on `value` are noted and
//! the first drives.

use crate::codegen::emit::{cpp_double, NodeEmission, NodeToken};
use crate::codegen::wire::{extra_sources_note, NodeInputs};
use crate::config::trigger::{TriggerBehaviour, TriggerConfig};
use crate::flow::FlowNode;

/// The C++ `bool` variable holding this Trigger Node's latest bang state —
/// true only on the loop iteration in which the threshold was crossed.
#[must_use]
pub fn state_var(node: &FlowNode) -> String {
    format!("trigger_{}_result", node.id_token())
}

/// The C++ `double` variable holding the value that produced the most recent
/// bang — the on-device twin of the bang emission's payload.
#[must_use]
pub fn value_payload_var(node: &FlowNode) -> String {
    format!("trigger_{}_value", node.id_token())
}

/// Emit C++ for a Trigger Node from its `value` port. With nothing connected
/// the result stays `false` (the runtime never bangs without a signal).
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let token = node.id_token();
    let var = state_var(node);
    let payload = value_payload_var(node);
    let baseline = format!("trigger_{token}_baseline");
    let seeded = format!("trigger_{token}_seeded");
    let config: TriggerConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    let threshold = cpp_double(config.threshold);

    let mut e = NodeEmission {
        declarations: vec![
            format!("bool {var} = false;"),
            format!("double {payload} = 0.0;"),
        ],
        ..NodeEmission::default()
    };

    let sources = inputs.on("value");
    if let Some(note) = extra_sources_note("value", sources) {
        e.declarations.push(note);
    }
    if let Some(source) = sources.first() {
        e.declarations.push(format!("double {baseline} = 0.0;"));
        e.declarations.push(format!("bool {seeded} = false;"));

        e.loop_body
            .push(format!("double trigger_{token}_now = {};", source.value.as_double()));
        // Seed the baseline from the first reading, like the runtime's first sample.
        e.loop_body
            .push(format!("if (!{seeded}) {{ {baseline} = trigger_{token}_now; {seeded} = true; }}"));
        e.loop_body
            .push(format!("double trigger_{token}_diff = trigger_{token}_now - {baseline};"));

        // Direction check mirrors `value_changes_in_correct_direction`.
        let direction = match config.behaviour {
            TriggerBehaviour::Increasing => format!("trigger_{token}_diff > 0.0"),
            TriggerBehaviour::Decreasing => format!("trigger_{token}_diff <= 0.0"),
        };
        // Magnitude check mirrors relative vs absolute threshold.
        let magnitude = if config.relative {
            format!("(fabs(trigger_{token}_diff / {baseline}) * 100.0) >= {threshold}")
        } else {
            format!("fabs(trigger_{token}_diff) >= {threshold}")
        };
        e.loop_body
            .push(format!("{var} = ({direction}) && ({magnitude});"));
        // Capture the crossing value as the bang payload, like emit_with_value.
        e.loop_body
            .push(format!("if ({var}) {{ {payload} = trigger_{token}_now; }}"));
        // Track the latest value as the new baseline for the next comparison.
        e.loop_body.push(format!("{baseline} = trigger_{token}_now;"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
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

    fn value_input(expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::level(expr));
        inputs
    }

    #[test]
    fn bangs_on_absolute_threshold() {
        let e = emit(&trigger("tg-1", json!({ "threshold": 10.0 })), &value_input(CppExpr::number("v")));
        assert!(e.declarations.iter().any(|d| d.contains("bool trigger_tg_1_result")));
        assert!(
            e.loop_body.iter().any(|l| l.contains(">= 10.0")),
            "must compare against the configured threshold"
        );
    }

    #[test]
    fn captures_the_crossing_value_as_payload() {
        let e = emit(&trigger("tg-1", json!({})), &value_input(CppExpr::number("v")));
        assert!(e.declarations.iter().any(|d| d.contains("double trigger_tg_1_value")));
        assert!(
            e.loop_body
                .iter()
                .any(|l| l.contains("trigger_tg_1_value = trigger_tg_1_now")),
            "bang payload captured"
        );
    }

    #[test]
    fn decreasing_is_the_default_direction() {
        let e = emit(&trigger("tg-1", json!({})), &value_input(CppExpr::number("v")));
        assert!(
            e.loop_body.iter().any(|l| l.contains("diff <= 0.0")),
            "default behaviour is decreasing"
        );
    }

    #[test]
    fn increasing_flips_the_direction() {
        let e = emit(
            &trigger("tg-1", json!({ "behaviour": "increasing" })),
            &value_input(CppExpr::number("v")),
        );
        assert!(e.loop_body.iter().any(|l| l.contains("diff > 0.0")));
    }

    #[test]
    fn relative_uses_percentage() {
        let e = emit(
            &trigger("tg-1", json!({ "relative": true, "threshold": 20.0 })),
            &value_input(CppExpr::number("v")),
        );
        assert!(e.loop_body.iter().any(|l| l.contains("* 100.0")), "relative => percent compare");
    }

    #[test]
    fn no_input_leaves_false() {
        let e = emit(&trigger("tg-1", json!({})), &NodeInputs::default());
        assert!(e.loop_body.is_empty());
        assert!(e.declarations.iter().any(|d| d.contains("= false;")));
    }

    #[test]
    fn emits_deterministically() {
        let n = trigger("tg-1", json!({ "threshold": 3.0, "behaviour": "increasing" }));
        let inputs = value_input(CppExpr::number("v"));
        assert_eq!(emit(&n, &inputs), emit(&n, &inputs));
    }
}
