//! Led emitter — mirrors `nodes/led/runtime.rs`.
//!
//! The live Led sets `pinMode(pin, OUTPUT)` then `digitalWrite(pin, LOW)` on
//! initialize (off by default) and exposes four ports: `true` / `false` switch
//! it digitally on/off, `toggle` flips it, and `value` drives PWM brightness
//! (the incoming value clamped to `0..=255`, exactly `ComponentValue::as_u8`
//! with the runtime's 255 fallback for non-numeric payloads). The generated
//! sketch binds each wired port, and each acts on its sources' firing ticks —
//! a write per value the runtime would dispatch, so a `value` that has not
//! moved does not undo a later `true` / `false` / `toggle`. An on/off state
//! variable tracks the runtime's `is_on` so `toggle` flips from the last
//! written state. A brightness lights the Led by the runtime's rule
//! ([`analog_write_lights_from`]): any level above 0 on a PWM pin, 128 and up
//! on a pin without PWM, where `analogWrite` switches the pin fully on or off.
//!
//! The Led's own `value` (what it emits) is its level: 0 when off, 1 when
//! switched on, the brightness over 255 after a `value`. The sketch holds that
//! level as the byte it wrote (`255` for on), so the emitted value is
//! `level / 255.0` and costs one byte of RAM.

use super::config::LedConfig;
use crate::codegen::board::BoardTarget;
use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{extra_sources_note, CppExpr, NodeInputs, SourceExpr};
use crate::config::{resolve, UnreadableConfig};
use crate::firmata::analog_write_lights_from;
use crate::flow::FlowNode;

/// The pin this Led is emitted on — the same resolution `emit` uses, exposed
/// so validation can never drift from emission.
pub(crate) fn pin(node: &FlowNode) -> Result<u8, UnreadableConfig> {
    Ok(resolve::<LedConfig>(&node.data)?.pin)
}

/// The byte the Led last wrote: 0 off, 255 on, or the brightness.
fn level_var(node: &FlowNode) -> String {
    format!("led_{}_level", node.id_token())
}

/// What the Led emits on `value`: `0.0` off, `1.0` on, `brightness / 255`
/// after a `value` — changing at the same writes as the runtime's
/// `set_value`.
#[must_use]
pub(crate) fn output(node: &FlowNode) -> SourceExpr {
    SourceExpr::level(CppExpr::number(format!("({} / 255.0)", level_var(node))))
}

/// Emit C++ for a Led Node (also backs the Vibration Node, a digital output
/// sharing the live Led implementation). Unwired Leds stay initialized-off.
pub(crate) fn emit(node: &FlowNode, inputs: &NodeInputs, target: &BoardTarget) -> Result<NodeEmission, UnreadableConfig> {
    let pin = pin(node)?;
    // What a brightness must reach to leave the Led lit on this pin — the
    // runtime's rule, from the board's own pin table.
    let has_pwm = target.pins.iter().find(|p| p.number == pin).map(|p| p.pwm);
    let lit_from = analog_write_lights_from(has_pwm);
    let token = node.id_token();
    let var = format!("led_{token}_pin");
    let on = format!("led_{token}_on");
    let level = level_var(node);

    let mut e = NodeEmission {
        declarations: vec![
            format!("const uint8_t {var} = {pin};"),
            format!("bool {on} = false;"),
            format!("uint8_t {level} = 0;"),
        ],
        setup: vec![
            format!("pinMode({var}, OUTPUT);"),
            // Mirror runtime initialize: start off.
            format!("digitalWrite({var}, LOW);"),
        ],
        ..NodeEmission::default()
    };

    // value: PWM brightness, written when its source fires — as the runtime
    // writes on every dispatched value.
    let value_sources = inputs.on("value");
    if let Some(note) = extra_sources_note("value", value_sources) {
        e.declarations.push(note);
    }
    if let Some(source) = value_sources.first() {
        let binding = e.bind_port(&format!("led_{token}_value"), std::slice::from_ref(source));
        let b = format!("led_{token}_brightness");
        e.loop_body.push(format!("if ({}) {{", binding.fired[0]));
        e.loop_body
            .push(format!("  uint8_t {b} = {};", source.value.as_u8_or(255)));
        e.loop_body.push(format!("  analogWrite({var}, {b});"));
        e.loop_body.push(format!("  {on} = {b} >= {lit_from};"));
        e.loop_body.push(format!("  {level} = {b};"));
        e.loop_body.push("}".to_string());
    }

    // true / false: idempotent digital writes on any firing source.
    for (port, write, state, byte) in
        [("true", "HIGH", "true", "255"), ("false", "LOW", "false", "0")]
    {
        let binding = e.bind_port(&format!("led_{token}_{port}"), inputs.on(port));
        if let Some(any) = binding.any_fired() {
            e.loop_body.push(format!(
                "if ({any}) {{ digitalWrite({var}, {write}); {on} = {state}; {level} = {byte}; }}"
            ));
        }
    }

    // toggle: one flip per fired source, from the tracked on/off state.
    let binding = e.bind_port(&format!("led_{token}_toggle"), inputs.on("toggle"));
    for fired in &binding.fired {
        e.loop_body.push(format!(
            "if ({fired}) {{ {on} = !{on}; digitalWrite({var}, {on} ? HIGH : LOW); {level} = {on} ? 255 : 0; }}"
        ));
    }

    Ok(e)
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

    /// The Led's emission on an Uno.
    fn emit(node: &FlowNode, inputs: &NodeInputs) -> Result<NodeEmission, UnreadableConfig> {
        super::emit(node, inputs, &crate::codegen::board::target_by_id("uno").expect("uno is supported"))
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
        let first = emit(&n, &NodeInputs::default()).unwrap();
        let second = emit(&n, &NodeInputs::default()).unwrap();
        assert_eq!(first, second, "same Led must emit identical C++ each time");
    }

    #[test]
    fn led_sets_output_pin_mode_and_starts_off() {
        let e = emit(&led("led-1", json!({ "pin": 8 })), &NodeInputs::default()).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("= 8;")));
        assert!(e.setup.iter().any(|s| s.contains("pinMode") && s.contains("OUTPUT")));
        assert!(e.setup.iter().any(|s| s.contains("digitalWrite") && s.contains("LOW")));
    }

    #[test]
    fn led_uses_default_pin_when_missing() {
        let e = emit(&led("led-1", json!({})), &NodeInputs::default()).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("= 13;")));
    }

    #[test]
    fn value_port_drives_pwm_brightness_like_the_runtime() {
        let e = emit(&led("led-1", json!({ "pin": 5 })), &on("value", CppExpr::number("sensor_v"))).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains("constrain((double)(sensor_v), 0.0, 255.0)"), "as_u8 clamp: {body}");
        assert!(body.contains("analogWrite(led_led_1_pin"), "value is a PWM write: {body}");
        assert!(body.contains("led_led_1_on = led_led_1_brightness >= 1"), "tracks is_on: {body}");
    }

    /// On a pin without PWM (13 on the Uno) `analogWrite` lights the Led only
    /// from 128, and so does the runtime.
    #[test]
    fn value_port_on_a_pin_without_pwm_is_on_from_128() {
        let e = emit(&led("led-1", json!({ "pin": 13 })), &on("value", CppExpr::number("v"))).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains("led_led_1_on = led_led_1_brightness >= 128"), "{body}");
    }

    #[test]
    fn bool_source_on_value_maps_to_zero_or_one_like_as_u8() {
        let e = emit(&led("led-1", json!({})), &on("value", CppExpr::boolean("btn"))).unwrap();
        assert!(
            e.loop_body.iter().any(|l| l.contains("(btn) ? 1 : 0")),
            "Bool(as_u8) is 1/0, mirroring the runtime"
        );
    }

    #[test]
    fn true_and_false_ports_write_digital_levels_on_pulse() {
        let mut inputs = NodeInputs::default();
        // The wiring layer maps a Button's `true`/`false` handles to events
        // on its change flag; mirror that shape here.
        inputs.add("true", SourceExpr::event(CppExpr::boolean("a"), "(a_changed && a)"));
        inputs.add("false", SourceExpr::event(CppExpr::boolean("b"), "(b_changed && !b)"));
        let e = emit(&led("led-1", json!({})), &inputs).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains("digitalWrite(led_led_1_pin, HIGH)"), "true port: {body}");
        assert!(body.contains("digitalWrite(led_led_1_pin, LOW)"), "false port: {body}");
        assert!(body.contains("(a_changed && a)") && body.contains("(b_changed && !b)"), "pulse-driven: {body}");
    }

    #[test]
    fn toggle_port_flips_tracked_state_per_pulse() {
        let e = emit(&led("led-1", json!({})), &on("toggle", CppExpr::boolean("btn"))).unwrap();
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("led_led_1_on = !led_led_1_on"),
            "toggle flips the tracked state: {body}"
        );
    }

    #[test]
    fn unwired_led_does_no_loop_work() {
        let e = emit(&led("led-1", json!({})), &NodeInputs::default()).unwrap();
        assert!(e.loop_body.is_empty(), "{:?}", e.loop_body);
    }
}
