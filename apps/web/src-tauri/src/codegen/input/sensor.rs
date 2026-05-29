//! Sensor emitter — mirrors `runtime/input/sensor.rs`.
//!
//! The live Sensor sets the ANALOG pin mode and reports `analogRead` values.
//! Its pin is stored as a string (`"A0"` or a numeric pin) and resolved to a
//! numeric pin via `analog_pin()`. The generated sketch declares the analog pin
//! and stores `analogRead(pin)` into an `int` state variable each loop, which
//! downstream Nodes read.

use crate::codegen::emit::{pin_or_default, NodeEmission, NodeToken};
use crate::runtime::types::FlowNode;

/// Default analog pin matches `runtime/input/sensor.rs` (`"A0"` => 0).
const DEFAULT_PIN: u8 = 0;

/// The C++ `int` variable name holding this Sensor's latest reading.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("sensor_{}_value", node.id_token())
}

/// Emit C++ for a Sensor Node.
#[must_use]
pub fn emit(node: &FlowNode) -> NodeEmission {
    let pin = pin_or_default(node, DEFAULT_PIN);
    let pin_var = format!("sensor_{}_pin", node.id_token());
    let value = value_var(node);

    NodeEmission {
        declarations: vec![
            format!("const uint8_t {pin_var} = A{pin};"),
            format!("int {value} = 0;"),
        ],
        setup: vec![format!("pinMode({pin_var}, INPUT);")],
        loop_body: vec![format!("{value} = analogRead({pin_var});")],
        ..NodeEmission::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::Position;
    use serde_json::json;

    fn sensor(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Sensor".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn sensor_reads_analog_pin() {
        let e = emit(&sensor("s-1", json!({ "pin": "A0" })));
        assert!(e.loop_body.iter().any(|l| l.contains("analogRead")));
        assert!(e.declarations.iter().any(|d| d.contains("A0")));
    }

    #[test]
    fn sensor_resolves_numeric_pin() {
        let e = emit(&sensor("s-1", json!({ "pin": "2" })));
        assert!(e.declarations.iter().any(|d| d.contains("A2")));
    }

    #[test]
    fn sensor_emits_deterministically() {
        let n = sensor("s-1", json!({ "pin": "A0" }));
        assert_eq!(emit(&n), emit(&n));
    }
}
