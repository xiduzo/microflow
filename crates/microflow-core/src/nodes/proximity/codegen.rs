//! Proximity emitter — mirrors `nodes/proximity/runtime.rs`.
//!
//! The live Proximity sensor (e.g. a Sharp GP2Y0A21YK IR rangefinder) sets the
//! ANALOG pin mode and reports `analogRead` values. Its pin is an analog label
//! (`"A0"`) or a pin number, resolved against the board's real pin map exactly
//! as the runtime resolves it against the connected board
//! ([`analog_pin_declaration`], shared with the Sensor emitter); the resolved
//! pin number is emitted, since the `A{n}` macros are not defined for every
//! index on every core (the ESP32 core lacks `A1`/`A2`).
//! Each loop, `analogRead(pin)` is converted to centimetres the way the
//! Node's controller reads ([`Ranging`], the conversion the runtime applies),
//! and the distance downstream Nodes read moves only when the new one is more
//! than [`MIN_MOVE_CM`] away from it — the distance the runtime hands on.

use super::config::{ProximityConfig, Ranging, MIN_MOVE_CM};
use crate::codegen::board::BoardTarget;
use crate::codegen::emit::{analog_pin_declaration, cpp_double, NodeEmission, NodeToken};
use crate::config::{resolve, UnreadableConfig};
use crate::firmata::PinLabel;
use crate::flow::FlowNode;

/// The C++ `double` variable name holding the distance, in centimetres, this
/// Proximity sensor last handed on.
#[must_use]
pub(crate) fn value_var(node: &FlowNode) -> String {
    format!("proximity_{}_value", node.id_token())
}

/// The C++ statements that set `cm` (a new `double`) to the distance the
/// reading `raw` (a C++ expression) stands for under `ranging`.
fn centimetres(ranging: Ranging, raw: &str, cm: &str) -> Vec<String> {
    let reading = format!("(double){raw}");
    match ranging {
        Ranging::Infrared { scale, offset, near, far } => {
            let volts = format!("{cm}_volts");
            let (offset, far) = (cpp_double(offset), cpp_double(far));
            vec![
                format!(
                    "double {volts} = {reading} * {} / {};",
                    cpp_double(Ranging::VOLTS),
                    cpp_double(Ranging::STEPS)
                ),
                format!(
                    "double {cm} = {volts} > {offset} ? constrain({} / ({volts} - {offset}), {}, {far}) : {far};",
                    cpp_double(scale),
                    cpp_double(near)
                ),
            ]
        }
        Ranging::Linear { numerator, denominator, near, far } => vec![format!(
            "double {cm} = constrain({reading} * {} / {}, {}, {});",
            cpp_double(numerator),
            cpp_double(denominator),
            cpp_double(near),
            cpp_double(far)
        )],
    }
}

/// The analog pin this Proximity sensor reads, as the Node names it (`"A0"`,
/// the default, or a pin number) — the same resolution `emit` uses, exposed so
/// validation can never drift from emission.
pub(crate) fn label(node: &FlowNode) -> Result<PinLabel, UnreadableConfig> {
    Ok(resolve::<ProximityConfig>(&node.data)?.pin)
}

/// Emit C++ for a Proximity Node.
pub(crate) fn emit(node: &FlowNode, target: &BoardTarget) -> Result<NodeEmission, UnreadableConfig> {
    let config = resolve::<ProximityConfig>(&node.data)?;
    let token = node.id_token();
    let pin_var = format!("proximity_{token}_pin");
    let value = value_var(node);
    let cm = format!("proximity_{token}_cm");
    let pin_decl = analog_pin_declaration(config.pin, target, &pin_var);

    let mut loop_body = centimetres(config.ranging(), &format!("analogRead({pin_var})"), &cm);
    loop_body.push(format!(
        "if (fabs({cm} - {value}) > {}) {{ {value} = {cm}; }}",
        cpp_double(MIN_MOVE_CM)
    ));
    Ok(NodeEmission {
        declarations: vec![pin_decl, format!("double {value} = 0.0;")],
        setup: vec![format!("pinMode({pin_var}, INPUT);")],
        loop_body,
        ..NodeEmission::default()
    })
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
        let e = emit(&proximity("p-1", json!({ "pin": "A0" })), &uno()).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("analogRead")));
        // A0 resolves to the Uno's first analog input, pin 14; the analog name
        // stays visible as a comment.
        assert!(e.declarations.iter().any(|d| d.contains("= 14; // A0")));
    }

    /// A number is a pin (17 = the Uno's A3), as the runtime reads it.
    #[test]
    fn proximity_resolves_numeric_pin_as_a_pin() {
        let e = emit(&proximity("p-1", json!({ "pin": "17" })), &uno()).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("= 17; // A3")), "{:?}", e.declarations);
    }

    /// On the ESP32 the `A1`/`A2` macros do not exist; the emitted pin is the
    /// board's real analog GPIO so the Sketch compiles.
    #[test]
    fn proximity_resolves_esp32_analog_index_to_real_gpio() {
        let esp32 = target_by_id("esp32").expect("esp32 is supported");
        let e = emit(&proximity("p-1", json!({ "pin": "A1" })), &esp32).unwrap();
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
        let e = emit(&proximity("p-1", json!({ "pin": "A9" })), &uno()).unwrap();
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
        assert_eq!(emit(&n, &uno()).unwrap(), emit(&n, &uno()).unwrap());
    }
}
