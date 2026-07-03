//! Matrix emitter — mirrors `runtime/output/matrix.rs`.
//!
//! The live Matrix drives MAX7219 LED matrices (data/clock/CS pins, chained
//! devices). Its `value` port selects a configured *shape* by index (clamped
//! to the shape list) and displays it; `reset` clears the display; and
//! `reinitialize` re-runs the chip init (wake from shutdown, intensity, clear).
//! Shapes are rows of binary strings, sliced per chained device — the
//! generated sketch parses them at generation time into static row-byte
//! tables, so an index arriving on `value` lights the same pixels on-device.
//! The sketch uses the standard Arduino `LedControl` library, whose
//! `LedControl(dataPin, clkPin, csPin, numDevices)` wraps exactly this MAX7219
//! protocol.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, extra_sources_note, NodeInputs};
use crate::flow::FlowNode;

/// Pin defaults match `runtime/output/matrix.rs` (data=2, clock=3, cs=4).
const DEFAULT_DATA: u8 = 2;
const DEFAULT_CLOCK: u8 = 3;
const DEFAULT_CS: u8 = 4;
/// Device-count default matches `runtime/output/matrix.rs::default_devices` (1).
const DEFAULT_DEVICES: u8 = 1;

fn pin(node: &FlowNode, key: &str, default: u8) -> u8 {
    node.data
        .get("pins")
        .and_then(|p| p.get(key))
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u8::try_from(n).ok())
        .unwrap_or(default)
}

fn devices(node: &FlowNode) -> u8 {
    node.data
        .get("devices")
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u8::try_from(n).ok())
        .unwrap_or(DEFAULT_DEVICES)
        .max(1)
}

/// The configured shapes: rows of binary strings (`"01111110…"`), one row
/// list per shape.
fn shapes(node: &FlowNode) -> Vec<Vec<String>> {
    node.data
        .get("shapes")
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or_default()
}

/// The row byte for `device`/`row` of `shape` — the generation-time twin of
/// the runtime's `display_shape` slicing (bad/short binary parses to 0).
fn row_byte(shape: &[String], device: u8, row: usize) -> u8 {
    let Some(row_str) = shape.get(row) else { return 0 };
    let start = usize::from(device) * 8;
    if start >= row_str.len() {
        return 0;
    }
    let end = (start + 8).min(row_str.len());
    u8::from_str_radix(&row_str[start..end], 2).unwrap_or(0)
}

/// Emit C++ for a Matrix Node. Unwired, the display stays cleared.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let token = node.id_token();
    let obj = format!("matrix_{token}");
    let data = pin(node, "data", DEFAULT_DATA);
    let clock = pin(node, "clock", DEFAULT_CLOCK);
    let cs = pin(node, "cs", DEFAULT_CS);
    let devices = devices(node);
    let i = format!("matrix_{token}_i");
    let row = format!("matrix_{token}_row");

    let init_lines = vec![
        format!("for (int {i} = 0; {i} < {devices}; {i}++) {{"),
        // Mirror init_max7219: wake from shutdown, mid intensity, clear.
        format!("  {obj}.shutdown({i}, false);"),
        format!("  {obj}.setIntensity({i}, 8);"),
        format!("  {obj}.clearDisplay({i});"),
        "}".to_string(),
    ];

    let mut e = NodeEmission {
        includes: vec!["#include <LedControl.h>".to_string()],
        declarations: vec![format!(
            "LedControl {obj}({data}, {clock}, {cs}, {devices});"
        )],
        setup: init_lines.clone(),
        ..NodeEmission::default()
    };

    // value: shape index selection over generation-time row-byte tables.
    let value_sources = inputs.on("value");
    if let Some(note) = extra_sources_note("value", value_sources) {
        e.declarations.push(note);
    }
    if let Some(source) = value_sources.first() {
        let shape_list = shapes(node);
        if shape_list.is_empty() {
            e.declarations.push(
                "// note: 'value' selects a shape, but no shapes are configured — edge has no effect"
                    .to_string(),
            );
        } else {
            let table = format!("matrix_{token}_shapes");
            let count = shape_list.len();
            let width = usize::from(devices) * 8;
            let rows: Vec<String> = shape_list
                .iter()
                .map(|shape| {
                    let bytes: Vec<String> = (0..devices)
                        .flat_map(|d| (0..8).map(move |r| (d, r)))
                        .map(|(d, r)| format!("0x{:02X}", row_byte(shape, d, r)))
                        .collect();
                    format!("  {{{}}}", bytes.join(", "))
                })
                .collect();
            e.declarations
                .push(format!("const uint8_t {table}[{count}][{width}] = {{"));
            e.declarations.push(rows.join(",\n"));
            e.declarations.push("};".to_string());

            let binding = bind_pulses(&format!("matrix_{token}_value"), &value_sources[..1]);
            e.declarations.extend(binding.declarations.iter().cloned());
            e.loop_body.extend(binding.loop_lines.iter().cloned());
            let fired = &binding.fired[0];
            let idx = format!("matrix_{token}_idx");
            let last = count - 1;
            e.loop_body.push(format!("if ({fired}) {{"));
            e.loop_body.push(format!(
                "  uint8_t {idx} = (uint8_t)constrain(round({}), 0.0, {last}.0);",
                source.value.as_double()
            ));
            e.loop_body.push(format!("  for (int {i} = 0; {i} < {devices}; {i}++) {{"));
            e.loop_body.push(format!("    for (int {row} = 0; {row} < 8; {row}++) {{"));
            e.loop_body.push(format!(
                "      {obj}.setRow({i}, {row}, {table}[{idx}][{i} * 8 + {row}]);"
            ));
            e.loop_body.push("    }".to_string());
            e.loop_body.push("  }".to_string());
            e.loop_body.push("}".to_string());
        }
    }

    // reset: clear every device.
    let binding = bind_pulses(&format!("matrix_{token}_reset"), inputs.on("reset"));
    e.declarations.extend(binding.declarations.iter().cloned());
    e.loop_body.extend(binding.loop_lines.iter().cloned());
    if let Some(any) = binding.any_fired() {
        e.loop_body.push(format!(
            "if ({any}) {{ for (int {i} = 0; {i} < {devices}; {i}++) {{ {obj}.clearDisplay({i}); }} }}"
        ));
    }

    // reinitialize: re-run the chip init sequence.
    let binding = bind_pulses(&format!("matrix_{token}_reinit"), inputs.on("reinitialize"));
    e.declarations.extend(binding.declarations.iter().cloned());
    e.loop_body.extend(binding.loop_lines.iter().cloned());
    if let Some(any) = binding.any_fired() {
        e.loop_body.push(format!("if ({any}) {{"));
        e.loop_body.extend(init_lines.iter().map(|l| format!("  {l}")));
        e.loop_body.push("}".to_string());
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
    use crate::flow::Position;
    use serde_json::json;

    fn matrix(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Matrix".to_string()),
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
    fn matrix_includes_library_and_declares_object() {
        let e = emit(&matrix("mx-1", json!({})), &NodeInputs::default());
        assert!(e.includes.iter().any(|i| i.contains("LedControl.h")));
        assert!(e.declarations.iter().any(|d| d.contains("LedControl matrix_mx_1(2, 3, 4, 1)")));
    }

    #[test]
    fn matrix_wakes_and_clears_on_setup() {
        let e = emit(&matrix("mx-1", json!({})), &NodeInputs::default());
        assert!(e.setup.iter().any(|s| s.contains("shutdown") && s.contains("false")));
        assert!(e.setup.iter().any(|s| s.contains("clearDisplay")));
    }

    #[test]
    fn value_port_selects_shapes_from_baked_tables() {
        let shape = vec!["11111111".to_string(); 8];
        let e = emit(
            &matrix("mx-1", json!({ "shapes": [shape, ["10000001"]] })),
            &on("value", CppExpr::number("idx_src")),
        );
        let decls = e.declarations.join("\n");
        assert!(decls.contains("matrix_mx_1_shapes[2][8]"), "{decls}");
        assert!(decls.contains("0xFF"), "full row parsed: {decls}");
        assert!(decls.contains("0x81"), "sparse row parsed: {decls}");
        let body = e.loop_body.join("\n");
        assert!(body.contains("setRow"), "{body}");
        assert!(body.contains("constrain(round("), "index clamp: {body}");
    }

    #[test]
    fn shapes_slice_per_chained_device() {
        // Two devices: the row string carries 16 bits, split 8/8.
        let shape = vec!["1111111100000001".to_string()];
        assert_eq!(row_byte(&shape, 0, 0), 0xFF);
        assert_eq!(row_byte(&shape, 1, 0), 0x01);
        assert_eq!(row_byte(&shape, 0, 3), 0, "missing rows are blank");
    }

    #[test]
    fn value_without_shapes_is_noted() {
        let e = emit(&matrix("mx-1", json!({})), &on("value", CppExpr::number("v")));
        assert!(e.loop_body.is_empty());
        assert!(e.declarations.iter().any(|d| d.contains("no shapes are configured")));
    }

    #[test]
    fn reset_port_clears_every_device() {
        let e = emit(&matrix("mx-1", json!({ "devices": 2 })), &on("reset", CppExpr::boolean("r")));
        assert!(e.loop_body.iter().any(|l| l.contains("clearDisplay")));
    }

    #[test]
    fn reinitialize_port_reruns_chip_init() {
        let e = emit(&matrix("mx-1", json!({})), &on("reinitialize", CppExpr::boolean("r")));
        let body = e.loop_body.join("\n");
        assert!(body.contains("shutdown") && body.contains("setIntensity"), "{body}");
    }

    #[test]
    fn matrix_reads_custom_pins() {
        let e = emit(
            &matrix("mx-1", json!({ "pins": { "data": 7, "clock": 8, "cs": 9 }, "devices": 2 })),
            &NodeInputs::default(),
        );
        assert!(e.declarations.iter().any(|d| d.contains("(7, 8, 9, 2)")));
    }

    #[test]
    fn matrix_emits_deterministically() {
        let n = matrix("mx-1", json!({ "devices": 2, "shapes": [["1"]] }));
        let inputs = on("value", CppExpr::number("v"));
        assert_eq!(emit(&n, &inputs), emit(&n, &inputs));
    }
}
