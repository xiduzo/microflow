//! Compare emitter — mirrors `runtime/transformation/compare.rs`.
//!
//! The live Compare Node validates its input against a configured `validator`
//! and `subValidator`, storing a `Bool` result:
//! - `boolean` — truthiness of the input.
//! - `number` — `greater than` / `less than` / (default) equals `number`.
//! - `oddeven` — `odd` / (default) even, on the rounded input.
//! - `range` — `outside` the `[min, max]` bounds / (default) strictly inside.
//! - `text` — string predicates; not expressible against the numeric/boolean
//!   driver expressions of the generated value model, so it emits the runtime's
//!   `false` default for an empty match.
//!
//! The generated Sketch stores the boolean outcome in a `bool` variable that
//! downstream Nodes read, reproducing the live comparison for the wired input.

use crate::codegen::emit::{cpp_double, NodeEmission, NodeToken};
use crate::config::compare::{CompareConfig, CompareValidator};
use crate::flow::FlowNode;

/// The C++ `bool` variable holding this Compare Node's latest outcome.
#[must_use]
pub fn state_var(node: &FlowNode) -> String {
    format!("compare_{}_result", node.id_token())
}

/// Build the C++ boolean expression for the configured comparison applied to
/// the driver expression `v`.
fn compare_expr(config: &CompareConfig, v: &str) -> String {
    let sub = config.sub_validator.as_str();
    match config.validator {
        CompareValidator::Number => {
            let n = cpp_double(config.number);
            match sub {
                "greater than" => format!("((double)({v}) > {n})"),
                "less than" => format!("((double)({v}) < {n})"),
                _ => format!("((double)({v}) == {n})"),
            }
        }
        CompareValidator::OddEven => {
            // Round to nearest integer first, matching `as i64` after `round()`.
            let rounded = format!("((long)round((double)({v})))");
            match sub {
                "odd" => format!("(({rounded} % 2) != 0)"),
                _ => format!("(({rounded} % 2) == 0)"),
            }
        }
        CompareValidator::Range => {
            let min = cpp_double(config.range.min);
            let max = cpp_double(config.range.max);
            match sub {
                "outside" => format!("((double)({v}) < {min} || (double)({v}) > {max})"),
                _ => format!("((double)({v}) > {min} && (double)({v}) < {max})"),
            }
        }
        CompareValidator::Text => "false".to_string(),
        // `boolean` (default): truthiness of the input.
        _ => format!("((bool)({v}))"),
    }
}

/// Emit C++ for a Compare Node. `driver` is the wired input expression, or
/// `None` when nothing is connected (the runtime leaves the result at `false`).
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let var = state_var(node);
    let config: CompareConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();

    let mut e = NodeEmission {
        declarations: vec![format!("bool {var} = false;")],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        let computed = compare_expr(&config, expr);
        e.loop_body.push(format!("{var} = {computed};"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn cmp(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Compare".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn boolean_validator_uses_truthiness() {
        let e = emit(&cmp("c-1", json!({ "validator": "boolean" })), Some("x"));
        assert!(e.loop_body.iter().any(|l| l.contains("(bool)")));
    }

    #[test]
    fn number_greater_than_emits_comparison() {
        let e = emit(
            &cmp("c-1", json!({ "validator": "number", "subValidator": "greater than", "number": 5.0 })),
            Some("v"),
        );
        assert!(e.loop_body.iter().any(|l| l.contains("> 5.0")));
    }

    #[test]
    fn number_less_than_and_equals() {
        let lt = emit(
            &cmp("c-1", json!({ "validator": "number", "subValidator": "less than", "number": 2.0 })),
            Some("v"),
        );
        assert!(lt.loop_body.iter().any(|l| l.contains("< 2.0")));
        let eq = emit(
            &cmp("c-1", json!({ "validator": "number", "subValidator": "equal", "number": 3.0 })),
            Some("v"),
        );
        assert!(eq.loop_body.iter().any(|l| l.contains("== 3.0")));
    }

    #[test]
    fn oddeven_emits_modulo() {
        let odd = emit(&cmp("c-1", json!({ "validator": "oddeven", "subValidator": "odd" })), Some("v"));
        assert!(odd.loop_body.iter().any(|l| l.contains("% 2) != 0")));
        let even = emit(&cmp("c-1", json!({ "validator": "oddeven", "subValidator": "even" })), Some("v"));
        assert!(even.loop_body.iter().any(|l| l.contains("% 2) == 0")));
    }

    #[test]
    fn range_inside_and_outside() {
        let inside = emit(
            &cmp("c-1", json!({ "validator": "range", "range": { "min": 1.0, "max": 9.0 } })),
            Some("v"),
        );
        assert!(inside.loop_body.iter().any(|l| l.contains("> 1.0") && l.contains("< 9.0")));
        let outside = emit(
            &cmp("c-1", json!({ "validator": "range", "subValidator": "outside", "range": { "min": 1.0, "max": 9.0 } })),
            Some("v"),
        );
        assert!(outside.loop_body.iter().any(|l| l.contains("||")));
    }

    #[test]
    fn no_driver_leaves_false() {
        let e = emit(&cmp("c-1", json!({ "validator": "boolean" })), None);
        assert!(e.loop_body.is_empty());
        assert!(e.declarations.iter().any(|d| d.contains("= false;")));
    }

    #[test]
    fn emits_deterministically() {
        let n = cmp("c-1", json!({ "validator": "number", "number": 1.0 }));
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }
}
