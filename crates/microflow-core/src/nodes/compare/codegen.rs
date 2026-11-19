//! Compare emitter — mirrors `nodes/compare/runtime.rs`.
//!
//! The live Compare Node validates the value arriving on its `value` port
//! against a configured `validator` and `subValidator`, storing a `Bool`
//! result:
//! - `boolean` — truthiness of the input.
//! - `number` — `greater than` / `less than` / (default) equals `number`,
//!   within the one tolerance both sides use
//!   ([`EQUALITY_TOLERANCE`](super::config::EQUALITY_TOLERANCE)).
//! - `oddEven` — `odd` / (default) even, on the rounded input.
//! - `range` — `outside` the `[min, max]` bounds / (default) strictly inside.
//! - `text` — string predicates; not expressible against the on-device value
//!   model, so it emits the runtime's `false` default for an empty match.
//!
//! The generated Sketch checks on each tick a value reaches the Compare, and
//! on no other ([`NodeEmission::transform`]): it stores the outcome in a `bool`
//! that downstream Nodes read, and its fired flag is the check, on which the
//! live Compare emits `true` or `false`. Compare does not aggregate: with
//! several sources wired the generated code follows the first (deterministic)
//! one and notes the rest.

use super::config::{CompareConfig, CompareValidator, EQUALITY_TOLERANCE};
use crate::codegen::emit::{cpp_double, NodeEmission, NodeToken};
use crate::codegen::wire::{extra_sources_note, CppExpr, NodeInputs};
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;

/// The C++ `bool` variable holding this Compare Node's latest outcome.
#[must_use]
pub(crate) fn state_var(node: &FlowNode) -> String {
    format!("compare_{}_result", node.id_token())
}

/// The C++ `bool` that is true on the ticks this Compare checks a value.
#[must_use]
pub(crate) fn fired_var(node: &FlowNode) -> String {
    format!("{}_fired", prefix(node))
}

fn prefix(node: &FlowNode) -> String {
    format!("compare_{}", node.id_token())
}

/// Build the C++ boolean expression for the configured comparison applied to
/// the wired source expression, using its typed coercions.
fn compare_expr(config: &CompareConfig, source: &CppExpr) -> String {
    let sub = config.sub_validator.as_str();
    let v = source.as_double();
    match config.validator {
        CompareValidator::Number => {
            let n = cpp_double(config.number);
            match sub {
                "greater than" => format!("({v} > {n})"),
                "less than" => format!("({v} < {n})"),
                _ => format!("(fabs({v} - {n}) < {})", cpp_double(EQUALITY_TOLERANCE)),
            }
        }
        CompareValidator::OddEven => {
            // Round to nearest integer first, matching `as i64` after `round()`.
            let rounded = format!("((long)round({v}))");
            match sub {
                "odd" => format!("(({rounded} % 2) != 0)"),
                _ => format!("(({rounded} % 2) == 0)"),
            }
        }
        CompareValidator::Range => {
            let min = cpp_double(config.range.min);
            let max = cpp_double(config.range.max);
            match sub {
                "outside" => format!("({v} < {min} || {v} > {max})"),
                _ => format!("({v} > {min} && {v} < {max})"),
            }
        }
        CompareValidator::Text => "false".to_string(),
        // `boolean` (default): truthiness of the input.
        CompareValidator::Boolean => source.as_bool(),
    }
}

/// Emit C++ for a Compare Node from its `value` port. With nothing connected
/// the result stays `false` and it never checks (the runtime never checks
/// without a signal).
pub(crate) fn emit(node: &FlowNode, inputs: &NodeInputs) -> Result<NodeEmission, UnreadableConfig> {
    let var = state_var(node);
    let config = resolve::<CompareConfig>(&node.data)?;

    let mut e = NodeEmission {
        declarations: vec![format!("bool {var} = false;")],
        ..NodeEmission::default()
    };

    let sources = inputs.on("value");
    if let Some(note) = extra_sources_note("value", sources) {
        e.declarations.push(note);
    }
    let first = &sources[..sources.len().min(1)];
    let step = first
        .iter()
        .map(|source| format!("{var} = {};", compare_expr(&config, &source.value)))
        .collect();
    e.transform(&prefix(node), first, step);
    Ok(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::SourceExpr;
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

    fn value_input(expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::level(expr));
        inputs
    }

    #[test]
    fn boolean_validator_uses_truthiness() {
        let e = emit(
            &cmp("c-1", json!({ "validator": "boolean" })),
            &value_input(CppExpr::number("x")),
        ).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("(x) != 0.0")));
    }

    #[test]
    fn number_greater_than_emits_comparison() {
        let e = emit(
            &cmp("c-1", json!({ "validator": "number", "subValidator": "greater than", "number": 5.0 })),
            &value_input(CppExpr::number("v")),
        ).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("> 5.0")));
    }

    #[test]
    fn number_less_than_and_equals() {
        let lt = emit(
            &cmp("c-1", json!({ "validator": "number", "subValidator": "less than", "number": 2.0 })),
            &value_input(CppExpr::number("v")),
        ).unwrap();
        assert!(lt.loop_body.iter().any(|l| l.contains("< 2.0")));
        let eq = emit(
            &cmp("c-1", json!({ "validator": "number", "subValidator": "equal", "number": 3.0 })),
            &value_input(CppExpr::number("v")),
        ).unwrap();
        assert!(
            eq.loop_body.iter().any(|l| l.contains(&format!("fabs(((double)(v)) - 3.0) < {}", cpp_double(EQUALITY_TOLERANCE)))),
            "{:?}",
            eq.loop_body
        );
    }

    /// The step runs on the ticks the source fires, and the fired flag is
    /// the check the `true` and `false` handles fire on.
    #[test]
    fn checks_only_when_its_source_fires() {
        let e = emit(&cmp("c-1", json!({ "validator": "boolean" })), &value_input(CppExpr::number("x"))).unwrap();
        assert!(e.declarations.iter().any(|d| d == "bool compare_c_1_fired = false;"), "{:?}", e.declarations);
        let body = e.loop_body.join("\n");
        assert!(body.contains("compare_c_1_fired = (compare_c_1_in_fired0);\nif (compare_c_1_fired) {\n  compare_c_1_result = "), "{body}");
    }

    #[test]
    fn oddeven_emits_modulo() {
        let odd = emit(
            &cmp("c-1", json!({ "validator": "oddEven", "subValidator": "odd" })),
            &value_input(CppExpr::number("v")),
        ).unwrap();
        assert!(odd.loop_body.iter().any(|l| l.contains("% 2) != 0")));
        let even = emit(
            &cmp("c-1", json!({ "validator": "oddEven", "subValidator": "even" })),
            &value_input(CppExpr::number("v")),
        ).unwrap();
        assert!(even.loop_body.iter().any(|l| l.contains("% 2) == 0")));
    }

    #[test]
    fn range_inside_and_outside() {
        let inside = emit(
            &cmp("c-1", json!({ "validator": "range", "range": { "min": 1.0, "max": 9.0 } })),
            &value_input(CppExpr::number("v")),
        ).unwrap();
        assert!(inside.loop_body.iter().any(|l| l.contains("> 1.0") && l.contains("< 9.0")));
        let outside = emit(
            &cmp("c-1", json!({ "validator": "range", "subValidator": "outside", "range": { "min": 1.0, "max": 9.0 } })),
            &value_input(CppExpr::number("v")),
        ).unwrap();
        assert!(outside.loop_body.iter().any(|l| l.contains("||")));
    }

    #[test]
    fn bool_source_coerces_to_number_for_numeric_validators() {
        let e = emit(
            &cmp("c-1", json!({ "validator": "number", "number": 1.0 })),
            &value_input(CppExpr::boolean("flag")),
        ).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("(flag) ? 1.0 : 0.0")));
    }

    #[test]
    fn extra_sources_are_noted_and_ignored() {
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::level(CppExpr::number("a")));
        inputs.add("value", SourceExpr::level(CppExpr::number("b")));
        let e = emit(&cmp("c-1", json!({ "validator": "boolean" })), &inputs).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("// note:")));
        assert!(!e.loop_body.iter().any(|l| l.contains("(b)")), "only the first source drives");
    }

    #[test]
    fn no_input_leaves_false() {
        let e = emit(&cmp("c-1", json!({ "validator": "boolean" })), &NodeInputs::default()).unwrap();
        assert!(e.loop_body.is_empty(), "{:?}", e.loop_body);
        assert!(e.declarations.iter().any(|d| d.contains("= false;")));
    }

    #[test]
    fn emits_deterministically() {
        let n = cmp("c-1", json!({ "validator": "number", "number": 1.0 }));
        let inputs = value_input(CppExpr::number("v"));
        assert_eq!(emit(&n, &inputs).unwrap(), emit(&n, &inputs).unwrap());
    }
}
