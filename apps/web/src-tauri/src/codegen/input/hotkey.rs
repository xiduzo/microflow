//! Hotkey emitter — mirrors `runtime/input/hotkey.rs`.
//!
//! The live Hotkey is a software-only Node: it responds to host-keyboard
//! press/release events routed from the desktop app's `HotkeyManager`. A
//! standalone Arduino sketch has no host keyboard, so there is no on-device
//! source for the key event. To keep the Flow's wiring intact, the emitter
//! declares the Node's `bool` state variable (initialised `false`, matching the
//! runtime's initial value) so downstream Nodes still compile and read a stable
//! signal — and records, as a comment, that the trigger is host-only and never
//! fires on-device.

use crate::codegen::emit::{str_or_default, NodeEmission, NodeToken};
use crate::runtime::types::FlowNode;

/// The C++ `bool` variable name holding this Hotkey's pressed state.
#[must_use]
pub fn state_var(node: &FlowNode) -> String {
    format!("hotkey_{}_state", node.id_token())
}

/// Emit C++ for a Hotkey Node. There is no pin or loop work: the only on-device
/// artefact is the state variable, held at its initial `false` because no host
/// keyboard exists on the board.
#[must_use]
pub fn emit(node: &FlowNode) -> NodeEmission {
    let state = state_var(node);
    let accelerator = str_or_default(node, "accelerator", "x");

    NodeEmission {
        declarations: vec![
            format!(
                "// hotkey \"{accelerator}\" is host-only; no on-device keyboard drives it"
            ),
            format!("bool {state} = false;"),
        ],
        ..NodeEmission::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::Position;
    use serde_json::json;

    fn hotkey(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Hotkey".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn hotkey_declares_state_at_false() {
        let e = emit(&hotkey("hk-1", json!({ "accelerator": "a" })));
        assert!(e.declarations.iter().any(|d| d.contains("hotkey_hk_1_state = false")));
    }

    #[test]
    fn hotkey_notes_host_only_origin() {
        let e = emit(&hotkey("hk-1", json!({ "accelerator": "a" })));
        assert!(e.declarations.iter().any(|d| d.contains("host-only")));
    }

    #[test]
    fn hotkey_does_no_pin_or_loop_work() {
        let e = emit(&hotkey("hk-1", json!({})));
        assert!(e.setup.is_empty(), "hotkey has no pin to configure");
        assert!(e.loop_body.is_empty(), "hotkey has no on-device source to poll");
    }

    #[test]
    fn hotkey_emits_deterministically() {
        let n = hotkey("hk-1", json!({ "accelerator": "x" }));
        assert_eq!(emit(&n), emit(&n));
    }
}
