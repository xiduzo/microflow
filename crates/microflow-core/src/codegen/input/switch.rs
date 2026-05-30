//! Switch emitter — mirrors `runtime/input/switch.rs`.
//!
//! The live Switch is a latching on/off toggle (unlike the momentary Button).
//! It sets `pinMode(pin, INPUT)` and reports digital reads. A Normally-Open (NO)
//! switch reads HIGH when actuated; a Normally-Closed (NC) switch is wired
//! inverted, so the emitted state inverts the raw read to match the runtime's
//! `SwitchType`. Downstream Nodes read the resulting `bool` state variable.

use crate::codegen::emit::{pin_or_default, NodeEmission, NodeToken};
use crate::flow::FlowNode;

/// Default pin matches `runtime/input/switch.rs::default_pin` (2).
const DEFAULT_PIN: u8 = 2;

/// The C++ `bool` variable name holding this Switch's current on/off state.
#[must_use]
pub fn state_var(node: &FlowNode) -> String {
    format!("switch_{}_state", node.id_token())
}

/// True when the Node's `data.type` selects a Normally-Closed switch.
fn is_normally_closed(node: &FlowNode) -> bool {
    node.data
        .get("type")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|t| t.eq_ignore_ascii_case("NC"))
}

/// Emit C++ for a Switch Node.
#[must_use]
pub fn emit(node: &FlowNode) -> NodeEmission {
    let pin = pin_or_default(node, DEFAULT_PIN);
    let pin_var = format!("switch_{}_pin", node.id_token());
    let state = state_var(node);
    let nc = is_normally_closed(node);

    // NO: actuated reads HIGH. NC: the contact is inverted, so actuated reads
    // LOW — mirror the runtime by inverting the comparison.
    let read_expr = if nc {
        format!("(digitalRead({pin_var}) == LOW)")
    } else {
        format!("(digitalRead({pin_var}) == HIGH)")
    };

    NodeEmission {
        declarations: vec![
            format!("const uint8_t {pin_var} = {pin};"),
            format!("bool {state} = false;"),
        ],
        setup: vec![format!("pinMode({pin_var}, INPUT);")],
        loop_body: vec![format!("{state} = {read_expr};")],
        ..NodeEmission::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn switch(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Switch".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn switch_input_mode_and_reads() {
        let e = emit(&switch("sw-1", json!({ "pin": 2 })));
        assert!(e.setup.iter().any(|s| s.contains("pinMode") && s.contains("INPUT")));
        assert!(e.loop_body.iter().any(|l| l.contains("digitalRead") && l.contains("HIGH")));
    }

    #[test]
    fn switch_nc_inverts_read() {
        let e = emit(&switch("sw-1", json!({ "pin": 2, "type": "NC" })));
        assert!(e.loop_body.iter().any(|l| l.contains("LOW")));
    }

    #[test]
    fn switch_uses_default_pin() {
        let e = emit(&switch("sw-1", json!({})));
        assert!(e.declarations.iter().any(|d| d.contains("= 2;")));
    }

    #[test]
    fn switch_emits_deterministically() {
        let n = switch("sw-1", json!({ "pin": 2, "type": "NC" }));
        assert_eq!(emit(&n), emit(&n));
    }
}
