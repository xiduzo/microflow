//! `RangeMap` emitter — mirrors `nodes/range_map/runtime.rs`.
//!
//! The live `RangeMap` Node linearly remaps its input from a `from` range to a
//! `to` range:
//!
//! ```text
//! mapped = (input - from.min) * (to.max - to.min) / (from.max - from.min) + to.min
//! ```
//!
//! then rounds `mapped` to a precision that depends on the output span: one
//! decimal place when `|to.max - to.min| <= 10`, otherwise to the nearest whole
//! number. It emits the normalized result as its `to` value. The runtime does
//! not clamp — inputs at or beyond the `from` bounds extrapolate linearly — so
//! the generated C++ mirrors that exact behavior (including the edge values).
//!
//! We emit the same arithmetic into a `double` variable downstream Nodes read.
//! The runtime maps each value that arrives and emits the result on `to`
//! every time, even when it is the number it emitted last; so the sketch maps
//! on the ticks its source fires and `to` is an event that fires on each.
//!
//! The runtime's own `value` is the pair `[input, mapped]`, emitted when it
//! changes. A pair has no number and no text, so on-device it is a
//! [`CppType::Opaque`](crate::codegen::wire::CppType::Opaque) version that
//! moves on when the input or the mapped number does.

use super::config::RangeMapConfig;
use crate::codegen::emit::{cpp_double, NodeEmission, NodeToken};
use crate::codegen::wire::{extra_sources_note, CppExpr, NodeInputs, SourceExpr};
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;

/// The C++ `double` variable holding this `RangeMap` Node's mapped output.
#[must_use]
pub(crate) fn value_var(node: &FlowNode) -> String {
    format!("range_map_{}_value", node.id_token())
}

/// True on the ticks a value arrived and was mapped (the flag
/// [`NodeEmission::transform`] declares).
fn mapped_var(node: &FlowNode) -> String {
    format!("{}_fired", prefix(node))
}

fn prefix(node: &FlowNode) -> String {
    format!("range_map_{}", node.id_token())
}

/// The version of the `[input, mapped]` pair (see the module docs).
fn pair_var(node: &FlowNode) -> String {
    format!("range_map_{}_pair", node.id_token())
}

/// What the `RangeMap` emits on `handle`: the mapped number on `to` each time
/// a value is mapped, and on `value` the version of its pair, which starts at
/// the runtime's `[0, 0]`.
#[must_use]
pub(crate) fn output(node: &FlowNode, handle: &str) -> Option<SourceExpr> {
    match handle {
        "to" => Some(SourceExpr::event(CppExpr::number(value_var(node)), mapped_var(node))),
        "value" => Some(SourceExpr::level(CppExpr::opaque(pair_var(node))).starting_at("1")),
        _ => None,
    }
}

/// Emit C++ for a `RangeMap` Node from its `value` port. With nothing
/// connected the value stays at `0.0` (the runtime never maps without a
/// signal). `RangeMap` does not aggregate: extra sources are noted and the
/// first drives the map. String sources are parsed like the runtime's
/// `String(s) => s.parse().unwrap_or(0.0)` arm.
pub(crate) fn emit(node: &FlowNode, inputs: &NodeInputs) -> Result<NodeEmission, UnreadableConfig> {
    let var = value_var(node);
    // Mirror `Range` defaults: from 0..1023, to 0..1023.
    let config = resolve::<RangeMapConfig>(&node.data)?;
    let in_min = cpp_double(config.from.min);
    let in_max = cpp_double(config.from.max);
    let out_min = cpp_double(config.to.min);
    let out_max = cpp_double(config.to.max);

    // Precision factor: one decimal place when the output span is small, else
    // whole numbers — matching the runtime's `distance <= 10.0` rule.
    let distance = (config.to.max - config.to.min).abs();
    let factor = if distance <= 10.0 { "10.0" } else { "1.0" };

    let token = node.id_token();
    let (pair, input_var, next) =
        (pair_var(node), format!("range_map_{token}_input"), format!("range_map_{token}_next"));
    let mut e = NodeEmission {
        declarations: vec![
            format!("double {var} = 0.0;"),
            format!("double {input_var} = 0.0;"),
            format!("uint8_t {pair} = 1;"),
        ],
        ..NodeEmission::default()
    };

    let sources = inputs.on("value");
    if let Some(note) = extra_sources_note("value", sources) {
        e.declarations.push(note);
    }
    let first = &sources[..sources.len().min(1)];
    let mut step = Vec::new();
    if let Some(source) = first.first() {
        let input = source.value.as_double_parsing();
        // A zero-width `from` range (min == max) divides by zero in C++
        // (inf/nan). The range is fixed at codegen time, so collapse it to the
        // low output bound instead of emitting the division.
        let mapped = if (config.from.max - config.from.min).abs() < f64::EPSILON {
            out_min.clone()
        } else {
            format!(
                "(({input} - {in_min}) * ({out_max} - {out_min}) / ({in_max} - {in_min}) + {out_min})"
            )
        };
        step.push(format!("double {next} = round(({mapped}) * {factor}) / {factor};"));
        step.push(format!(
            "if ({input} != {input_var} || {next} != {var}) {{ {pair} = {pair} == 255 ? 1 : {pair} + 1; }}"
        ));
        step.push(format!("{input_var} = {input}; {var} = {next};"));
    }
    e.transform(&prefix(node), first, step);
    Ok(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
    use crate::flow::Position;
    use serde_json::json;

    fn rm(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("RangeMap".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn value_input(expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::level(expr));
        inputs
    }

    #[test]
    fn declares_output_variable() {
        let e = emit(&rm("r-1", json!({})), &NodeInputs::default()).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("range_map_r_1_value")));
    }

    #[test]
    fn emits_linear_remap_math() {
        let e = emit(
            &rm("r-1", json!({ "from": { "min": 0.0, "max": 1023.0 }, "to": { "min": 0.0, "max": 255.0 } })),
            &value_input(CppExpr::number("sensor_s_1_value")),
        ).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains("sensor_s_1_value"));
        assert!(body.contains("1023.0"));
        assert!(body.contains("255.0"));
        assert!(body.contains("round("));
    }

    #[test]
    fn zero_width_from_range_collapses_to_output_min_without_dividing() {
        let e = emit(
            &rm("r-1", json!({ "from": { "min": 5.0, "max": 5.0 }, "to": { "min": 0.0, "max": 255.0 } })),
            &value_input(CppExpr::number("sensor_s_1_value")),
        ).unwrap();
        let body = e.loop_body.join("\n");
        // A zero-width `from` range maps to the low output bound instead of
        // dividing by the zero span (which would emit inf/nan C++).
        assert!(body.contains("range_map_r_1_next = round((0.0) * 1.0) / 1.0;"), "{body}");
        assert!(!body.contains("(5.0 - 5.0)"));
    }

    #[test]
    fn small_output_span_uses_decimal_precision() {
        let e = emit(
            &rm("r-1", json!({ "from": { "min": 0.0, "max": 100.0 }, "to": { "min": 0.0, "max": 5.0 } })),
            &value_input(CppExpr::number("v")),
        ).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("* 10.0") && l.contains("/ 10.0")));
    }

    #[test]
    fn large_output_span_uses_whole_numbers() {
        let e = emit(
            &rm("r-1", json!({ "from": { "min": 0.0, "max": 100.0 }, "to": { "min": 0.0, "max": 255.0 } })),
            &value_input(CppExpr::number("v")),
        ).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("* 1.0") && l.contains("/ 1.0")));
    }

    #[test]
    fn string_sources_parse_like_the_runtime() {
        let e = emit(&rm("r-1", json!({})), &value_input(CppExpr::text("msg"))).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains(".toFloat()")));
    }

    #[test]
    fn extra_sources_are_noted() {
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::level(CppExpr::number("a")));
        inputs.add("value", SourceExpr::level(CppExpr::number("b")));
        let e = emit(&rm("r-1", json!({})), &inputs).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("// note:")));
    }

    #[test]
    fn no_input_emits_no_loop_body() {
        let e = emit(&rm("r-1", json!({})), &NodeInputs::default()).unwrap();
        assert!(e.loop_body.is_empty(), "{:?}", e.loop_body);
    }

    #[test]
    fn emits_deterministically() {
        let n = rm("r-1", json!({ "to": { "min": 0.0, "max": 255.0 } }));
        let inputs = value_input(CppExpr::number("v"));
        assert_eq!(emit(&n, &inputs).unwrap(), emit(&n, &inputs).unwrap());
    }
}
