//! Button emitter — mirrors `runtime/input/button.rs`.
//!
//! The live Button sets `pinMode(pin, PULLUP)` when `isPullup` is set, else
//! `pinMode(pin, INPUT)`, and reports digital reads. The generated sketch emits
//! the matching pin mode and a `digitalRead` in `loop()` stored into a `bool`
//! state variable that downstream Nodes (e.g. a wired Led) read. With
//! `INPUT_PULLUP` the raw read is active-low; the runtime treats a press as a
//! logical true, so the emitted state inverts the pull-up read to match.

use crate::codegen::emit::{bool_flag, pin_or_default, NodeEmission, NodeToken};
use crate::flow::FlowNode;

/// Default pin matches `runtime/input/button.rs::default_pin` (6).
const DEFAULT_PIN: u8 = 6;

/// The C++ `bool` variable name holding this Button's current pressed state.
/// Downstream emitters reference it as their driver expression.
#[must_use]
pub fn state_var(node: &FlowNode) -> String {
    format!("button_{}_state", node.id_token())
}

/// Emit C++ for a Button Node.
#[must_use]
pub fn emit(node: &FlowNode) -> NodeEmission {
    let pin = pin_or_default(node, DEFAULT_PIN);
    let pin_var = format!("button_{}_pin", node.id_token());
    let state = state_var(node);
    let pullup = bool_flag(node, "isPullup");

    let mode = if pullup { "INPUT_PULLUP" } else { "INPUT" };
    // With INPUT_PULLUP a pressed button reads LOW, so invert to a logical
    // "pressed = true" to match the runtime's semantics.
    let read_expr = if pullup {
        format!("(digitalRead({pin_var}) == LOW)")
    } else {
        format!("(digitalRead({pin_var}) == HIGH)")
    };

    NodeEmission {
        declarations: vec![
            format!("const uint8_t {pin_var} = {pin};"),
            format!("bool {state} = false;"),
        ],
        setup: vec![format!("pinMode({pin_var}, {mode});")],
        loop_body: vec![format!("{state} = {read_expr};")],
        ..NodeEmission::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn button(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Button".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn button_input_mode_and_reads() {
        let e = emit(&button("btn-1", json!({ "pin": 6 })));
        assert!(e.setup.iter().any(|s| s.contains("pinMode") && s.contains("INPUT") && !s.contains("PULLUP")));
        assert!(e.loop_body.iter().any(|l| l.contains("digitalRead")));
    }

    #[test]
    fn button_pullup_mode_inverts_read() {
        let e = emit(&button("btn-1", json!({ "pin": 6, "isPullup": true })));
        assert!(e.setup.iter().any(|s| s.contains("INPUT_PULLUP")));
        assert!(e.loop_body.iter().any(|l| l.contains("LOW")));
    }

    #[test]
    fn button_uses_default_pin() {
        let e = emit(&button("btn-1", json!({})));
        assert!(e.declarations.iter().any(|d| d.contains("= 6;")));
    }

    #[test]
    fn button_emits_deterministically() {
        let n = button("btn-1", json!({ "pin": 6 }));
        assert_eq!(emit(&n), emit(&n));
    }
}
