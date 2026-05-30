//! Motion emitter — mirrors `runtime/input/motion.rs`.
//!
//! The live Motion (PIR) sensor sets `pinMode(pin, INPUT)` and reports a digital
//! HIGH when motion is detected. The generated sketch emits the INPUT pin setup
//! and a `digitalRead` each loop stored into a `bool` state variable that
//! downstream Nodes read — a HIGH read means motion, matching the runtime which
//! emits `true` on a detected pin-high.

use crate::codegen::emit::{pin_or_default, NodeEmission, NodeToken};
use crate::flow::FlowNode;

/// Default pin matches `runtime/input/motion.rs::default_pin` (8).
const DEFAULT_PIN: u8 = 8;

/// The C++ `bool` variable name holding this Motion sensor's detected state.
#[must_use]
pub fn state_var(node: &FlowNode) -> String {
    format!("motion_{}_state", node.id_token())
}

/// Emit C++ for a Motion Node.
#[must_use]
pub fn emit(node: &FlowNode) -> NodeEmission {
    let pin = pin_or_default(node, DEFAULT_PIN);
    let pin_var = format!("motion_{}_pin", node.id_token());
    let state = state_var(node);

    NodeEmission {
        declarations: vec![
            format!("const uint8_t {pin_var} = {pin};"),
            format!("bool {state} = false;"),
        ],
        setup: vec![format!("pinMode({pin_var}, INPUT);")],
        loop_body: vec![format!("{state} = (digitalRead({pin_var}) == HIGH);")],
        ..NodeEmission::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn motion(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Motion".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn motion_input_mode_and_reads_digital() {
        let e = emit(&motion("m-1", json!({ "pin": 8 })));
        assert!(e.setup.iter().any(|s| s.contains("pinMode") && s.contains("INPUT")));
        assert!(e.loop_body.iter().any(|l| l.contains("digitalRead") && l.contains("HIGH")));
    }

    #[test]
    fn motion_uses_default_pin() {
        let e = emit(&motion("m-1", json!({})));
        assert!(e.declarations.iter().any(|d| d.contains("= 8;")));
    }

    #[test]
    fn motion_emits_deterministically() {
        let n = motion("m-1", json!({ "pin": 8 }));
        assert_eq!(emit(&n), emit(&n));
    }
}
