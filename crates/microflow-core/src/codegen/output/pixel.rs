//! Pixel emitter — mirrors `runtime/output/pixel.rs`.
//!
//! The live Pixel drives an addressable `NeoPixel` strip (WS2812-style). Its
//! `value` port selects a configured *preset* by index (clamped to the preset
//! list) and applies that preset's per-pixel hex colors; `reset` clears the
//! strip. The generated sketch uses the Adafruit `NeoPixel` library and bakes
//! the presets into static color tables (hex parsed at generation time with
//! the runtime's exact `parse_hex_color` semantics), so an index arriving on
//! `value` applies the same colors on-device. Presets shorter than the strip
//! write only their own pixels, like the runtime's `take(length)`.
//!
//! The `color` (direct hex/array payload) and `set` (single-pixel) ports carry
//! string/object payloads with no on-device value model yet; wiring them emits
//! an explicit note instead of wrong code.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, extra_sources_note, NodeInputs};
use crate::config::pixel::PixelConfig;
use crate::flow::FlowNode;

/// Map the configured colour-order string to the `NeoPixel` type flag.
fn neo_color_flag(color_order: &str) -> &'static str {
    match color_order.to_ascii_uppercase().as_str() {
        "RGB" => "NEO_RGB + NEO_KHZ800",
        "BRG" => "NEO_BRG + NEO_KHZ800",
        // GRB is the WS2812 default and the runtime default.
        _ => "NEO_GRB + NEO_KHZ800",
    }
}

/// Parse a `#rgb` / `#rrggbb` hex color to `0x00RRGGBB` — a transcription of
/// the runtime's `parse_hex_color` (bad input parses to 0/black).
fn parse_hex_color(hex: &str) -> u32 {
    let hex = hex.trim_start_matches('#');
    match hex.len() {
        3 => {
            let r = u8::from_str_radix(&hex[0..1], 16).unwrap_or(0);
            let g = u8::from_str_radix(&hex[1..2], 16).unwrap_or(0);
            let b = u8::from_str_radix(&hex[2..3], 16).unwrap_or(0);
            // Expand 4-bit to 8-bit: 0xA -> 0xAA
            u32::from(r | (r << 4)) << 16 | u32::from(g | (g << 4)) << 8 | u32::from(b | (b << 4))
        }
        6 => u32::from_str_radix(hex, 16).unwrap_or(0),
        _ => 0,
    }
}

/// Emit C++ for a Pixel Node. Unwired, the strip stays cleared.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let token = node.id_token();
    let obj = format!("pixel_{token}");
    let config: PixelConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    let pin = config.pin;
    let length = config.length.max(1);
    let flag = neo_color_flag(&config.color_order);
    let i = format!("pixel_{token}_i");

    let mut e = NodeEmission {
        includes: vec!["#include <Adafruit_NeoPixel.h>".to_string()],
        declarations: vec![format!(
            "Adafruit_NeoPixel {obj}({length}, {pin}, {flag});"
        )],
        setup: vec![
            format!("{obj}.begin();"),
            // Mirror runtime initialize: cleared.
            format!("{obj}.clear();"),
            format!("{obj}.show();"),
        ],
        ..NodeEmission::default()
    };

    // value: preset index selection over generation-time color tables.
    let value_sources = inputs.on("value");
    if let Some(note) = extra_sources_note("value", value_sources) {
        e.declarations.push(note);
    }
    if let Some(source) = value_sources.first() {
        if config.presets.is_empty() {
            e.declarations.push(
                "// note: 'value' selects a preset, but no presets are configured — edge has no effect"
                    .to_string(),
            );
        } else {
            let presets = format!("pixel_{token}_presets");
            let lengths = format!("pixel_{token}_preset_len");
            let count = config.presets.len();
            let width = config
                .presets
                .iter()
                .map(|p| p.len().min(length as usize))
                .max()
                .unwrap_or(0)
                .max(1);
            let rows: Vec<String> = config
                .presets
                .iter()
                .map(|preset| {
                    let mut colors: Vec<String> = preset
                        .iter()
                        .take(width)
                        .map(|hex| format!("0x{:06X}", parse_hex_color(hex)))
                        .collect();
                    colors.resize(width, "0x000000".to_string());
                    format!("  {{{}}}", colors.join(", "))
                })
                .collect();
            e.declarations
                .push(format!("const uint32_t {presets}[{count}][{width}] = {{"));
            e.declarations.push(rows.join(",\n"));
            e.declarations.push("};".to_string());
            let lens: Vec<String> = config
                .presets
                .iter()
                .map(|p| p.len().min(length as usize).to_string())
                .collect();
            e.declarations
                .push(format!("const uint16_t {lengths}[{count}] = {{{}}};", lens.join(", ")));

            // Apply on every new index sample (change pulse), clamped like the
            // runtime's `index.min(len - 1)`.
            let binding = bind_pulses(&format!("pixel_{token}_value"), &value_sources[..1]);
            e.declarations.extend(binding.declarations.iter().cloned());
            e.loop_body.extend(binding.loop_lines.iter().cloned());
            let fired = &binding.fired[0];
            let idx = format!("pixel_{token}_idx");
            let last = count - 1;
            e.loop_body.push(format!("if ({fired}) {{"));
            e.loop_body.push(format!(
                "  uint16_t {idx} = (uint16_t)constrain(round({}), 0.0, {last}.0);",
                source.value.as_double()
            ));
            e.loop_body.push(format!(
                "  for (uint16_t {i} = 0; {i} < {lengths}[{idx}]; {i}++) {{ {obj}.setPixelColor({i}, {presets}[{idx}][{i}]); }}"
            ));
            e.loop_body.push(format!("  {obj}.show();"));
            e.loop_body.push("}".to_string());
        }
    }

    // reset: clear the strip.
    let binding = bind_pulses(&format!("pixel_{token}_reset"), inputs.on("reset"));
    e.declarations.extend(binding.declarations.iter().cloned());
    e.loop_body.extend(binding.loop_lines.iter().cloned());
    if let Some(any) = binding.any_fired() {
        e.loop_body
            .push(format!("if ({any}) {{ {obj}.clear(); {obj}.show(); }}"));
    }

    // color / set: payload shapes (hex strings, per-pixel objects) with no
    // on-device value model — note instead of guessing.
    for port in ["color", "set"] {
        if !inputs.on(port).is_empty() {
            e.declarations.push(format!(
                "// note: input '{port}' carries payloads codegen cannot express on-device — edge ignored"
            ));
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

    fn pixel(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Pixel".to_string()),
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
    fn pixel_includes_library_and_declares_strip() {
        let e = emit(&pixel("px-1", json!({ "pin": 6, "length": 16 })), &NodeInputs::default());
        assert!(e.includes.iter().any(|i| i.contains("Adafruit_NeoPixel.h")));
        assert!(e.declarations.iter().any(|d| d.contains("Adafruit_NeoPixel pixel_px_1(16, 6")));
    }

    #[test]
    fn pixel_begins_and_clears_on_setup() {
        let e = emit(&pixel("px-1", json!({})), &NodeInputs::default());
        assert!(e.setup.iter().any(|s| s.contains(".begin()")));
        assert!(e.setup.iter().any(|s| s.contains(".clear()")));
    }

    #[test]
    fn value_port_selects_presets_from_baked_tables() {
        let e = emit(
            &pixel(
                "px-1",
                json!({ "length": 4, "presets": [["#ff0000", "#00ff00"], ["#0000ff"]] }),
            ),
            &on("value", CppExpr::number("idx_src")),
        );
        let decls = e.declarations.join("\n");
        assert!(decls.contains("0xFF0000") && decls.contains("0x00FF00") && decls.contains("0x0000FF"), "{decls}");
        assert!(decls.contains("pixel_px_1_preset_len[2] = {2, 1}"), "per-preset lengths: {decls}");
        let body = e.loop_body.join("\n");
        assert!(body.contains("setPixelColor"), "{body}");
        assert!(body.contains("constrain(round(") && body.contains("1.0)"), "index clamp: {body}");
        assert!(body.contains(".show()"), "{body}");
    }

    #[test]
    fn short_hex_colors_expand_like_the_runtime() {
        assert_eq!(parse_hex_color("#fff"), 0x00FF_FFFF);
        assert_eq!(parse_hex_color("#a2c"), 0x00AA_22CC);
        assert_eq!(parse_hex_color("123456"), 0x0012_3456);
        assert_eq!(parse_hex_color("zzz"), 0);
    }

    #[test]
    fn value_without_presets_is_noted() {
        let e = emit(&pixel("px-1", json!({})), &on("value", CppExpr::number("v")));
        assert!(e.loop_body.is_empty());
        assert!(e.declarations.iter().any(|d| d.contains("no presets are configured")));
    }

    #[test]
    fn reset_port_clears_the_strip() {
        let e = emit(&pixel("px-1", json!({})), &on("reset", CppExpr::boolean("r")));
        assert!(e.loop_body.iter().any(|l| l.contains(".clear(); pixel_px_1.show();")));
    }

    #[test]
    fn color_and_set_ports_are_noted() {
        let mut inputs = NodeInputs::default();
        inputs.add("color", SourceExpr::level(CppExpr::text("hex")));
        inputs.add("set", SourceExpr::level(CppExpr::number("v")));
        let e = emit(&pixel("px-1", json!({})), &inputs);
        assert_eq!(
            e.declarations.iter().filter(|d| d.contains("edge ignored")).count(),
            2
        );
    }

    #[test]
    fn pixel_honours_color_order() {
        let e = emit(&pixel("px-1", json!({ "color_order": "RGB" })), &NodeInputs::default());
        assert!(e.declarations.iter().any(|d| d.contains("NEO_RGB")));
    }

    #[test]
    fn pixel_emits_deterministically() {
        let n = pixel("px-1", json!({ "length": 12, "presets": [["#fff"]] }));
        let inputs = on("value", CppExpr::number("v"));
        assert_eq!(emit(&n, &inputs), emit(&n, &inputs));
    }
}
