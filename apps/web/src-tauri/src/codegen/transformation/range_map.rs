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
use crate::runtime::types::FlowNode;

/// The C++ `double` variable holding this `RangeMap` Node's mapped output.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("range_map_{}_value", node.id_token())
}

/// Read a numeric field from a nested range object (`from`/`to`) in the Node's
/// `data`, falling back to `default`.
fn range_field(node: &FlowNode, range: &str, key: &str, default: f64) -> f64 {
    node.data
        .get(range)
        .and_then(|r| r.get(key))
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(default)
}

/// Emit C++ for a `RangeMap` Node. `driver` is the wired numeric input, or
/// `None` when nothing is connected (the runtime leaves the value at `0.0`).
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let var = value_var(node);
    // Mirror `Range` defaults: from 0..1023, to 0..1023.
    let in_min = cpp_double(range_field(node, "from", "min", 0.0));
    let in_max = cpp_double(range_field(node, "from", "max", 1023.0));
    let out_min = cpp_double(range_field(node, "to", "min", 0.0));
    let out_max = cpp_double(range_field(node, "to", "max", 1023.0));

    // Precision factor: one decimal place when the output span is small, else
    // whole numbers — matching the runtime's `distance <= 10.0` rule.
    let distance = (range_field(node, "to", "max", 1023.0) - range_field(node, "to", "min", 0.0)).abs();
    let factor = if distance <= 10.0 { "10.0" } else { "1.0" };

    let mut e = NodeEmission {
        declarations: vec![format!("double {var} = 0.0;")],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        let mapped = format!(
            "(((double)({expr}) - {in_min}) * ({out_max} - {out_min}) / ({in_max} - {in_min}) + {out_min})"
        );
        e.loop_body
            .push(format!("{var} = round(({mapped}) * {factor}) / {factor};"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::Position;
    use serde_json::json;

    fn rm(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("RangeMap".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn declares_output_variable() {
        let e = emit(&rm("r-1", json!({})), None);
        assert!(e.declarations.iter().any(|d| d.contains("range_map_r_1_value")));
    }

    #[test]
    fn emits_linear_remap_math() {
        let e = emit(
            &rm("r-1", json!({ "from": { "min": 0.0, "max": 1023.0 }, "to": { "min": 0.0, "max": 255.0 } })),
            Some("sensor_s_1_value"),
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
            Some("v"),
        );
        assert!(e.loop_body.iter().any(|l| l.contains("* 10.0") && l.contains("/ 10.0")));
    }

    #[test]
    fn large_output_span_uses_whole_numbers() {
        let e = emit(
            &rm("r-1", json!({ "from": { "min": 0.0, "max": 100.0 }, "to": { "min": 0.0, "max": 255.0 } })),
            Some("v"),
        );
        assert!(e.loop_body.iter().any(|l| l.contains("* 1.0") && l.contains("/ 1.0")));
    }

    #[test]
    fn no_driver_emits_no_loop_body() {
        let e = emit(&rm("r-1", json!({})), None);
        assert!(e.loop_body.is_empty());
    }

    #[test]
    fn emits_deterministically() {
        let n = rm("r-1", json!({ "to": { "min": 0.0, "max": 255.0 } }));
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }
}
