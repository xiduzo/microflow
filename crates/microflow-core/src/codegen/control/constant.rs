//! Constant emitter — mirrors `runtime/generator/constant.rs`.
//!
//! The live Constant Node holds a single fixed `value` (default `1337.0`) and
//! never changes it. Per the Task's Technical Approach, Constant emits a single
//! compile-time `double` initialised to that value rather than any per-loop
//! work — there is no timing or state to update. Downstream Nodes read the
//! output variable directly.

use crate::codegen::emit::{cpp_double, f64_or_default, NodeEmission, NodeToken};
use crate::flow::FlowNode;

/// The C++ `double` variable holding this Constant Node's fixed value.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("constant_{}_value", node.id_token())
}

/// Emit C++ for a Constant Node. The value is fixed at declaration time, so the
/// emitter contributes only a declaration — no `setup()` or `loop()` work. The
/// `driver` is unused: a Constant ignores its inputs, exactly as the runtime's
/// `dispatch` rejects every method.
#[must_use]
pub fn emit(node: &FlowNode) -> NodeEmission {
    let var = value_var(node);
    let value = cpp_double(f64_or_default(node, "value", 1337.0));

    NodeEmission {
        declarations: vec![format!("double {var} = {value};")],
        ..NodeEmission::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn constant(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Constant".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn emits_configured_value() {
        let e = emit(&constant("c-1", json!({ "value": 42.0 })));
        assert!(e.declarations.iter().any(|d| d.contains("constant_c_1_value = 42.0")));
    }

    #[test]
    fn defaults_to_live_runtime_value() {
        let e = emit(&constant("c-1", json!({})));
        assert!(e.declarations.iter().any(|d| d.contains("= 1337.0")));
    }

    #[test]
    fn does_no_per_loop_work() {
        let e = emit(&constant("c-1", json!({ "value": 1.0 })));
        assert!(e.loop_body.is_empty(), "constant must not emit per-loop work");
        assert!(e.setup.is_empty());
    }

    #[test]
    fn emits_deterministically() {
        let n = constant("c-1", json!({ "value": 7.5 }));
        assert_eq!(emit(&n), emit(&n));
    }
}
