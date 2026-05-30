//! Relay emitter — mirrors `runtime/output/relay.rs`.
//!
//! The live Relay sets `pinMode(pin, OUTPUT)` and starts closed. For a
//! Normally-Open (NO) relay, "open" writes HIGH and "close" writes LOW; for a
//! Normally-Closed (NC) relay the signal is inverted. The generated sketch
//! emits the OUTPUT setup and, when driven, a `digitalWrite` that honours the
//! relay type so emitted behavior matches the runtime.

use crate::codegen::emit::{pin_or_default, NodeEmission, NodeToken};
use crate::flow::FlowNode;

/// Default pin matches `runtime/output/relay.rs::default_pin` (10).
const DEFAULT_PIN: u8 = 10;

/// True when the Node's `data.type` selects a Normally-Closed relay.
fn is_normally_closed(node: &FlowNode) -> bool {
    node.data
        .get("type")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|t| t.eq_ignore_ascii_case("NC"))
}

/// Emit C++ for a Relay Node. `driver` is the C++ boolean expression for the
/// desired open/closed state (true = open), or `None` for an unconnected relay
/// which stays in its initialized-closed state.
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let pin = pin_or_default(node, DEFAULT_PIN);
    let var = format!("relay_{}_pin", node.id_token());
    // NO: open => HIGH; NC: open => LOW. Closing is the inverse.
    let nc = is_normally_closed(node);

    let mut e = NodeEmission {
        declarations: vec![format!("const uint8_t {var} = {pin};")],
        setup: vec![
            format!("pinMode({var}, OUTPUT);"),
            // Mirror runtime initialize: start closed.
            format!("digitalWrite({var}, {});", closed_level(nc)),
        ],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        let open_level = if nc { "LOW" } else { "HIGH" };
        let closed = closed_level(nc);
        e.loop_body
            .push(format!("digitalWrite({var}, ({expr}) ? {open_level} : {closed});"));
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

    #[test]
    fn relay_sets_output_and_starts_closed_no() {
        let e = emit(&relay("r-1", json!({ "pin": 10 })), None);
        assert!(e.setup.iter().any(|s| s.contains("OUTPUT")));
        // NO relay closed => LOW.
        assert!(e.setup.iter().any(|s| s.contains("digitalWrite") && s.contains("LOW")));
    }

    #[test]
    fn relay_nc_inverts_closed_level() {
        let e = emit(&relay("r-1", json!({ "pin": 10, "type": "NC" })), None);
        // NC relay closed => HIGH.
        assert!(e.setup.iter().any(|s| s.contains("digitalWrite") && s.contains("HIGH")));
    }

    #[test]
    fn relay_emits_deterministically() {
        let n = relay("r-1", json!({ "pin": 10, "type": "NC" }));
        assert_eq!(emit(&n, Some("x")), emit(&n, Some("x")));
    }
}
