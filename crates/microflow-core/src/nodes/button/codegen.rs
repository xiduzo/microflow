//! Button emitter — mirrors `nodes/button/runtime.rs`.
//!
//! The live Button sets `pinMode(pin, PULLUP)` when `isPullup` is set, else
//! `pinMode(pin, INPUT)`, and reports digital reads. The generated sketch emits
//! the matching pin mode and a `digitalRead` in `loop()` stored into a `bool`
//! state variable that downstream Nodes (e.g. a wired Led) read. With
//! `INPUT_PULLUP` the raw read is active-low; the runtime treats a press as a
//! logical true, so the emitted state inverts the pull-up read to match.
//! Contact bounce settles over the runtime's quiet window
//! ([`debounced_read`]).
//!
//! A press held for `holdtime` ms says so once, on `hold`, as the runtime's
//! `_hold` wakeup does: the sketch keeps when the press began and raises the
//! hold flag on the one tick that much time has passed while still pressed.

use super::config::ButtonConfig;
use crate::codegen::emit::{debounced_read, NodeEmission, NodeToken};
use crate::codegen::wire::{CppExpr, SourceExpr};
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;

/// The C++ `bool` variable name holding this Button's current pressed state.
/// Downstream emitters reference it as their driver expression.
#[must_use]
pub(crate) fn state_var(node: &FlowNode) -> String {
    format!("button_{}_state", node.id_token())
}

/// True on the ticks the Button takes a new level: the ticks the live Button
/// emits `event`, and `true` or `false`.
#[must_use]
pub(crate) fn changed_var(node: &FlowNode) -> String {
    format!("button_{}_changed", node.id_token())
}

/// True on the one tick a press has lasted `holdtime`.
fn hold_var(node: &FlowNode) -> String {
    format!("button_{}_hold", node.id_token())
}

/// What the Button emits on `hold`: its state (pressed), on the tick the
/// press has been held for `holdtime`.
#[must_use]
pub(crate) fn hold_output(node: &FlowNode) -> SourceExpr {
    SourceExpr::event(CppExpr::boolean(state_var(node)), hold_var(node))
}

/// The pin this Button is emitted on — the same resolution `emit` uses,
/// exposed so validation can never drift from emission.
pub(crate) fn pin(node: &FlowNode) -> Result<u8, UnreadableConfig> {
    Ok(resolve::<ButtonConfig>(&node.data)?.pin)
}

/// Emit C++ for a Button Node.
pub(crate) fn emit(node: &FlowNode) -> Result<NodeEmission, UnreadableConfig> {
    let config = resolve::<ButtonConfig>(&node.data)?;
    let pin = config.pin;
    let pin_var = format!("button_{}_pin", node.id_token());
    let state = state_var(node);
    let mode = if config.is_pullup { "INPUT_PULLUP" } else { "INPUT" };
    // With INPUT_PULLUP a pressed button reads LOW — the rule the runtime
    // applies too (`ButtonConfig::pressed_when_high`).
    let level = if config.pressed_when_high() { "HIGH" } else { "LOW" };
    let read_expr = format!("(digitalRead({pin_var}) == {level})");
    let token = node.id_token();
    let (hold, said, pressed_at) =
        (hold_var(node), format!("button_{token}_hold_said"), format!("button_{token}_pressed_at"));
    let changed = changed_var(node);
    let holdtime = config.holdtime;

    let (debounce, mut loop_body) = debounced_read(
        &format!("button_{token}"),
        &read_expr,
        &state,
        &changed,
        &[format!("if ({state}) {{ {pressed_at} = millis(); {said} = false; }}")],
    );
    loop_body.push(format!("{hold} = {state} && !{said} && millis() - {pressed_at} >= {holdtime}UL;"));
    loop_body.push(format!("if ({hold}) {{ {said} = true; }}"));

    let mut declarations = vec![
        format!("const uint8_t {pin_var} = {pin};"),
        format!("bool {state} = false;"),
        format!("bool {changed} = false;"),
        format!("bool {hold} = false;"),
        format!("bool {said} = false;"),
        format!("unsigned long {pressed_at} = 0;"),
    ];
    declarations.extend(debounce);
    Ok(NodeEmission {
        declarations,
        setup: vec![format!("pinMode({pin_var}, {mode});")],
        loop_body,
        ..NodeEmission::default()
    })
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
        let e = emit(&button("btn-1", json!({ "pin": 6 }))).unwrap();
        assert!(e.setup.iter().any(|s| s.contains("pinMode") && s.contains("INPUT") && !s.contains("PULLUP")));
        assert!(e.loop_body.iter().any(|l| l.contains("digitalRead")));
    }

    #[test]
    fn button_pullup_mode_inverts_read() {
        let e = emit(&button("btn-1", json!({ "pin": 6, "isPullup": true }))).unwrap();
        assert!(e.setup.iter().any(|s| s.contains("INPUT_PULLUP")));
        assert!(e.loop_body.iter().any(|l| l.contains("LOW")));
    }

    #[test]
    fn button_uses_default_pin() {
        let e = emit(&button("btn-1", json!({}))).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("= 6;")));
    }

    #[test]
    fn button_emits_deterministically() {
        let n = button("btn-1", json!({ "pin": 6 }));
        assert_eq!(emit(&n).unwrap(), emit(&n).unwrap());
    }
}
