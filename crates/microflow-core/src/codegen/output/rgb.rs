//! Rgb emitter — mirrors `runtime/output/rgb.rs`.
//!
//! The live RGB LED drives three PWM pins (red/green/blue) from a stored
//! `Rgba` color and exposes five ports: `red` / `green` / `blue` set one
//! channel each (`0..=255`), `alpha` scales all channels (a `0..=100` percent
//! mapped to `0..=1` intensity), and `off` resets the color. Every update
//! recomputes the hardware writes as `channel * alpha`, inverted (`255 - v`)
//! for a common-anode (`isAnode`) LED.
//!
//! The generated sketch keeps the color as module-level state, binds each
//! wired channel port as a level assignment (`off` as a pulse), and rewrites
//! all three pins each loop from the same intensity/anode math — so a single
//! sensor can now drive one channel while a constant holds another, exactly
//! like the live Node.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, extra_sources_note, NodeInputs};
use crate::flow::FlowNode;

/// Channel pin defaults match `runtime/output/rgb.rs` (red=9, green=10, blue=11).
const DEFAULT_RED: u8 = 9;
const DEFAULT_GREEN: u8 = 10;
const DEFAULT_BLUE: u8 = 11;

/// Read a channel pin from `data.pins.<channel>` with the runtime default.
fn channel_pin(node: &FlowNode, channel: &str, default: u8) -> u8 {
    node.data
        .get("pins")
        .and_then(|p| p.get(channel))
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u8::try_from(n).ok())
        .unwrap_or(default)
}

/// True when the LED is common-anode (active-low channels).
fn is_anode(node: &FlowNode) -> bool {
    node.data.get("isAnode").and_then(serde_json::Value::as_bool).unwrap_or(false)
}

/// Emit C++ for an Rgb Node. Unwired channels keep their initial `0`.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let token = node.id_token();
    let anode = is_anode(node);
    // Off level: common-anode is active-low, so "off" is 255.
    let off = if anode { 255 } else { 0 };
    let alpha = format!("rgb_{token}_a");

    let mut e = NodeEmission::default();
    let mut channel_vars: Vec<(String, String)> = Vec::new();
    for (channel, default) in [
        ("red", DEFAULT_RED),
        ("green", DEFAULT_GREEN),
        ("blue", DEFAULT_BLUE),
    ] {
        let pin_var = format!("rgb_{token}_{channel}_pin");
        let level_var = format!("rgb_{token}_{channel}");
        e.declarations
            .push(format!("const uint8_t {pin_var} = {};", channel_pin(node, channel, default)));
        e.declarations.push(format!("uint8_t {level_var} = 0;"));
        e.setup.push(format!("pinMode({pin_var}, OUTPUT);"));
        // Mirror runtime initialize: start off.
        e.setup.push(format!("analogWrite({pin_var}, {off});"));
        channel_vars.push((pin_var, level_var));
    }
    e.declarations.push(format!("double {alpha} = 1.0;"));

    // red / green / blue: per-channel level assignments (as_u8, default 0).
    let mut any_wired = false;
    for (channel, (_, level_var)) in
        ["red", "green", "blue"].iter().zip(&channel_vars)
    {
        let sources = inputs.on(channel);
        if let Some(note) = extra_sources_note(channel, sources) {
            e.declarations.push(note);
        }
        if let Some(source) = sources.first() {
            any_wired = true;
            e.loop_body
                .push(format!("{level_var} = {};", source.value.as_u8_or(0)));
        }
    }

    // alpha: 0..=100 percent → 0..=1 intensity (runtime clamp).
    let alpha_sources = inputs.on("alpha");
    if let Some(note) = extra_sources_note("alpha", alpha_sources) {
        e.declarations.push(note);
    }
    if let Some(source) = alpha_sources.first() {
        any_wired = true;
        let v = source.value.as_double_or("100.0");
        e.loop_body
            .push(format!("{alpha} = constrain({v} / 100.0, 0.0, 1.0);"));
    }

    // off: reset the stored color, like the runtime's default Rgba.
    let binding = bind_pulses(&format!("rgb_{token}_off"), inputs.on("off"));
    e.declarations.extend(binding.declarations.iter().cloned());
    e.loop_body.extend(binding.loop_lines.iter().cloned());
    if let Some(any) = binding.any_fired() {
        any_wired = true;
        let resets: Vec<String> = channel_vars
            .iter()
            .map(|(_, level)| format!("{level} = 0;"))
            .collect();
        e.loop_body
            .push(format!("if ({any}) {{ {} {alpha} = 1.0; }}", resets.join(" ")));
    }

    // Rewrite the hardware from the stored color each tick — the polled twin
    // of the runtime's update_hardware after every dispatch.
    if any_wired {
        for (pin_var, level_var) in &channel_vars {
            let intensity = format!("(uint8_t)((double){level_var} * {alpha})");
            let written = if anode {
                format!("(255 - {intensity})")
            } else {
                intensity
            };
            e.loop_body.push(format!("analogWrite({pin_var}, {written});"));
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

    fn rgb(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Rgb".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn on(port: &str, expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add(port, SourceExpr::level(expr));
        inputs
    }

    #[test]
    fn rgb_sets_three_pwm_pins_and_starts_off() {
        let e = emit(&rgb("rgb-1", json!({})), &NodeInputs::default());
        assert_eq!(e.setup.iter().filter(|s| s.contains("pinMode")).count(), 3);
        assert!(e.declarations.iter().any(|d| d.contains("= 9;")));
        assert!(e.setup.iter().filter(|s| s.contains("analogWrite") && s.contains(", 0)")).count() >= 3);
    }

    #[test]
    fn each_channel_port_drives_its_own_pin() {
        let mut inputs = NodeInputs::default();
        inputs.add("red", SourceExpr::level(CppExpr::number("r_v")));
        inputs.add("blue", SourceExpr::level(CppExpr::number("b_v")));
        let e = emit(&rgb("rgb-1", json!({})), &inputs);
        let body = e.loop_body.join("\n");
        assert!(body.contains("rgb_rgb_1_red = ") && body.contains("r_v"), "red bound: {body}");
        assert!(body.contains("rgb_rgb_1_blue = ") && body.contains("b_v"), "blue bound: {body}");
        assert!(!body.contains("rgb_rgb_1_green = "), "green stays unwired: {body}");
        // All three pins still rewritten from state.
        assert_eq!(body.matches("analogWrite(").count(), 3);
    }

    #[test]
    fn alpha_port_scales_intensity_like_the_runtime() {
        let e = emit(&rgb("rgb-1", json!({})), &on("alpha", CppExpr::number("a_v")));
        let body = e.loop_body.join("\n");
        assert!(body.contains("/ 100.0, 0.0, 1.0"), "percent → intensity clamp: {body}");
        assert!(body.contains("* rgb_rgb_1_a"), "channels scale by alpha: {body}");
    }

    #[test]
    fn off_port_resets_the_stored_color() {
        let e = emit(&rgb("rgb-1", json!({})), &on("off", CppExpr::boolean("kill")));
        let body = e.loop_body.join("\n");
        assert!(body.contains("rgb_rgb_1_red = 0;") && body.contains("rgb_rgb_1_a = 1.0;"), "{body}");
    }

    #[test]
    fn rgb_anode_inverts_levels() {
        let e = emit(&rgb("rgb-1", json!({ "isAnode": true })), &on("red", CppExpr::number("v")));
        assert!(e.loop_body.iter().any(|l| l.contains("255 -")));
        assert!(e.setup.iter().any(|s| s.contains("analogWrite") && s.contains(", 255)")));
    }

    #[test]
    fn rgb_reads_custom_pins() {
        let e = emit(
            &rgb("rgb-1", json!({ "pins": { "red": 3, "green": 5, "blue": 6 } })),
            &NodeInputs::default(),
        );
        assert!(e.declarations.iter().any(|d| d.contains("= 3;")));
        assert!(e.declarations.iter().any(|d| d.contains("= 5;")));
        assert!(e.declarations.iter().any(|d| d.contains("= 6;")));
    }

    #[test]
    fn unwired_rgb_does_no_loop_work() {
        let e = emit(&rgb("rgb-1", json!({})), &NodeInputs::default());
        assert!(e.loop_body.is_empty());
    }

    #[test]
    fn rgb_emits_deterministically() {
        let n = rgb("rgb-1", json!({ "isAnode": true }));
        let inputs = on("red", CppExpr::number("v"));
        assert_eq!(emit(&n, &inputs), emit(&n, &inputs));
    }
}
