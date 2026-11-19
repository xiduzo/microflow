//! Constant emitter — mirrors `nodes/constant/runtime.rs`.
//!
//! The live Constant Node holds a single fixed `value` (default `1337.0`),
//! never changes it, and emits it once when the flow starts — whatever it is,
//! 0 included. The Sketch declares the value as a compile-time `double` and
//! raises the Constant's emission flag on the first loop tick only, so a
//! pulse-consuming port downstream fires once at the start, as it does live.

use super::config::ConstantConfig;
use crate::codegen::emit::{cpp_double, NodeEmission, NodeToken};
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;

/// The C++ `double` variable holding this Constant Node's fixed value.
#[must_use]
pub(crate) fn value_var(node: &FlowNode) -> String {
    format!("constant_{}_value", node.id_token())
}

/// The C++ `bool` that is true on the first loop tick only: the tick the
/// Constant emits.
#[must_use]
pub(crate) fn fired_var(node: &FlowNode) -> String {
    format!("constant_{}_fired", node.id_token())
}

/// Emit C++ for a Constant Node: its value, and its one emission on the first
/// tick. A Constant ignores its inputs, exactly as the runtime's `dispatch`
/// rejects every method.
pub(crate) fn emit(node: &FlowNode) -> Result<NodeEmission, UnreadableConfig> {
    let var = value_var(node);
    let fired = fired_var(node);
    let started = format!("constant_{}_started", node.id_token());
    let config = resolve::<ConstantConfig>(&node.data)?;
    let value = cpp_double(config.value);

    Ok(NodeEmission {
        declarations: vec![
            format!("double {var} = {value};"),
            format!("bool {fired} = false;"),
            format!("bool {started} = false;"),
        ],
        loop_body: vec![format!("{fired} = !{started};"), format!("{started} = true;")],
        ..NodeEmission::default()
    })
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
        let e = emit(&constant("c-1", json!({ "value": 42.0 }))).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("constant_c_1_value = 42.0")));
    }

    #[test]
    fn defaults_to_live_runtime_value() {
        let e = emit(&constant("c-1", json!({}))).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("= 1337.0")));
    }

    /// The emission flag rises on the first tick and on no other.
    #[test]
    fn fires_on_the_first_tick_only() {
        let e = emit(&constant("c-1", json!({ "value": 0.0 }))).unwrap();
        assert_eq!(
            e.loop_body,
            ["constant_c_1_fired = !constant_c_1_started;", "constant_c_1_started = true;"]
        );
        assert!(e.setup.is_empty(), "{:?}", e.setup);
    }

    #[test]
    fn emits_deterministically() {
        let n = constant("c-1", json!({ "value": 7.5 }));
        assert_eq!(emit(&n).unwrap(), emit(&n).unwrap());
    }
}
