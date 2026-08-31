//! Proximity emitter — mirrors `runtime/input/proximity.rs`.
//!
//! The live Proximity sensor (e.g. a Sharp GP2Y0A21YK IR rangefinder) sets the
//! ANALOG pin mode and reports `analogRead` values. Its pin is stored as a
//! string (`"A0"` or a numeric pin) and resolved to an analog *index* via
//! `analog_pin()`. Like the Sensor emitter, the generated sketch resolves that
//! index against the board's real analog pin map — the `A{n}` macros are not
//! defined for every index on every core (the ESP32 core lacks `A1`/`A2`), so
//! emitting the resolved pin number is the only form that compiles everywhere.
//! Each loop, `analogRead(pin)` is stored into an `int` state variable which
//! downstream Nodes read — the same reading the runtime forwards.

use crate::codegen::board::BoardTarget;
use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::config::proximity::ProximityConfig;
use crate::flow::FlowNode;

/// The analog index (`A0` => 0) this Proximity sensor is emitted on — the same
/// resolution `emit` uses, exposed so validation can never drift from emission.
#[must_use]
pub fn analog_index(node: &FlowNode) -> u8 {
    serde_json::from_value::<ProximityConfig>(node.data.clone())
        .unwrap_or_default()
        .analog_pin()
}

/// The C++ `int` variable name holding this Proximity sensor's latest reading.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("proximity_{}_value", node.id_token())
}

/// Emit C++ for a Proximity Node.
#[must_use]
pub fn emit(node: &FlowNode, target: &BoardTarget) -> NodeEmission {
    let index = analog_index(node);
    let pin_var = format!("proximity_{}_pin", node.id_token());
    let value = value_var(node);

    // Resolve the analog index to the board's real pin number. An index the
    // board lacks is already surfaced as a validation warning; fall back to
    // the board's first analog input so the Sketch still compiles.
    let analog = target.analog_input_pins();
    let pin_decl = match (analog.get(index as usize), analog.first()) {
        (Some(pin), _) => format!("const uint8_t {pin_var} = {pin}; // A{index}"),
        (None, Some(first)) => format!(
            "const uint8_t {pin_var} = {first}; // note: A{index} is not available on this board — using its first analog input"
        ),
        // A board without analog inputs (none supported today): keep the
        // requested name so the mismatch is visible in the Sketch.
        (None, None) => format!("const uint8_t {pin_var} = A{index};"),
    };

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

    #[test]
    fn proximity_resolves_numeric_pin() {
        let e = emit(&proximity("p-1", json!({ "pin": "3" })), &uno());
        assert!(e.declarations.iter().any(|d| d.contains("// A3")));
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
