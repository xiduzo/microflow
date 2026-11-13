//! Proximity emitter — mirrors `nodes/proximity/runtime.rs`.
//!
//! The live Proximity sensor (e.g. a Sharp GP2Y0A21YK IR rangefinder) sets the
//! ANALOG pin mode and reports `analogRead` values. Its pin is an analog label
//! (`"A0"`) or a pin number, resolved against the board's real pin map exactly
//! as the runtime resolves it against the connected board
//! ([`analog_pin_declaration`], shared with the Sensor emitter); the resolved
//! pin number is emitted, since the `A{n}` macros are not defined for every
//! index on every core (the ESP32 core lacks `A1`/`A2`).
//! Each loop, `analogRead(pin)` is stored into an `int` state variable which
//! downstream Nodes read — the same reading the runtime forwards.

use super::config::ProximityConfig;
use crate::codegen::board::BoardTarget;
use crate::codegen::emit::{analog_pin_declaration, NodeEmission, NodeToken};
use crate::firmata::PinLabel;
use crate::flow::FlowNode;

/// The C++ `int` variable name holding this Proximity sensor's latest reading.
#[must_use]
pub(crate) fn value_var(node: &FlowNode) -> String {
    format!("proximity_{}_value", node.id_token())
}

/// Emit C++ for a Proximity Node.
#[must_use]
pub(crate) fn emit(node: &FlowNode, target: &BoardTarget) -> NodeEmission {
    let pin_var = format!("proximity_{}_pin", node.id_token());
    let value = value_var(node);
    let config: ProximityConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    let label = PinLabel::parse(&config.pin).unwrap_or(PinLabel::Analog(0));
    let pin_decl = analog_pin_declaration(label, target, &pin_var);

    NodeEmission {
        declarations: vec![pin_decl, format!("int {value} = 0;")],
        setup: vec![format!("pinMode({pin_var}, INPUT);")],
        loop_body: vec![format!("{value} = analogRead({pin_var});")],
        ..NodeEmission::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::board::target_by_id;
    use crate::flow::Position;
    use serde_json::json;

    fn proximity(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Proximity".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn uno() -> BoardTarget {
        target_by_id("uno").expect("uno is supported")
    }

    #[test]
    fn proximity_reads_analog_pin() {
        let e = emit(&proximity("p-1", json!({ "pin": "A0" })), &uno());
        assert!(e.loop_body.iter().any(|l| l.contains("analogRead")));
        // A0 resolves to the Uno's first analog input, pin 14; the analog name
        // stays visible as a comment.
        assert!(e.declarations.iter().any(|d| d.contains("= 14; // A0")));
    }

    /// A number is a pin (17 = the Uno's A3), as the runtime reads it.
    #[test]
    fn proximity_resolves_numeric_pin_as_a_pin() {
        let e = emit(&proximity("p-1", json!({ "pin": "17" })), &uno());
        assert!(e.declarations.iter().any(|d| d.contains("= 17; // A3")), "{:?}", e.declarations);
    }

    /// On the ESP32 the `A1`/`A2` macros do not exist; the emitted pin is the
    /// board's real analog GPIO so the Sketch compiles.
    #[test]
    fn proximity_resolves_esp32_analog_index_to_real_gpio() {
        let esp32 = target_by_id("esp32").expect("esp32 is supported");
        let e = emit(&proximity("p-1", json!({ "pin": "A1" })), &esp32);
        // ESP32 analog inputs (sorted): 32, 33, 34, 35, 36, 39 — A1 => 33.
        assert!(
            e.declarations.iter().any(|d| d.contains("= 33; // A1")),
            "expected resolved GPIO, got: {:?}",
            e.declarations
        );
    }

    /// An index beyond the board's analog inputs still emits compilable code
    /// (validation warns separately) — clamped to the first analog input with
    /// an explanatory note.
    #[test]
    fn out_of_range_index_falls_back_to_first_analog_input() {
        let e = emit(&proximity("p-1", json!({ "pin": "A9" })), &uno());
        assert!(
            e.declarations
                .iter()
                .any(|d| d.contains("= 14;") && d.contains("A9 is not available")),
            "expected fallback with note, got: {:?}",
            e.declarations
        );
    }

    #[test]
    fn proximity_emits_deterministically() {
        let n = proximity("p-1", json!({ "pin": "A0" }));
        assert_eq!(emit(&n, &uno()), emit(&n, &uno()));
    }
}
