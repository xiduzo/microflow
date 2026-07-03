//! Calculate emitter — mirrors `runtime/transformation/calculate.rs`.
//!
//! The live Calculate Node aggregates *all* inputs wired into its `value` port
//! (the router delivers a snapshot `Array` because Calculate
//! `aggregates_inputs`) and folds them with the configured arithmetic function,
//! storing the result as its `Number` value. Non-numeric inputs (`String`
//! sources) carry no number and are filtered out, exactly as
//! `ComponentValue::as_number` returns `None` for them.
//!
//! The generated C++ reproduces the same folds over the wired source
//! expressions: `add` sums, `subtract`/`divide`/`modulo` fold left from the
//! first input (skipping zero divisors, like the runtime), `multiply` takes the
//! product, `max`/`min` nest `fmax`/`fmin`, `pow` raises the first input to the
//! second, and `ceil`/`floor`/`round` apply their unary math to the first
//! input. With no numeric input wired the value stays at its `0.0` initial
//! state (the runtime returns early on an empty input set).

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{CppType, NodeInputs};
use crate::config::calculate::{CalculateConfig, CalculateFunction};
use crate::flow::FlowNode;

/// The C++ `double` variable holding this Calculate Node's latest result.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("calculate_{}_value", node.id_token())
}

/// Build the C++ fold expression for the configured function over the numeric
/// input expressions, mirroring the runtime's `check` fold semantics.
fn fold_expr(function: CalculateFunction, inputs: &[String]) -> String {
    let first = &inputs[0];
    match function {
        CalculateFunction::Add => format!("({})", inputs.join(" + ")),
        CalculateFunction::Subtract => format!("({})", inputs.join(" - ")),
        CalculateFunction::Multiply => format!("({})", inputs.join(" * ")),
        // The runtime skips zero divisors (`acc` unchanged); the nested ternary
        // reproduces that guard per divisor.
        CalculateFunction::Divide => inputs[1..].iter().fold(first.clone(), |acc, v| {
            format!("(({v} == 0.0) ? ({acc}) : (({acc}) / {v}))")
        }),
        CalculateFunction::Modulo => inputs[1..].iter().fold(first.clone(), |acc, v| {
            format!("(({v} == 0.0) ? ({acc}) : fmod({acc}, {v}))")
        }),
        CalculateFunction::Max => nest("fmax", inputs),
        CalculateFunction::Min => nest("fmin", inputs),
        CalculateFunction::Pow => {
            if inputs.len() >= 2 {
                format!("pow({first}, {})", inputs[1])
            } else {
                format!("({first})")
            }
        }
        // Unary math applies to the first input, like the runtime's inputs[0].
        CalculateFunction::Ceil => format!("ceil({first})"),
        CalculateFunction::Floor => format!("floor({first})"),
        CalculateFunction::Round => format!("round({first})"),
    }
}

/// Nest a two-argument fold (`fmax`/`fmin`) over all inputs.
fn nest(f: &str, inputs: &[String]) -> String {
    inputs[1..]
        .iter()
        .fold(inputs[0].clone(), |acc, v| format!("{f}({acc}, {v})"))
}

/// Emit C++ for a Calculate Node over everything wired into its `value` port.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let var = value_var(node);
    let config: CalculateConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();

    let mut e = NodeEmission {
        declarations: vec![format!("double {var} = 0.0;")],
        ..NodeEmission::default()
    };

    // String sources carry no number and are dropped, like the runtime's
    // `filter_map(as_number)`.
    let numeric: Vec<String> = inputs
        .on("value")
        .iter()
        .filter(|s| s.value.ty != CppType::Str)
        .map(|s| s.value.as_double())
        .collect();

    if !numeric.is_empty() {
        let computed = fold_expr(config.function, &numeric);
        e.loop_body.push(format!("{var} = {computed};"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
    use crate::flow::Position;
    use serde_json::json;

    fn calc(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Calculate".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn wired(exprs: &[CppExpr]) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        for e in exprs {
            inputs.add("value", SourceExpr::level(e.clone()));
        }
        inputs
    }

    #[test]
    fn declares_output_variable() {
        let e = emit(&calc("c-1", json!({ "function": "add" })), &NodeInputs::default());
        assert!(e.declarations.iter().any(|d| d.contains("calculate_c_1_value")));
    }

    #[test]
    fn add_sums_all_wired_inputs() {
        let e = emit(
            &calc("c-1", json!({ "function": "add" })),
            &wired(&[CppExpr::number("a"), CppExpr::number("b")]),
        );
        let body = e.loop_body.join("\n");
        assert!(body.contains("((double)(a)) + ((double)(b))"), "got: {body}");
    }

    #[test]
    fn subtract_folds_left_from_first_input() {
        let e = emit(
            &calc("c-1", json!({ "function": "subtract" })),
            &wired(&[CppExpr::number("a"), CppExpr::number("b"), CppExpr::number("c")]),
        );
        let body = e.loop_body.join("\n");
        assert!(body.contains("- ((double)(b))") && body.contains("- ((double)(c))"), "got: {body}");
    }

    #[test]
    fn divide_guards_zero_divisors_like_the_runtime() {
        let e = emit(
            &calc("c-1", json!({ "function": "divide" })),
            &wired(&[CppExpr::number("a"), CppExpr::number("b")]),
        );
        let body = e.loop_body.join("\n");
        assert!(body.contains("== 0.0) ?"), "zero divisor keeps the accumulator: {body}");
        assert!(body.contains("/ ((double)(b))"), "got: {body}");
    }

    #[test]
    fn modulo_uses_fmod_with_zero_guard() {
        let e = emit(
            &calc("c-1", json!({ "function": "modulo" })),
            &wired(&[CppExpr::number("a"), CppExpr::number("b")]),
        );
        assert!(e.loop_body.iter().any(|l| l.contains("fmod")));
    }

    #[test]
    fn max_min_nest_fmax_fmin() {
        let inputs = wired(&[CppExpr::number("a"), CppExpr::number("b"), CppExpr::number("c")]);
        let max = emit(&calc("c-1", json!({ "function": "max" })), &inputs);
        assert!(max.loop_body.iter().any(|l| l.contains("fmax(fmax(")));
        let min = emit(&calc("c-1", json!({ "function": "min" })), &inputs);
        assert!(min.loop_body.iter().any(|l| l.contains("fmin(fmin(")));
    }

    #[test]
    fn pow_uses_first_two_inputs_or_passes_single_through() {
        let two = emit(
            &calc("c-1", json!({ "function": "pow" })),
            &wired(&[CppExpr::number("a"), CppExpr::number("b")]),
        );
        assert!(two.loop_body.iter().any(|l| l.contains("pow(")));
        let one = emit(&calc("c-1", json!({ "function": "pow" })), &wired(&[CppExpr::number("a")]));
        assert!(!one.loop_body.iter().any(|l| l.contains("pow(")), "single input passes through");
    }

    #[test]
    fn ceil_floor_round_emit_unary_math_on_first_input() {
        for func in ["ceil", "floor", "round"] {
            let e = emit(
                &calc("c-1", json!({ "function": func })),
                &wired(&[CppExpr::number("x"), CppExpr::number("y")]),
            );
            let body = e.loop_body.join("\n");
            assert!(body.contains(func), "expected {func} call");
            assert!(!body.contains("(y)"), "unary math ignores extra inputs: {body}");
        }
    }

    #[test]
    fn string_sources_are_filtered_out_like_the_runtime() {
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::level(CppExpr::text("msg")));
        let e = emit(&calc("c-1", json!({ "function": "add" })), &inputs);
        assert!(e.loop_body.is_empty(), "a string-only input set never computes");
    }

    #[test]
    fn bool_sources_coerce_to_numbers() {
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::level(CppExpr::boolean("flag")));
        let e = emit(&calc("c-1", json!({ "function": "add" })), &inputs);
        assert!(e.loop_body.iter().any(|l| l.contains("(flag) ? 1.0 : 0.0")));
    }

    #[test]
    fn no_input_emits_no_loop_body() {
        let e = emit(&calc("c-1", json!({ "function": "add" })), &NodeInputs::default());
        assert!(e.loop_body.is_empty());
    }

    #[test]
    fn emits_deterministically() {
        let n = calc("c-1", json!({ "function": "multiply" }));
        let inputs = wired(&[CppExpr::number("x"), CppExpr::number("y")]);
        assert_eq!(emit(&n, &inputs), emit(&n, &inputs));
    }
}
