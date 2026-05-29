//! Gate emitter — mirrors `runtime/transformation/gate.rs`.
//!
//! The live Gate Node counts the truthy inputs and applies a boolean gate
//! (`and`, `nand`, `or`, `xor`, `nor`, `xnor`) over `true_count` vs `total`.
//!
//! The generated value model feeds a single boolean driver into the Node
//! (`total == 1`), so the gates collapse to: `and`/`or`/`xor` pass the input
//! through (`true_count == total`, `> 0`, and `== 1` all equal the single
//! input), while `nand`/`nor`/`xnor` invert it. We emit the matching
//! single-input pass-through / inverting logic into a `bool` variable that
//! downstream Nodes read, reproducing the live gate for the wired signal.

use crate::codegen::emit::{str_or_default, NodeEmission, NodeToken};
use crate::runtime::types::FlowNode;

/// The C++ `bool` variable holding this Gate Node's latest outcome.
#[must_use]
pub fn state_var(node: &FlowNode) -> String {
    format!("gate_{}_result", node.id_token())
}

/// Build the single-input C++ boolean expression for the configured gate over
/// the driver expression `v`.
fn gate_expr(gate: &str, v: &str) -> String {
    match gate {
        // Inverting gates for a single input.
        "nand" | "nor" | "xnor" => format!("(!((bool)({v})))"),
        // Pass-through gates for a single input (and / or / xor).
        _ => format!("((bool)({v}))"),
    }
}

/// Emit C++ for a Gate Node. `driver` is the wired boolean input, or `None`
/// when nothing is connected (the runtime leaves the result at `false` because
/// `check` is skipped for an empty input set).
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let var = state_var(node);
    let gate = str_or_default(node, "gate", "and");

    let mut e = NodeEmission {
        declarations: vec![format!("bool {var} = false;")],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        let computed = gate_expr(&gate, expr);
        e.loop_body.push(format!("{var} = {computed};"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::Position;
    use serde_json::json;

    fn gate(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Gate".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn and_or_xor_pass_through() {
        for g in ["and", "or", "xor"] {
            let e = emit(&gate("g-1", json!({ "gate": g })), Some("x"));
            assert!(
                e.loop_body.iter().any(|l| l.contains("(bool)(x)") && !l.contains("!(")),
                "gate {g} should pass through"
            );
        }
    }

    #[test]
    fn nand_nor_xnor_invert() {
        for g in ["nand", "nor", "xnor"] {
            let e = emit(&gate("g-1", json!({ "gate": g })), Some("x"));
            assert!(
                e.loop_body.iter().any(|l| l.contains("!((bool)(x))")),
                "gate {g} should invert"
            );
        }
    }

    #[test]
    fn no_driver_leaves_false() {
        let e = emit(&gate("g-1", json!({ "gate": "and" })), None);
        assert!(e.loop_body.is_empty());
        assert!(e.declarations.iter().any(|d| d.contains("= false;")));
    }

    #[test]
    fn emits_deterministically() {
        let n = gate("g-1", json!({ "gate": "nand" }));
        assert_eq!(emit(&n, Some("x")), emit(&n, Some("x")));
    }
}
