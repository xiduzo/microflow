//! Matrix emitter — mirrors `nodes/matrix/runtime.rs`.
//!
//! The live Matrix drives MAX7219 LED matrices (data/clock/CS pins, chained
//! devices). Its `value` port selects a configured *shape* by index (clamped
//! to the shape list) and displays it; `reset` clears the display and makes
//! the first shape the current one; and `reinitialize` re-runs the chip init
//! (wake from shutdown, intensity, clear) and shows the current shape again.
//! After setup the first shape is showing, as after the runtime's `initialize`.
//! Shapes are rows of binary strings, sliced per chained device — the
//! generated sketch parses them at generation time into static row-byte
//! tables, so an index arriving on `value` lights the same pixels on-device.
//! The sketch uses the standard Arduino `LedControl` library, whose
//! `LedControl(dataPin, clkPin, csPin, numDevices)` wraps exactly this MAX7219
//! protocol.
//!
//! The Matrix emits on `value` the shape it shows (an `Array` of its rows on
//! the wire) whenever that changes, and the plain number 0 once `reset`
//! clears it — which is also what it holds before `initialize` shows the
//! first shape. The sketch hands on the shape's version (see
//! `CppType::Opaque`): 0 while cleared, and moved on each time a different
//! shape — by its rows, as the runtime compares them — is shown. A Matrix with
//! no shapes holds 0 for good.

use super::config::MatrixConfig;
use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{extra_sources_note, CppExpr, NodeInputs, SourceExpr};
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;

/// The version of the shape shown: 0 while cleared, never 0 otherwise.
fn version_var(node: &FlowNode) -> String {
    format!("matrix_{}_version", node.id_token())
}

/// What the Matrix emits on `value`: the plain number 0 with no shapes,
/// otherwise the shown shape by version, starting cleared (the runtime twin
/// holds 0 until `initialize` shows the first shape, which it emits). `None`
/// when its settings cannot be read (the sketch is refused then).
#[must_use]
pub(crate) fn output(node: &FlowNode) -> Option<SourceExpr> {
    let config = resolve::<MatrixConfig>(&node.data).ok()?;
    Some(if config.shapes.is_empty() {
        SourceExpr::level(CppExpr::number("0.0"))
    } else {
        SourceExpr::level(CppExpr::opaque(version_var(node)))
    })
}

/// For each shape, the index of the first shape with the same rows: two
/// indexes show the same value exactly when these agree.
fn first_alike(shapes: &[Vec<String>]) -> Vec<usize> {
    shapes
        .iter()
        .map(|shape| shapes.iter().position(|other| other == shape).unwrap_or(0))
        .collect()
}

/// The data/clock/cs pins as `(label, pin)` — the same resolution `emit`
/// uses, exposed so validation can never drift from emission.
pub(crate) fn pins(node: &FlowNode) -> Result<[(&'static str, u8); 3], UnreadableConfig> {
    let pins = resolve::<MatrixConfig>(&node.data)?.pins;
    Ok([("data", pins.data), ("clock", pins.clock), ("cs", pins.cs)])
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

/// Emit C++ for a Matrix Node. Unwired, it shows the first shape, if any.
pub(crate) fn emit(node: &FlowNode, inputs: &NodeInputs) -> Result<NodeEmission, UnreadableConfig> {
    let token = node.id_token();
    let obj = format!("matrix_{token}");
    let config = resolve::<MatrixConfig>(&node.data)?;
    let (data, clock, cs) = (config.pins.data, config.pins.clock, config.pins.cs);
    // `LedControl` needs at least one device.
    let devices = config.devices.max(1);
    let i = format!("matrix_{token}_i");
    let row = format!("matrix_{token}_row");

    let init_lines = vec![
        format!("for (int {i} = 0; {i} < {devices}; {i}++) {{"),
        // Mirror init_max7219: wake from shutdown, the shared intensity, clear.
        format!("  {obj}.shutdown({i}, false);"),
        format!("  {obj}.setIntensity({i}, {});", MatrixConfig::INTENSITY),
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

    // The shapes as generation-time row-byte tables, and which one is showing
    // (the runtime's `current_shape_index`): the first after setup, as live;
    // `value` selects one, `reset` goes back to the first, and `reinitialize`
    // shows the current one again.
    let value_sources = inputs.on("value");
    if let Some(note) = extra_sources_note("value", value_sources) {
        e.declarations.push(note);
    }
    let shape_list = &config.shapes;
    let table = format!("matrix_{token}_shapes");
    let shown = format!("matrix_{token}_shape");
    let version = version_var(node);
    let draws = !shape_list.is_empty();
    // Write the current shape to every device.
    let draw_lines = [
        format!("for (int {i} = 0; {i} < {devices}; {i}++) {{"),
        format!("  for (int {row} = 0; {row} < 8; {row}++) {{"),
        format!("    {obj}.setRow({i}, {row}, {table}[{shown}][{i} * 8 + {row}]);"),
        "  }".to_string(),
        "}".to_string(),
    ];
    if draws {
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
        e.declarations.push(format!("uint8_t {shown} = 0;"));
        e.declarations.push(format!("uint8_t {version} = 0;"));
        e.setup.extend(draw_lines.iter().cloned());
        // The first shape is showing: the runtime's `initialize` emits it.
        e.setup.push(format!("{version} = 1;"));
    }

    // value: select a shape by index (rounded, clamped to the list) and show it.
    if let Some(source) = value_sources.first() {
        if shape_list.is_empty() {
            e.declarations.push(
                "// note: 'value' selects a shape, but no shapes are configured — edge has no effect"
                    .to_string(),
            );
        } else {
            let binding = e.bind_port(&format!("matrix_{token}_value"), &value_sources[..1]);
            let fired = &binding.fired[0];
            let last = shape_list.len() - 1;
            let next = format!("matrix_{token}_next");
            // Shapes with the same rows are the same value; compare them by
            // the first index holding those rows (a table only when two do).
            let alike = first_alike(shape_list);
            let differs = if alike.iter().enumerate().all(|(i, first)| i == *first) {
                format!("{next} != {shown}")
            } else {
                let same = format!("matrix_{token}_alike");
                let entries: Vec<String> = alike.iter().map(ToString::to_string).collect();
                e.declarations.push(format!(
                    "const uint8_t {same}[{}] = {{{}}};",
                    alike.len(),
                    entries.join(", ")
                ));
                format!("{same}[{next}] != {same}[{shown}]")
            };
            e.loop_body.push(format!("if ({fired}) {{"));
            e.loop_body.push(format!(
                "  const uint8_t {next} = (uint8_t)constrain(round({}), 0.0, {last}.0);",
                source.value.as_double()
            ));
            e.loop_body.push(format!(
                "  if ({version} == 0 || {differs}) {{ {version} = ({version} == 255) ? 1 : {version} + 1; }}"
            ));
            e.loop_body.push(format!("  {shown} = {next};"));
            e.loop_body.extend(draw_lines.iter().map(|l| format!("  {l}")));
            e.loop_body.push("}".to_string());
        }
    }

    // reset: clear every device; the current shape is the first one again.
    let binding = e.bind_port(&format!("matrix_{token}_reset"), inputs.on("reset"));
    if let Some(any) = binding.any_fired() {
        // Cleared, the runtime twin holds the plain number 0 again.
        let first = if draws { format!(" {shown} = 0; {version} = 0;") } else { String::new() };
        e.loop_body.push(format!(
            "if ({any}) {{ for (int {i} = 0; {i} < {devices}; {i}++) {{ {obj}.clearDisplay({i}); }}{first} }}"
        ));
    }

    // reinitialize: re-run the chip init sequence, then show the current
    // shape again.
    let binding = e.bind_port(&format!("matrix_{token}_reinit"), inputs.on("reinitialize"));
    if let Some(any) = binding.any_fired() {
        e.loop_body.push(format!("if ({any}) {{"));
        e.loop_body.extend(init_lines.iter().map(|l| format!("  {l}")));
        if draws {
            e.loop_body.extend(draw_lines.iter().map(|l| format!("  {l}")));
        }
        e.loop_body.push("}".to_string());
    }
    Ok(e)
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
        let e = emit(&matrix("mx-1", json!({})), &NodeInputs::default()).unwrap();
        assert!(e.includes.iter().any(|i| i.contains("LedControl.h")));
        assert!(e.declarations.iter().any(|d| d.contains("LedControl matrix_mx_1(2, 3, 4, 1)")));
    }

    #[test]
    fn matrix_wakes_and_clears_on_setup() {
        let e = emit(&matrix("mx-1", json!({})), &NodeInputs::default()).unwrap();
        assert!(e.setup.iter().any(|s| s.contains("shutdown") && s.contains("false")));
        assert!(e.setup.iter().any(|s| s.contains("clearDisplay")));
    }

    /// Live, `initialize` shows the first shape; so does the sketch's setup,
    /// wired or not, after the chip init.
    #[test]
    fn setup_shows_the_first_shape() {
        let e = emit(&matrix("mx-1", json!({ "shapes": [["10000001"], ["11111111"]] })), &NodeInputs::default())
            .unwrap();
        let setup = e.setup.join("\n");
        let shown = &setup[setup.find("clearDisplay").expect("the chip init")..];
        assert!(shown.contains("matrix_mx_1_shapes[matrix_mx_1_shape]"), "{setup}");
        assert!(e.declarations.iter().any(|d| d == "uint8_t matrix_mx_1_shape = 0;"), "{:?}", e.declarations);

        let blank = emit(&matrix("mx-1", json!({})), &NodeInputs::default()).unwrap();
        assert!(!blank.setup.join("\n").contains("setRow"), "no shapes, nothing to show");
    }

    #[test]
    fn value_port_selects_shapes_from_baked_tables() {
        let shape = vec!["11111111".to_string(); 8];
        let e = emit(
            &matrix("mx-1", json!({ "shapes": [shape, ["10000001"]] })),
            &on("value", CppExpr::number("idx_src")),
        ).unwrap();
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
        let e = emit(&matrix("mx-1", json!({})), &on("value", CppExpr::number("v"))).unwrap();
        assert!(e.loop_body.is_empty(), "{:?}", e.loop_body);
        assert!(e.declarations.iter().any(|d| d.contains("no shapes are configured")));
    }

    #[test]
    fn reset_port_clears_every_device() {
        let e = emit(&matrix("mx-1", json!({ "devices": 2 })), &on("reset", CppExpr::boolean("r"))).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("clearDisplay")));
    }

    #[test]
    fn reinitialize_port_reruns_chip_init() {
        let e = emit(&matrix("mx-1", json!({})), &on("reinitialize", CppExpr::boolean("r"))).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains("shutdown") && body.contains("setIntensity"), "{body}");
        assert!(!body.contains("setRow"), "no shapes, nothing to show again: {body}");
    }

    /// Live, `reinitialize` shows the current shape again after the chip is
    /// set up: the shape `value` last selected, or the first one after `reset`.
    #[test]
    fn reinitialize_shows_the_current_shape_again() {
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::level(CppExpr::number("idx_src")));
        inputs.add("reset", SourceExpr::level(CppExpr::boolean("clear")));
        inputs.add("reinitialize", SourceExpr::level(CppExpr::boolean("again")));
        let e = emit(&matrix("mx-1", json!({ "shapes": [["10000001"], ["11111111"]] })), &inputs).unwrap();

        assert!(e.declarations.iter().any(|d| d == "uint8_t matrix_mx_1_shape = 0;"), "{:?}", e.declarations);
        let body = e.loop_body.join("\n");
        assert!(body.contains("matrix_mx_1_next = (uint8_t)constrain(round("), "value selects it: {body}");
        assert!(body.contains("matrix_mx_1_shape = matrix_mx_1_next;"), "value selects it: {body}");
        assert!(body.contains("matrix_mx_1_shape = 0;"), "reset goes back to the first: {body}");
        // Drawn by `value`, and again by `reinitialize` after the chip init.
        let draw = "matrix_mx_1.setRow(matrix_mx_1_i, matrix_mx_1_row, matrix_mx_1_shapes[matrix_mx_1_shape]";
        assert_eq!(body.matches(draw).count(), 2, "{body}");
        let reinit = &body[body.find("setIntensity").expect("the chip init")..];
        assert!(reinit.contains(draw), "the shape is shown after the init: {reinit}");
    }

    /// With `reinitialize` alone, the shape to show again is the first one.
    #[test]
    fn reinitialize_alone_shows_the_first_shape() {
        let e = emit(
            &matrix("mx-1", json!({ "shapes": [["10000001"]] })),
            &on("reinitialize", CppExpr::boolean("again")),
        ).unwrap();
        assert!(e.declarations.join("\n").contains("matrix_mx_1_shapes[1][8]"));
        assert!(e.loop_body.join("\n").contains("matrix_mx_1_shapes[matrix_mx_1_shape]"));
    }

    #[test]
    fn matrix_reads_custom_pins() {
        let e = emit(
            &matrix("mx-1", json!({ "pins": { "data": 7, "clock": 8, "cs": 9 }, "devices": 2 })),
            &NodeInputs::default(),
        ).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("(7, 8, 9, 2)")));
    }

    #[test]
    fn matrix_emits_deterministically() {
        let n = matrix("mx-1", json!({ "devices": 2, "shapes": [["1"]] }));
        let inputs = on("value", CppExpr::number("v"));
        assert_eq!(emit(&n, &inputs).unwrap(), emit(&n, &inputs).unwrap());
    }
}
