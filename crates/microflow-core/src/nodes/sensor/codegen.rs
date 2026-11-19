//! Sensor emitter — mirrors `nodes/sensor/runtime.rs`.
//!
//! The live Sensor sets the ANALOG pin mode and reports `analogRead` values.
//! Its pin is an analog label (`"A0"`) or a pin number (`15`, what the editor
//! stores once a pin is picked), resolved against the board's real pin map
//! exactly as the runtime resolves it against the connected board
//! ([`analog_pin_declaration`]). The `A{n}` macros are not defined for every
//! index on every core (the ESP32 core lacks `A1`/`A2`), so the resolved pin
//! number is emitted, with the `A{n}` name in a trailing comment.
//! Each loop, `analogRead(pin)` is read, and the `int` state variable
//! downstream Nodes read takes it once it is `threshold` or more away from
//! the value it holds — the reading the runtime hands on.

use super::config::SensorConfig;
use crate::codegen::board::BoardTarget;
use crate::codegen::emit::{analog_pin_declaration, NodeEmission, NodeToken};
use crate::firmata::PinLabel;
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;

/// The Node types backed by this analog-read emitter (see
/// [`crate::codegen::emit_node`]): the generic Sensor plus the specialised
/// analog sensors that share the live Sensor implementation. Validation
/// consumes this list so its analog checks cover exactly the Nodes emitted
/// here.
pub(crate) const ANALOG_SENSOR_TYPES: [&str; 6] =
    ["Sensor", "Force", "HallEffect", "Ldr", "Potentiometer", "Tilt"];

/// The C++ `int` variable name holding this Sensor's latest reading.
#[must_use]
pub(crate) fn value_var(node: &FlowNode) -> String {
    format!("sensor_{}_value", node.id_token())
}

/// The analog pin this Sensor reads, as the Node names it (`"A0"`, the
/// default, or a pin number) — the same resolution `emit` uses, exposed so
/// validation can never drift from emission.
pub(crate) fn label(node: &FlowNode) -> Result<PinLabel, UnreadableConfig> {
    Ok(resolve::<SensorConfig>(&node.data)?.pin)
}

/// Emit C++ for a Sensor Node.
pub(crate) fn emit(node: &FlowNode, target: &BoardTarget) -> Result<NodeEmission, UnreadableConfig> {
    let config = resolve::<SensorConfig>(&node.data)?;
    let token = node.id_token();
    let pin_var = format!("sensor_{token}_pin");
    let value = value_var(node);
    let reading = format!("sensor_{token}_reading");
    let pin_decl = analog_pin_declaration(config.pin, target, &pin_var);
    let threshold = config.threshold;

    Ok(NodeEmission {
        declarations: vec![pin_decl, format!("int {value} = 0;")],
        setup: vec![format!("pinMode({pin_var}, INPUT);")],
        loop_body: vec![
            format!("int {reading} = analogRead({pin_var});"),
            // A reading moves the value once it is `threshold` away from it,
            // as the runtime hands on a reading.
            format!(
                "if (({reading} > {value} ? {reading} - {value} : {value} - {reading}) >= {threshold}) {{ {value} = {reading}; }}"
            ),
        ],
        ..NodeEmission::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::board::target_by_id;
    use crate::flow::Position;
    use serde_json::json;

    fn sensor(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Sensor".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn uno() -> BoardTarget {
        target_by_id("uno").expect("uno is supported")
    }

    #[test]
    fn sensor_reads_analog_pin() {
        let e = emit(&sensor("s-1", json!({ "pin": "A0" })), &uno()).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("analogRead")));
        // A0 resolves to the Uno's first analog input, pin 14; the analog name
        // stays visible as a comment.
        assert!(e.declarations.iter().any(|d| d.contains("= 14; // A0")));
    }

    /// A number is the pin the editor picked (15 = the Uno's A1), not an
    /// analog index: reading "15" as index 15 fell back to A0.
    #[test]
    fn sensor_resolves_numeric_pin_as_a_pin() {
        for pin in [json!(15), json!("15")] {
            let e = emit(&sensor("s-1", json!({ "pin": pin })), &uno()).unwrap();
            assert!(e.declarations.iter().any(|d| d.contains("= 15; // A1")), "{:?}", e.declarations);
        }
        let e = emit(&sensor("s-1", json!({ "pin": 2 })), &uno()).unwrap();
        assert!(
            e.declarations.iter().any(|d| d.contains("= 2;") && d.contains("not an analog input")),
            "{:?}",
            e.declarations
        );
    }

    /// On the ESP32 the `A1`/`A2` macros do not exist; the emitted pin is the
    /// board's real analog GPIO so the Sketch compiles.
    #[test]
    fn sensor_resolves_esp32_analog_index_to_real_gpio() {
        let esp32 = target_by_id("esp32").expect("esp32 is supported");
        let e = emit(&sensor("s-1", json!({ "pin": "A1" })), &esp32).unwrap();
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
        let e = emit(&sensor("s-1", json!({ "pin": "A9" })), &uno()).unwrap();
        assert!(
            e.declarations
                .iter()
                .any(|d| d.contains("= 14;") && d.contains("A9 is not available")),
            "expected fallback with note, got: {:?}",
            e.declarations
        );
    }

    #[test]
    fn sensor_emits_deterministically() {
        let n = sensor("s-1", json!({ "pin": "A0" }));
        assert_eq!(emit(&n, &uno()).unwrap(), emit(&n, &uno()).unwrap());
    }
}
