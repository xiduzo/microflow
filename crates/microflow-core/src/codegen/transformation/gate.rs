//! Gate emitter — mirrors `runtime/transformation/gate.rs`.
//!
//! The live Gate Node receives a snapshot of *all* inputs wired into its
//! `value` port (it `aggregates_inputs`), counts the truthy ones, and applies
//! the configured boolean gate over `true_count` vs `total`:
//! `and` ⇢ `true_count == total`, `nand` ⇢ `!=  total`, `or` ⇢ `> 0`,
//! `nor` ⇢ `== 0`, `xor` ⇢ `== 1`, `xnor` ⇢ `!= 1`.
//!
//! The generated C++ reproduces exactly that: a truthy count over every wired
//! source expression compared per the gate, stored into a `bool` variable that
//! downstream Nodes read.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::NodeInputs;
use crate::config::gate::{GateConfig, GateType};
use crate::flow::FlowNode;

/// The C++ `bool` variable holding this Gate Node's latest outcome.
#[must_use]
pub fn state_var(node: &FlowNode) -> String {
    format!("gate_{}_result", node.id_token())
}

/// The comparison of the truthy count `tc` against `total` for the configured
/// gate — a direct transcription of the runtime's `passes_gate`.
fn gate_comparison(gate: GateType, tc: &str, total: usize) -> String {
    match gate {
        GateType::And => format!("({tc} == {total})"),
        GateType::Nand => format!("({tc} != {total})"),
        GateType::Or => format!("({tc} > 0)"),
        GateType::Nor => format!("({tc} == 0)"),
        GateType::Xor => format!("({tc} == 1)"),
        GateType::Xnor => format!("({tc} != 1)"),
    }
}

/// Emit C++ for a Gate Node over everything wired into its `value` port. With
/// nothing connected the result stays `false` (the runtime skips `check` for
/// an empty input set).
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let token = node.id_token();
    let var = state_var(node);
    let config: GateConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();

    let mut e = NodeEmission {
        declarations: vec![format!("bool {var} = false;")],
        ..NodeEmission::default()
    };

    let sources = inputs.on("value");
    if sources.is_empty() {
        return e;
    }

    let count_terms: Vec<String> = sources
        .iter()
        .map(|s| format!("({} ? 1 : 0)", s.value.as_bool()))
        .collect();
    let tc = format!("gate_{token}_true_count");
    e.loop_body
        .push(format!("int {tc} = {};", count_terms.join(" + ")));
    e.loop_body.push(format!(
        "{var} = {};",
        gate_comparison(config.gate, &tc, sources.len())
    ));
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
    use crate::flow::Position;
    use serde_json::json;

    fn gate(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Gate".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn wired(exprs: &[CppExpr]) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        for e in exprs {
            inputs.add("value", SourceExpr::level(e.clone()));
        }
        inputs
    }

    #[test]
    fn and_requires_every_input_truthy() {
        let e = emit(
            &gate("g-1", json!({ "gate": "and" })),
            &wired(&[CppExpr::boolean("a"), CppExpr::boolean("b")]),
        );
        let body = e.loop_body.join("\n");
        assert!(body.contains("((a) ? 1 : 0) + ((b) ? 1 : 0)"), "got: {body}");
        assert!(body.contains("== 2"), "and compares count to total: {body}");
    }

    #[test]
    fn or_nor_compare_against_zero() {
        let inputs = wired(&[CppExpr::boolean("a"), CppExpr::boolean("b")]);
        let or = emit(&gate("g-1", json!({ "gate": "or" })), &inputs);
        assert!(or.loop_body.iter().any(|l| l.contains("> 0")));
        let nor = emit(&gate("g-1", json!({ "gate": "nor" })), &inputs);
        assert!(nor.loop_body.iter().any(|l| l.contains("== 0")));
    }

    #[test]
    fn xor_xnor_compare_against_one() {
        let inputs = wired(&[CppExpr::boolean("a"), CppExpr::boolean("b"), CppExpr::boolean("c")]);
        let one_hot = emit(&gate("g-1", json!({ "gate": "xor" })), &inputs);
        assert!(one_hot.loop_body.iter().any(|l| l.contains("== 1")));
        let not_one_hot = emit(&gate("g-1", json!({ "gate": "xnor" })), &inputs);
        assert!(not_one_hot.loop_body.iter().any(|l| l.contains("!= 1")));
    }

    #[test]
    fn nand_inverts_the_all_truthy_test() {
        let e = emit(
            &gate("g-1", json!({ "gate": "nand" })),
            &wired(&[CppExpr::boolean("x")]),
        );
        assert!(e.loop_body.iter().any(|l| l.contains("!= 1")), "single-input nand is a NOT");
    }

    #[test]
    fn numeric_sources_use_truthiness() {
        let e = emit(
            &gate("g-1", json!({ "gate": "and" })),
            &wired(&[CppExpr::number("sensor_v")]),
        );
        assert!(e.loop_body.iter().any(|l| l.contains("(sensor_v) != 0.0")));
    }

    #[test]
    fn no_input_leaves_false() {
        let e = emit(&gate("g-1", json!({ "gate": "and" })), &NodeInputs::default());
        assert!(e.loop_body.is_empty());
        assert!(e.declarations.iter().any(|d| d.contains("= false;")));
    }

    #[test]
    fn emits_deterministically() {
        let n = gate("g-1", json!({ "gate": "nand" }));
        let inputs = wired(&[CppExpr::boolean("x")]);
        assert_eq!(emit(&n, &inputs), emit(&n, &inputs));
    }
}
