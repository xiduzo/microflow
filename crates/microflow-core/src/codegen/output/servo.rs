//! Servo emitter — mirrors `runtime/output/servo.rs`.
//!
//! The live Servo centers itself to the midpoint of its `[min, max]` range on
//! initialize and exposes five ports: `value` moves a standard servo to the
//! clamped position (or, for a continuous servo, maps a `-1..=1` speed to a
//! `0..=180` write with a `|speed| < 0.05` dead-zone at 90), `min` / `max`
//! jump to the range bounds, `rotate` is the continuous-speed input, and
//! `stop` centers a continuous servo (90 = no rotation). The generated sketch
//! uses the Servo library matching the target's core (`Servo.h` on AVR,
//! `ESP32Servo.h` on the ESP32 core — the AVR library does not build there):
//! it declares a `Servo` object, `attach`es it in `setup()`, writes the center
//! position, and binds each wired port — `value`/`rotate` as level writes,
//! `min`/`max`/`stop` as pulses.

use crate::codegen::board::{BoardTarget, CoreFamily};
use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, extra_sources_note, NodeInputs};
use crate::config::servo::{ServoConfig, ServoType};
use crate::flow::FlowNode;

/// The pin this Servo is emitted on — the same resolution `emit` uses, exposed
/// so validation can never drift from emission.
#[must_use]
pub fn pin(node: &FlowNode) -> u8 {
    serde_json::from_value::<ServoConfig>(node.data.clone())
        .unwrap_or_default()
        .pin
}

/// The continuous-servo write for a `-1..=1` speed expression `v`: 90 inside
/// the dead-zone, else `(v + 1) * 90` clamped to `0..=180` — a transcription
/// of the runtime's `rotate`.
fn rotate_expr(v: &str) -> String {
    format!("((fabs({v}) < 0.05) ? 90 : (int)constrain(({v} + 1.0) * 90.0, 0.0, 180.0))")
}

/// Emit C++ for a Servo Node. An unwired Servo holds its center.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs, target: &BoardTarget) -> NodeEmission {
    let config: ServoConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    let pin = config.pin;
    let token = node.id_token();
    let obj = format!("servo_{token}");
    let pin_var = format!("servo_{token}_pin");
    let (min, max) = (config.range.min, config.range.max);
    let center = (min + max) / 2;
    let continuous = config.r#type == ServoType::Continuous;

    // The AVR Servo library does not build on the ESP32 core, which ships the
    // API-compatible ESP32Servo instead.
    let include = match target.core {
        CoreFamily::Avr => "#include <Servo.h>",
        CoreFamily::Esp32 => "#include <ESP32Servo.h>",
    };

    let mut e = NodeEmission {
        includes: vec![include.to_string()],
        declarations: vec![
            format!("const uint8_t {pin_var} = {pin};"),
            format!("Servo {obj};"),
        ],
        setup: vec![
            format!("{obj}.attach({pin_var});"),
            // Mirror runtime initialize: center the servo.
            format!("{obj}.write({center});"),
        ],
        ..NodeEmission::default()
    };

    // value: position (standard) or speed (continuous), a level write.
    let value_sources = inputs.on("value");
    if let Some(note) = extra_sources_note("value", value_sources) {
        e.declarations.push(note);
    }
    if let Some(source) = value_sources.first() {
        let v = source.value.as_double_or("90.0");
        let write = if continuous {
            rotate_expr(&v)
        } else {
            format!("(int)constrain({v}, (double){min}, (double){max})")
        };
        e.loop_body.push(format!("{obj}.write({write});"));
    }

    // rotate: the explicit continuous-speed input (the runtime rejects it for
    // standard servos, so a wired rotate on a standard servo is noted instead).
    let rotate_sources = inputs.on("rotate");
    if let Some(note) = extra_sources_note("rotate", rotate_sources) {
        e.declarations.push(note);
    }
    if let Some(source) = rotate_sources.first() {
        if continuous {
            let v = source.value.as_double();
            e.loop_body.push(format!("{obj}.write({});", rotate_expr(&v)));
        } else {
            e.declarations.push(
                "// note: 'rotate' only works with continuous servos — edge ignored".to_string(),
            );
        }
    }

    // min / max / stop: pulse jumps. stop centers a continuous servo (90).
    for (port, target) in [
        ("min", min.to_string()),
        ("max", max.to_string()),
        ("stop", "90".to_string()),
    ] {
        let binding = bind_pulses(&format!("servo_{token}_{port}"), inputs.on(port));
        e.declarations.extend(binding.declarations.iter().cloned());
        e.loop_body.extend(binding.loop_lines.iter().cloned());
        if let Some(any) = binding.any_fired() {
            e.loop_body
                .push(format!("if ({any}) {{ {obj}.write({target}); }}"));
        }
    }

    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
    use crate::flow::Position;
    use serde_json::json;

    fn servo(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Servo".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn on(port: &str, expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add(port, SourceExpr::level(expr));
        inputs
    }

    fn uno() -> BoardTarget {
        crate::codegen::board::target_by_id("uno").expect("uno is supported")
    }

    /// Scenario: A Servo Node pulls in its supporting library.
    #[test]
    fn servo_includes_library_and_declares_object() {
        let e = emit(&servo("srv-1", json!({ "pin": 9 })), &NodeInputs::default(), &uno());
        assert!(e.includes.iter().any(|i| i.contains("Servo.h")), "missing Servo.h include");
        assert!(e.declarations.iter().any(|d| d.contains("Servo servo_srv_1")), "missing Servo object");
    }

    /// Scenario: A Servo Node pulls in its supporting library — attaches to pin.
    #[test]
    fn servo_attaches_to_its_pin() {
        let e = emit(&servo("srv-1", json!({ "pin": 9 })), &NodeInputs::default(), &uno());
        assert!(e.declarations.iter().any(|d| d.contains("= 9;")));
        assert!(e.setup.iter().any(|s| s.contains(".attach(")), "missing attach call");
    }

    #[test]
    fn servo_centers_within_range() {
        let e = emit(
            &servo("srv-1", json!({ "pin": 9, "range": { "min": 0, "max": 180 } })),
            &NodeInputs::default(),
            &uno(),
        );
        assert!(e.setup.iter().any(|s| s.contains(".write(90)")), "should center to 90");
    }

    #[test]
    fn value_port_writes_clamped_position() {
        let e = emit(
            &servo("srv-1", json!({ "range": { "min": 10, "max": 170 } })),
            &on("value", CppExpr::number("v")),
            &uno(),
        );
        let body = e.loop_body.join("\n");
        assert!(body.contains("constrain(") && body.contains("10") && body.contains("170"), "{body}");
    }

    #[test]
    fn continuous_servo_maps_speed_with_dead_zone() {
        let e = emit(
            &servo("srv-1", json!({ "type": "continuous" })),
            &on("value", CppExpr::number("speed")),
            &uno(),
        );
        let body = e.loop_body.join("\n");
        assert!(body.contains("fabs(") && body.contains("? 90 :"), "dead-zone at 90: {body}");
        assert!(body.contains("+ 1.0) * 90.0"), "speed mapping: {body}");
    }

    #[test]
    fn min_max_ports_jump_to_range_bounds() {
        let mut inputs = NodeInputs::default();
        inputs.add("min", SourceExpr::level(CppExpr::boolean("a")));
        inputs.add("max", SourceExpr::level(CppExpr::boolean("b")));
        let e = emit(&servo("srv-1", json!({ "range": { "min": 20, "max": 160 } })), &inputs, &uno());
        let body = e.loop_body.join("\n");
        assert!(body.contains(".write(20)"), "min jump: {body}");
        assert!(body.contains(".write(160)"), "max jump: {body}");
    }

    #[test]
    fn rotate_on_standard_servo_is_noted_not_emitted() {
        let e = emit(&servo("srv-1", json!({})), &on("rotate", CppExpr::number("v")), &uno());
        assert!(e.loop_body.is_empty(), "standard servo rejects rotate");
        assert!(e.declarations.iter().any(|d| d.contains("continuous")));
    }

    /// The AVR Servo library does not build on the ESP32 core; the ESP32
    /// target pulls in the API-compatible `ESP32Servo` library instead.
    #[test]
    fn servo_on_esp32_includes_esp32servo() {
        let esp32 = crate::codegen::board::target_by_id("esp32").expect("esp32 is supported");
        let e = emit(&servo("srv-1", json!({ "pin": 25 })), &NodeInputs::default(), &esp32);
        assert!(
            e.includes.iter().any(|i| i.contains("ESP32Servo.h")),
            "expected ESP32Servo include, got: {:?}",
            e.includes
        );
        assert!(!e.includes.iter().any(|i| i == "#include <Servo.h>"), "no AVR Servo include");
    }

    #[test]
    fn servo_emits_deterministically() {
        let n = servo("srv-1", json!({ "pin": 9 }));
        assert_eq!(
            emit(&n, &NodeInputs::default(), &uno()),
            emit(&n, &NodeInputs::default(), &uno())
        );
    }
}
