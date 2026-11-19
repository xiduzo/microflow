//! Rgb emitter — mirrors `nodes/rgb/runtime.rs`.
//!
//! The live RGB LED drives three PWM pins (red/green/blue) from a stored
//! `Rgba` color and exposes five ports: `red` / `green` / `blue` set one
//! channel each (`0..=255`), `alpha` scales all channels (a `0..=100` percent
//! mapped to `0..=1` intensity), and `off` resets the color. Every update
//! recomputes the hardware writes as `channel * alpha`, inverted (`255 - v`)
//! for a common-anode (`isAnode`) LED.
//!
//! The generated sketch keeps the color as module-level state, stores each
//! wired channel and `alpha` in it, binds `off` as a pulse that resets it, and
//! rewrites all three pins each loop from the same intensity/anode math — so
//! a single sensor can drive one channel while a constant holds another,
//! exactly like the live Node. With `off` wired, a stored value is written
//! when its source fires, so that `off` holds until the next value arrives,
//! as it does live; without `off` it tracks the level of its source.
//!
//! The Rgb emits its colour on `value` (an `Rgba` on the wire) each time the
//! colour changes. A board has no use for the colour itself downstream — it is
//! no number and no text — so the sketch hands on its version (see
//! `CppType::Opaque`): one byte that moves on whenever a tick leaves the
//! stored colour different from how the tick found it.

use super::config::RgbConfig;
use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{extra_sources_note, CppExpr, NodeInputs, SourceExpr};
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;

/// The version of the stored colour: 1 at the start, never 0.
fn version_var(node: &FlowNode) -> String {
    format!("rgb_{}_version", node.id_token())
}

/// What the Rgb emits on `value`: its colour, by version. The colour it starts
/// with (black, full alpha) is version 1, so a consumer's tracker starts there
/// and an Rgb that has not changed does not fire.
#[must_use]
pub(crate) fn output(node: &FlowNode) -> SourceExpr {
    SourceExpr::level(CppExpr::opaque(version_var(node))).starting_at("1")
}

/// The three channel pins as `(label, pin)` — the same resolution `emit`
/// uses, exposed so validation can never drift from emission.
pub(crate) fn pins(node: &FlowNode) -> Result<[(&'static str, u8); 3], UnreadableConfig> {
    Ok(channel_pins(&resolve::<RgbConfig>(&node.data)?))
}

fn channel_pins(config: &RgbConfig) -> [(&'static str, u8); 3] {
    let pins = &config.pins;
    [("red", pins.red), ("green", pins.green), ("blue", pins.blue)]
}

/// Emit C++ for an Rgb Node. Unwired channels keep their initial `0`.
pub(crate) fn emit(node: &FlowNode, inputs: &NodeInputs) -> Result<NodeEmission, UnreadableConfig> {
    let config = resolve::<RgbConfig>(&node.data)?;
    let token = node.id_token();
    // Common-anode channels are active-low.
    let anode = config.is_anode;
    // Off level: common-anode is active-low, so "off" is 255.
    let off = if anode { 255 } else { 0 };
    let alpha = format!("rgb_{token}_a");

    let mut e = NodeEmission::default();
    let mut channel_vars: Vec<(String, String)> = Vec::new();
    for (channel, pin) in channel_pins(&config) {
        let pin_var = format!("rgb_{token}_{channel}_pin");
        let level_var = format!("rgb_{token}_{channel}");
        e.declarations
            .push(format!("const uint8_t {pin_var} = {pin};"));
        e.declarations.push(format!("uint8_t {level_var} = 0;"));
        e.setup.push(format!("pinMode({pin_var}, OUTPUT);"));
        // Mirror runtime initialize: start off.
        e.setup.push(format!("analogWrite({pin_var}, {off});"));
        channel_vars.push((pin_var, level_var));
    }
    e.declarations.push(format!("double {alpha} = 1.0;"));
    let version = version_var(node);
    e.declarations.push(format!("uint8_t {version} = 1;"));
    // The colour as this tick found it, to tell whether the tick changed it.
    let before: Vec<String> = channel_vars
        .iter()
        .map(|(_, level)| format!("const uint8_t {level}_was = {level};"))
        .chain([format!("const double {alpha}_was = {alpha};")])
        .collect();

    // Live, `off` holds until a channel is next sent a value. So with `off`
    // wired, a stored value is written when its source fires — one write per
    // value the runtime would dispatch — and not on every tick, which would
    // undo `off` one tick later. Without `off` nothing resets the colour, and
    // a stored value simply tracks the level of its source.
    let off_wired = !inputs.on("off").is_empty();
    let store = |e: &mut NodeEmission, port: &str, sources: &[SourceExpr], assignment: String| {
        if off_wired {
            let binding = e.bind_port(&format!("rgb_{token}_{port}_in"), &sources[..1]);
            e.loop_body.push(format!("if ({}) {{ {assignment} }}", binding.fired[0]));
        } else {
            e.loop_body.push(assignment);
        }
    };

    // red / green / blue: one stored level per channel (as_u8, default 0).
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
            store(&mut e, channel, sources, format!("{level_var} = {};", source.value.as_u8_or(0)));
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
        store(&mut e, "alpha", alpha_sources, format!("{alpha} = constrain({v} / 100.0, 0.0, 1.0);"));
    }

    // off: reset the stored color, like the runtime's default Rgba.
    let binding = e.bind_port(&format!("rgb_{token}_off"), inputs.on("off"));
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
        // The value moves on when the tick changed the colour, as the
        // runtime's `set_value` emits only a different colour.
        let changed: Vec<String> = channel_vars
            .iter()
            .map(|(_, level)| format!("{level} != {level}_was"))
            .chain([format!("{alpha} != {alpha}_was")])
            .collect();
        e.loop_body.splice(0..0, before);
        e.loop_body.push(format!(
            "if ({}) {{ {version} = ({version} == 255) ? 1 : {version} + 1; }}",
            changed.join(" || ")
        ));
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
    Ok(e)
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
        let e = emit(&rgb("rgb-1", json!({})), &NodeInputs::default()).unwrap();
        assert_eq!(e.setup.iter().filter(|s| s.contains("pinMode")).count(), 3);
        assert!(e.declarations.iter().any(|d| d.contains("= 9;")));
        assert!(e.setup.iter().filter(|s| s.contains("analogWrite") && s.contains(", 0)")).count() >= 3);
    }

    #[test]
    fn each_channel_port_drives_its_own_pin() {
        let mut inputs = NodeInputs::default();
        inputs.add("red", SourceExpr::level(CppExpr::number("r_v")));
        inputs.add("blue", SourceExpr::level(CppExpr::number("b_v")));
        let e = emit(&rgb("rgb-1", json!({})), &inputs).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains("rgb_rgb_1_red = ") && body.contains("r_v"), "red bound: {body}");
        assert!(body.contains("rgb_rgb_1_blue = ") && body.contains("b_v"), "blue bound: {body}");
        assert!(!body.contains("rgb_rgb_1_green = "), "green stays unwired: {body}");
        // All three pins still rewritten from state.
        assert_eq!(body.matches("analogWrite(").count(), 3);
    }

    #[test]
    fn alpha_port_scales_intensity_like_the_runtime() {
        let e = emit(&rgb("rgb-1", json!({})), &on("alpha", CppExpr::number("a_v"))).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains("/ 100.0, 0.0, 1.0"), "percent → intensity clamp: {body}");
        assert!(body.contains("* rgb_rgb_1_a"), "channels scale by alpha: {body}");
    }

    #[test]
    fn off_port_resets_the_stored_color() {
        let e = emit(&rgb("rgb-1", json!({})), &on("off", CppExpr::boolean("kill"))).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains("rgb_rgb_1_red = 0;") && body.contains("rgb_rgb_1_a = 1.0;"), "{body}");
    }

    /// Live, `off` holds until a channel is next sent a value. So with `off`
    /// wired the sketch writes a channel only when its source changes; a
    /// write on every tick would light the LED again one tick after `off`.
    #[test]
    fn off_holds_until_a_channel_next_changes() {
        let mut inputs = NodeInputs::default();
        inputs.add("red", SourceExpr::level(CppExpr::number("r_v")));
        inputs.add("alpha", SourceExpr::level(CppExpr::number("a_v")));
        inputs.add("off", SourceExpr::level(CppExpr::boolean("kill")));
        let e = emit(&rgb("rgb-1", json!({})), &inputs).unwrap();
        let writes = |var: &str| -> Vec<&String> {
            e.loop_body.iter().filter(|line| line.contains(&format!("{var} = "))).collect()
        };

        // Each stored value is written twice: on its source's change, and by `off`.
        for var in ["rgb_rgb_1_red", "rgb_rgb_1_a"] {
            let writes = writes(var);
            assert_eq!(writes.len(), 2, "{var}: {:?}", e.loop_body);
            assert!(writes[0].starts_with("if (") && writes[0].contains("_fired0)"), "{}", writes[0]);
            assert!(writes[1].starts_with("if (") && writes[1].contains("off"), "{}", writes[1]);
        }
        // The pins are still rewritten from the stored colour each tick.
        assert_eq!(e.loop_body.iter().filter(|line| line.starts_with("analogWrite(")).count(), 3);
    }

    /// Without `off` nothing can reset the colour, so a channel tracks its
    /// source's level: a source that starts at 0 and one that sends 0 at boot
    /// mean the same.
    #[test]
    fn without_off_a_channel_tracks_the_level_of_its_source() {
        let mut inputs = NodeInputs::default();
        inputs.add("red", SourceExpr::level(CppExpr::number("r_v")));
        inputs.add("alpha", SourceExpr::level(CppExpr::number("a_v")));
        let e = emit(&rgb("rgb-1", json!({})), &inputs).unwrap();
        assert!(e.loop_body.iter().any(|line| line.starts_with("rgb_rgb_1_red = ")), "{:?}", e.loop_body);
        assert!(e.loop_body.iter().any(|line| line.starts_with("rgb_rgb_1_a = ")), "{:?}", e.loop_body);
    }

    #[test]
    fn rgb_anode_inverts_levels() {
        let e = emit(&rgb("rgb-1", json!({ "isAnode": true })), &on("red", CppExpr::number("v"))).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("255 -")));
        assert!(e.setup.iter().any(|s| s.contains("analogWrite") && s.contains(", 255)")));
    }

    #[test]
    fn rgb_reads_custom_pins() {
        let e = emit(
            &rgb("rgb-1", json!({ "pins": { "red": 3, "green": 5, "blue": 6 } })),
            &NodeInputs::default(),
        ).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("= 3;")));
        assert!(e.declarations.iter().any(|d| d.contains("= 5;")));
        assert!(e.declarations.iter().any(|d| d.contains("= 6;")));
    }

    #[test]
    fn unwired_rgb_does_no_loop_work() {
        let e = emit(&rgb("rgb-1", json!({})), &NodeInputs::default()).unwrap();
        assert!(e.loop_body.is_empty(), "{:?}", e.loop_body);
    }

    #[test]
    fn rgb_emits_deterministically() {
        let n = rgb("rgb-1", json!({ "isAnode": true }));
        let inputs = on("red", CppExpr::number("v"));
        assert_eq!(emit(&n, &inputs).unwrap(), emit(&n, &inputs).unwrap());
    }
}
