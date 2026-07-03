//! `RangeMap` emitter — mirrors `runtime/transformation/range_map.rs`.
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

use crate::codegen::emit::{cpp_double, NodeEmission, NodeToken};
use crate::codegen::wire::{extra_sources_note, NodeInputs};
use crate::config::range_map::RangeMapConfig;
use crate::flow::FlowNode;

/// The C++ `double` variable holding this `RangeMap` Node's mapped output.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("range_map_{}_value", node.id_token())
}

/// Emit C++ for a `RangeMap` Node from its `value` port. With nothing
/// connected the value stays at `0.0` (the runtime never maps without a
/// signal). `RangeMap` does not aggregate: extra sources are noted and the
/// first drives the map. String sources are parsed like the runtime's
/// `String(s) => s.parse().unwrap_or(0.0)` arm.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let var = value_var(node);
    // Mirror `Range` defaults: from 0..1023, to 0..1023.
    let config: RangeMapConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    let in_min = cpp_double(config.from.min);
    let in_max = cpp_double(config.from.max);
    let out_min = cpp_double(config.to.min);
    let out_max = cpp_double(config.to.max);

    // Precision factor: one decimal place when the output span is small, else
    // whole numbers — matching the runtime's `distance <= 10.0` rule.
    let distance = (config.to.max - config.to.min).abs();
    let factor = if distance <= 10.0 { "10.0" } else { "1.0" };

    let mut e = NodeEmission {
        declarations: vec![format!("double {var} = 0.0;")],
        ..NodeEmission::default()
    };

    let sources = inputs.on("value");
    if let Some(note) = extra_sources_note("value", sources) {
        e.declarations.push(note);
    }
    if let Some(source) = sources.first() {
        let input = source.value.as_double_parsing();
        let mapped = format!(
            "(({input} - {in_min}) * ({out_max} - {out_min}) / ({in_max} - {in_min}) + {out_min})"
        );
        e.loop_body
            .push(format!("{var} = round(({mapped}) * {factor}) / {factor};"));
    }
    e
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
        let e = emit(&rm("r-1", json!({})), &NodeInputs::default());
        assert!(e.declarations.iter().any(|d| d.contains("range_map_r_1_value")));
    }

    #[test]
    fn emits_linear_remap_math() {
        let e = emit(
            &rm("r-1", json!({ "from": { "min": 0.0, "max": 1023.0 }, "to": { "min": 0.0, "max": 255.0 } })),
            &value_input(CppExpr::number("sensor_s_1_value")),
        );
        let body = e.loop_body.join("\n");
        assert!(body.contains("sensor_s_1_value"));
        assert!(body.contains("1023.0"));
        assert!(body.contains("255.0"));
        assert!(body.contains("round("));
    }

    #[test]
    fn small_output_span_uses_decimal_precision() {
        let e = emit(
            &rm("r-1", json!({ "from": { "min": 0.0, "max": 100.0 }, "to": { "min": 0.0, "max": 5.0 } })),
            &value_input(CppExpr::number("v")),
        );
        assert!(e.loop_body.iter().any(|l| l.contains("* 10.0") && l.contains("/ 10.0")));
    }

    #[test]
    fn large_output_span_uses_whole_numbers() {
        let e = emit(
            &rm("r-1", json!({ "from": { "min": 0.0, "max": 100.0 }, "to": { "min": 0.0, "max": 255.0 } })),
            &value_input(CppExpr::number("v")),
        );
        assert!(e.loop_body.iter().any(|l| l.contains("* 1.0") && l.contains("/ 1.0")));
    }

    #[test]
    fn string_sources_parse_like_the_runtime() {
        let e = emit(&rm("r-1", json!({})), &value_input(CppExpr::text("msg")));
        assert!(e.loop_body.iter().any(|l| l.contains(".toFloat()")));
    }

    #[test]
    fn extra_sources_are_noted() {
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::level(CppExpr::number("a")));
        inputs.add("value", SourceExpr::level(CppExpr::number("b")));
        let e = emit(&rm("r-1", json!({})), &inputs);
        assert!(e.declarations.iter().any(|d| d.contains("// note:")));
    }

    #[test]
    fn no_input_emits_no_loop_body() {
        let e = emit(&rm("r-1", json!({})), &NodeInputs::default());
        assert!(e.loop_body.is_empty());
    }

    #[test]
    fn emits_deterministically() {
        let n = rm("r-1", json!({ "to": { "min": 0.0, "max": 255.0 } }));
        let inputs = value_input(CppExpr::number("v"));
        assert_eq!(emit(&n, &inputs), emit(&n, &inputs));
    }
}
