//! Relay emitter — mirrors `runtime/output/relay.rs`.
//!
//! The live Relay sets `pinMode(pin, OUTPUT)` and starts closed. Its ports are
//! `true` (open), `false` (close), and `toggle` — there is no level-valued
//! `value` port. For a Normally-Open (NO) relay, "open" writes HIGH and
//! "close" writes LOW; for a Normally-Closed (NC) relay the signal is
//! inverted. The generated sketch emits the OUTPUT setup and binds each wired
//! port as a pulse, tracking the open/closed state so `toggle` flips from the
//! last written state exactly like the runtime's `is_open`.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, NodeInputs};
use crate::config::relay::{RelayConfig, RelayType};
use crate::flow::FlowNode;

/// Emit C++ for a Relay Node. An unwired relay stays initialized-closed.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let config: RelayConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    let pin = config.pin;
    let token = node.id_token();
    let var = format!("relay_{token}_pin");
    let open_state = format!("relay_{token}_open");
    // NO: open => HIGH; NC: open => LOW. Closing is the inverse.
    let nc = config.r#type == RelayType::NC;
    let open_level = if nc { "LOW" } else { "HIGH" };
    let closed = closed_level(nc);

    let mut e = NodeEmission {
        declarations: vec![
            format!("const uint8_t {var} = {pin};"),
            format!("bool {open_state} = false;"),
        ],
        setup: vec![
            format!("pinMode({var}, OUTPUT);"),
            // Mirror runtime initialize: start closed.
            format!("digitalWrite({var}, {closed});"),
        ],
        ..NodeEmission::default()
    };

    // true / false: idempotent open/close on any firing source.
    for (port, level, state) in
        [("true", open_level, "true"), ("false", closed, "false")]
    {
        let binding = bind_pulses(&format!("relay_{token}_{port}"), inputs.on(port));
        e.declarations.extend(binding.declarations.iter().cloned());
        e.loop_body.extend(binding.loop_lines.iter().cloned());
        if let Some(any) = binding.any_fired() {
            e.loop_body.push(format!(
                "if ({any}) {{ digitalWrite({var}, {level}); {open_state} = {state}; }}"
            ));
        }
    }

    // toggle: one flip per fired source.
    let binding = bind_pulses(&format!("relay_{token}_toggle"), inputs.on("toggle"));
    e.declarations.extend(binding.declarations.iter().cloned());
    e.loop_body.extend(binding.loop_lines.iter().cloned());
    for fired in &binding.fired {
        e.loop_body.push(format!(
            "if ({fired}) {{ {open_state} = !{open_state}; digitalWrite({var}, {open_state} ? {open_level} : {closed}); }}"
        ));
    }

    e
}

/// The digital level written when the relay is closed, per relay type.
fn closed_level(normally_closed: bool) -> &'static str {
    if normally_closed {
        "HIGH"
    } else {
        "LOW"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
    use crate::flow::Position;
    use serde_json::json;

    fn relay(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Relay".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn on(port: &str, expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add(port, SourceExpr::level(expr));
        inputs
    }

    #[test]
    fn relay_sets_output_and_starts_closed_no() {
        let e = emit(&relay("r-1", json!({ "pin": 10 })), &NodeInputs::default());
        assert!(e.setup.iter().any(|s| s.contains("OUTPUT")));
        // NO relay closed => LOW.
        assert!(e.setup.iter().any(|s| s.contains("digitalWrite") && s.contains("LOW")));
    }

    #[test]
    fn relay_nc_inverts_closed_level() {
        let e = emit(&relay("r-1", json!({ "pin": 10, "type": "NC" })), &NodeInputs::default());
        // NC relay closed => HIGH.
        assert!(e.setup.iter().any(|s| s.contains("digitalWrite") && s.contains("HIGH")));
    }

    #[test]
    fn true_port_opens_and_false_port_closes() {
        let mut inputs = NodeInputs::default();
        inputs.add("true", SourceExpr::level(CppExpr::boolean("a")));
        inputs.add("false", SourceExpr::level(CppExpr::boolean("b")));
        let e = emit(&relay("r-1", json!({ "pin": 10 })), &inputs);
        let body = e.loop_body.join("\n");
        assert!(body.contains("digitalWrite(relay_r_1_pin, HIGH); relay_r_1_open = true"), "{body}");
        assert!(body.contains("digitalWrite(relay_r_1_pin, LOW); relay_r_1_open = false"), "{body}");
    }

    #[test]
    fn nc_relay_swaps_open_and_closed_levels() {
        let e = emit(&relay("r-1", json!({ "type": "NC" })), &on("true", CppExpr::boolean("a")));
        assert!(
            e.loop_body.iter().any(|l| l.contains("digitalWrite(relay_r_1_pin, LOW); relay_r_1_open = true")),
            "NC open writes LOW"
        );
    }

    #[test]
    fn toggle_flips_tracked_state() {
        let e = emit(&relay("r-1", json!({})), &on("toggle", CppExpr::boolean("btn")));
        assert!(
            e.loop_body.iter().any(|l| l.contains("relay_r_1_open = !relay_r_1_open")),
            "toggle flips is_open"
        );
    }

    #[test]
    fn unwired_relay_does_no_loop_work() {
        let e = emit(&relay("r-1", json!({})), &NodeInputs::default());
        assert!(e.loop_body.is_empty());
    }

    #[test]
    fn relay_emits_deterministically() {
        let n = relay("r-1", json!({ "pin": 10, "type": "NC" }));
        let inputs = on("toggle", CppExpr::boolean("x"));
        assert_eq!(emit(&n, &inputs), emit(&n, &inputs));
    }
}
