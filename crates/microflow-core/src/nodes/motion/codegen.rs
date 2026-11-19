//! Motion emitter — mirrors `nodes/motion/runtime.rs`.
//!
//! The live Motion (PIR) sensor sets `pinMode(pin, INPUT)` and reports a digital
//! HIGH when motion is detected. The generated sketch emits the INPUT pin setup
//! and a `digitalRead` each loop stored into a `bool` state variable that
//! downstream Nodes read — a HIGH read means motion, matching the runtime which
//! emits `true` on a detected pin-high.

use super::config::MotionConfig;
use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;

/// The pin this Motion sensor is emitted on — the same resolution `emit` uses,
/// exposed so validation can never drift from emission.
pub(crate) fn pin(node: &FlowNode) -> Result<u8, UnreadableConfig> {
    Ok(resolve::<MotionConfig>(&node.data)?.pin)
}

/// The C++ `bool` variable name holding this Motion sensor's detected state.
#[must_use]
pub(crate) fn state_var(node: &FlowNode) -> String {
    format!("motion_{}_state", node.id_token())
}

/// True on the ticks the sensor's state changes: the ticks the live Motion
/// emits `event`, and `true` or `false`.
#[must_use]
pub(crate) fn changed_var(node: &FlowNode) -> String {
    format!("motion_{}_changed", node.id_token())
}

/// Emit C++ for a Motion Node.
pub(crate) fn emit(node: &FlowNode) -> Result<NodeEmission, UnreadableConfig> {
    let config = resolve::<MotionConfig>(&node.data)?;
    let pin = config.pin;
    let pin_var = format!("motion_{}_pin", node.id_token());
    let state = state_var(node);
    let changed = changed_var(node);

    Ok(NodeEmission {
        declarations: vec![
            format!("const uint8_t {pin_var} = {pin};"),
            format!("bool {state} = false;"),
            format!("bool {changed} = false;"),
        ],
        setup: vec![format!("pinMode({pin_var}, INPUT);")],
        loop_body: vec![
            format!("{changed} = ((digitalRead({pin_var}) == HIGH) != {state});"),
            format!("if ({changed}) {{ {state} = !{state}; }}"),
        ],
        ..NodeEmission::default()
    })
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
        let e = emit(&motion("m-1", json!({ "pin": 8 }))).unwrap();
        assert!(e.setup.iter().any(|s| s.contains("pinMode") && s.contains("INPUT")));
        assert!(e.loop_body.iter().any(|l| l.contains("digitalRead") && l.contains("HIGH")));
    }

    #[test]
    fn motion_uses_default_pin() {
        let e = emit(&motion("m-1", json!({}))).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("= 8;")));
    }

    #[test]
    fn motion_emits_deterministically() {
        let n = motion("m-1", json!({ "pin": 8 }));
        assert_eq!(emit(&n).unwrap(), emit(&n).unwrap());
    }
}
