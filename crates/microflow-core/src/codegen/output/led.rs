//! Led emitter — mirrors `runtime/output/led.rs`.
//!
//! The live Led sets `pinMode(pin, OUTPUT)` then `digitalWrite(pin, LOW)` on
//! initialize (off by default) and exposes four ports: `true` / `false` switch
//! it digitally on/off, `toggle` flips it, and `value` drives PWM brightness
//! (the incoming value clamped to `0..=255`, exactly `ComponentValue::as_u8`
//! with the runtime's 255 fallback for non-numeric payloads). The generated
//! sketch binds each wired port: pulse ports act on their sources' firing
//! ticks; `value` is a level write each loop. An on/off state variable tracks
//! the runtime's `is_on` so `toggle` flips from the last written state.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, extra_sources_note, NodeInputs};
use crate::config::led::LedConfig;
use crate::flow::FlowNode;

/// Emit C++ for a Led Node (also backs the Vibration Node, a digital output
/// sharing the live Led implementation). Unwired Leds stay initialized-off.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let config: LedConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    let pin = config.pin;
    let token = node.id_token();
    let var = format!("led_{token}_pin");
    let on = format!("led_{token}_on");

    let mut e = NodeEmission {
        declarations: vec![
            format!("const uint8_t {var} = {pin};"),
            format!("bool {on} = false;"),
        ],
        setup: vec![
            format!("pinMode({var}, OUTPUT);"),
            // Mirror runtime initialize: start off.
            format!("digitalWrite({var}, LOW);"),
        ],
        ..NodeEmission::default()
    };

    // value: PWM brightness, a level write each tick (the runtime writes on
    // every dispatched value; sampling the level each loop is its polled twin).
    let value_sources = inputs.on("value");
    if let Some(note) = extra_sources_note("value", value_sources) {
        e.declarations.push(note);
    }
    if let Some(source) = value_sources.first() {
        let b = format!("led_{token}_brightness");
        e.loop_body
            .push(format!("uint8_t {b} = {};", source.value.as_u8_or(255)));
        e.loop_body.push(format!("analogWrite({var}, {b});"));
        e.loop_body.push(format!("{on} = {b} > 0;"));
    }

    // true / false: idempotent digital writes on any firing source.
    for (port, level, state) in [("true", "HIGH", "true"), ("false", "LOW", "false")] {
        let binding = bind_pulses(&format!("led_{token}_{port}"), inputs.on(port));
        e.declarations.extend(binding.declarations.iter().cloned());
        e.loop_body.extend(binding.loop_lines.iter().cloned());
        if let Some(any) = binding.any_fired() {
            e.loop_body.push(format!(
                "if ({any}) {{ digitalWrite({var}, {level}); {on} = {state}; }}"
            ));
        }
    }

    // toggle: one flip per fired source, from the tracked on/off state.
    let binding = bind_pulses(&format!("led_{token}_toggle"), inputs.on("toggle"));
    e.declarations.extend(binding.declarations.iter().cloned());
    e.loop_body.extend(binding.loop_lines.iter().cloned());
    for fired in &binding.fired {
        e.loop_body.push(format!(
            "if ({fired}) {{ {on} = !{on}; digitalWrite({var}, {on} ? HIGH : LOW); }}"
        ));
    }

    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
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

    fn on(port: &str, expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add(port, SourceExpr::level(expr));
        inputs
    }

    /// Scenario: Each supported Node type emits deterministic code.
    #[test]
    fn led_emits_deterministically() {
        let n = led("led-1", json!({ "pin": 13 }));
        let first = emit(&n, &NodeInputs::default());
        let second = emit(&n, &NodeInputs::default());
        assert_eq!(first, second, "same Led must emit identical C++ each time");
    }

    #[test]
    fn led_sets_output_pin_mode_and_starts_off() {
        let e = emit(&led("led-1", json!({ "pin": 8 })), &NodeInputs::default());
        assert!(e.declarations.iter().any(|d| d.contains("= 8;")));
        assert!(e.setup.iter().any(|s| s.contains("pinMode") && s.contains("OUTPUT")));
        assert!(e.setup.iter().any(|s| s.contains("digitalWrite") && s.contains("LOW")));
    }

    #[test]
    fn led_uses_default_pin_when_missing() {
        let e = emit(&led("led-1", json!({})), &NodeInputs::default());
        assert!(e.declarations.iter().any(|d| d.contains("= 13;")));
    }

    #[test]
    fn value_port_drives_pwm_brightness_like_the_runtime() {
        let e = emit(&led("led-1", json!({ "pin": 5 })), &on("value", CppExpr::number("sensor_v")));
        let body = e.loop_body.join("\n");
        assert!(body.contains("constrain((double)(sensor_v), 0.0, 255.0)"), "as_u8 clamp: {body}");
        assert!(body.contains("analogWrite(led_led_1_pin"), "value is a PWM write: {body}");
        assert!(body.contains("led_led_1_on = led_led_1_brightness > 0"), "tracks is_on: {body}");
    }

    #[test]
    fn bool_source_on_value_maps_to_zero_or_one_like_as_u8() {
        let e = emit(&led("led-1", json!({})), &on("value", CppExpr::boolean("btn")));
        assert!(
            e.loop_body.iter().any(|l| l.contains("(btn) ? 1 : 0")),
            "Bool(as_u8) is 1/0, mirroring the runtime"
        );
    }

    #[test]
    fn true_and_false_ports_write_digital_levels_on_pulse() {
        let mut inputs = NodeInputs::default();
        // The wiring layer maps a Button's `true`/`false` handles to
        // rising-edge sources; mirror that shape here.
        inputs.add("true", SourceExpr::rising(CppExpr::boolean("a")));
        inputs.add("false", SourceExpr::rising(CppExpr::boolean("b")));
        let e = emit(&led("led-1", json!({})), &inputs);
        let body = e.loop_body.join("\n");
        assert!(body.contains("digitalWrite(led_led_1_pin, HIGH)"), "true port: {body}");
        assert!(body.contains("digitalWrite(led_led_1_pin, LOW)"), "false port: {body}");
        assert!(body.contains("&& !led_led_1_true_prev0"), "pulse-driven: {body}");
    }

    #[test]
    fn toggle_port_flips_tracked_state_per_pulse() {
        let e = emit(&led("led-1", json!({})), &on("toggle", CppExpr::boolean("btn")));
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("led_led_1_on = !led_led_1_on"),
            "toggle flips the tracked state: {body}"
        );
    }

    #[test]
    fn unwired_led_does_no_loop_work() {
        let e = emit(&led("led-1", json!({})), &NodeInputs::default());
        assert!(e.loop_body.is_empty());
    }
}
