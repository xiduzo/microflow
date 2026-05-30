//! Led emitter — mirrors `runtime/output/led.rs`.
//!
//! The live Led sets `pinMode(pin, OUTPUT)` then `digitalWrite(pin, LOW)` on
//! initialize (off by default). On/off drive `digitalWrite`; brightness drives
//! `analogWrite` (PWM). The generated sketch emits the OUTPUT pin setup and a
//! `digitalWrite` in `loop()` that reflects the wired source's state, matching
//! the runtime's default-off behavior.

use crate::codegen::emit::{pin_or_default, NodeEmission, NodeToken};
use crate::flow::FlowNode;

/// Default pin matches `runtime/output/led.rs::default_pin` (13).
const DEFAULT_PIN: u8 = 13;

/// Emit C++ for a Led Node. `driver` is the C++ boolean expression that drives
/// the Led's state (from a wired input), or `None` for an unconnected Led which
/// stays in its initialized-off state.
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let pin = pin_or_default(node, DEFAULT_PIN);
    let var = format!("led_{}_pin", node.id_token());

    let mut e = NodeEmission {
        declarations: vec![format!("const uint8_t {var} = {pin};")],
        setup: vec![
            format!("pinMode({var}, OUTPUT);"),
            // Mirror runtime initialize: start off.
            format!("digitalWrite({var}, LOW);"),
        ],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        e.loop_body
            .push(format!("digitalWrite({var}, ({expr}) ? HIGH : LOW);"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn led(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Led".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    /// Scenario: Each supported Node type emits deterministic code.
    #[test]
    fn led_emits_deterministically() {
        let n = led("led-1", json!({ "pin": 13 }));
        let first = emit(&n, None);
        let second = emit(&n, None);
        assert_eq!(first, second, "same Led must emit identical C++ each time");
    }

    #[test]
    fn led_sets_output_pin_mode_and_starts_off() {
        let e = emit(&led("led-1", json!({ "pin": 8 })), None);
        assert!(e.declarations.iter().any(|d| d.contains("= 8;")));
        assert!(e.setup.iter().any(|s| s.contains("pinMode") && s.contains("OUTPUT")));
        assert!(e.setup.iter().any(|s| s.contains("digitalWrite") && s.contains("LOW")));
    }

    #[test]
    fn led_uses_default_pin_when_missing() {
        let e = emit(&led("led-1", json!({})), None);
        assert!(e.declarations.iter().any(|d| d.contains("= 13;")));
    }

    #[test]
    fn led_writes_driver_expression_in_loop() {
        let e = emit(&led("led-1", json!({ "pin": 5 })), Some("btn_6_state"));
        assert!(e.loop_body.iter().any(|l| l.contains("digitalWrite") && l.contains("btn_6_state")));
    }
}
