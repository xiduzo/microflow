//! Switch emitter — mirrors `nodes/switch/runtime.rs`.
//!
//! The live Switch is a latching on/off toggle (unlike the momentary Button).
//! It sets `pinMode(pin, INPUT)` and reports digital reads, closed on the level
//! `SwitchType::closed_when_high` names (NC: HIGH, NO: LOW) — the truth table
//! the runtime applies too, and settles contact bounce over the same quiet
//! window ([`debounced_read`]). Downstream Nodes read the resulting `bool`
//! state variable.

use super::config::SwitchConfig;
use crate::codegen::emit::{debounced_read, NodeEmission, NodeToken};
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;

/// The pin this Switch is emitted on — the same resolution `emit` uses,
/// exposed so validation can never drift from emission.
pub(crate) fn pin(node: &FlowNode) -> Result<u8, UnreadableConfig> {
    Ok(resolve::<SwitchConfig>(&node.data)?.pin)
}

/// The C++ `bool` variable name holding this Switch's current on/off state.
#[must_use]
pub(crate) fn state_var(node: &FlowNode) -> String {
    format!("switch_{}_state", node.id_token())
}

/// True on the ticks the Switch takes a new level: the ticks the live Switch
/// emits `event`, and `true` or `false`.
#[must_use]
pub(crate) fn changed_var(node: &FlowNode) -> String {
    format!("switch_{}_changed", node.id_token())
}

/// Emit C++ for a Switch Node.
pub(crate) fn emit(node: &FlowNode) -> Result<NodeEmission, UnreadableConfig> {
    let config = resolve::<SwitchConfig>(&node.data)?;
    let pin = config.pin;
    let pin_var = format!("switch_{}_pin", node.id_token());
    let state = state_var(node);
    let changed = changed_var(node);
    // NC: HIGH is closed; NO: LOW is closed — the truth table the runtime
    // applies too.
    let level = if config.switch_type.closed_when_high() { "HIGH" } else { "LOW" };
    let read_expr = format!("(digitalRead({pin_var}) == {level})");
    // Contact bounce settles as the live Switch settles it.
    let (debounce, loop_body) =
        debounced_read(&format!("switch_{}", node.id_token()), &read_expr, &state, &changed, &[]);

    let mut declarations = vec![
        format!("const uint8_t {pin_var} = {pin};"),
        format!("bool {state} = false;"),
        format!("bool {changed} = false;"),
    ];
    declarations.extend(debounce);
    Ok(NodeEmission {
        declarations,
        setup: vec![format!("pinMode({pin_var}, INPUT);")],
        loop_body,
        ..NodeEmission::default()
    })
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
        // No `type`: NC, the editor's default — closed on HIGH.
        let e = emit(&switch("sw-1", json!({ "pin": 2 }))).unwrap();
        assert!(e.setup.iter().any(|s| s.contains("pinMode") && s.contains("INPUT")));
        assert!(e.loop_body.iter().any(|l| l.contains("digitalRead") && l.contains("== HIGH")));
    }

    #[test]
    fn switch_no_inverts_read() {
        let e = emit(&switch("sw-1", json!({ "pin": 2, "type": "NO" }))).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("== LOW")));
    }

    #[test]
    fn switch_uses_default_pin() {
        let e = emit(&switch("sw-1", json!({}))).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("= 2;")));
    }

    #[test]
    fn switch_emits_deterministically() {
        let n = switch("sw-1", json!({ "pin": 2, "type": "NC" }));
        assert_eq!(emit(&n).unwrap(), emit(&n).unwrap());
    }
}
