//! Calculate emitter — mirrors `runtime/transformation/calculate.rs`.
//!
//! The live Calculate Node aggregates its inputs and applies an arithmetic
//! function (`add`, `subtract`, `multiply`, `divide`, `modulo`, `max`, `min`,
//! `pow`, `ceil`, `floor`, `round`), storing the result as its `Number` value.
//!
//! The generated value-passing model feeds a single driver expression into each
//! transformation Node (the wired source with the smallest id). With a single
//! input the runtime's fold semantics reduce to: `subtract`/`divide`/`modulo`
//! return `inputs[0]` unchanged (the fold body is skipped), `add`/`max`/`min`
//! return the value itself, `multiply` returns the value, `pow` returns the
//! value (fewer than two inputs), and `ceil`/`floor`/`round` apply their unary
//! math. We emit the matching single-input C++ so the Sketch reproduces what
//! the Flow Author observes when one signal drives the Node.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::config::calculate::{CalculateConfig, CalculateFunction};
use crate::flow::FlowNode;

/// The C++ `double` variable holding this Calculate Node's latest result.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("calculate_{}_value", node.id_token())
}

/// Build the C++ expression for the configured function applied to a single
/// input value `v` (the driver expression). Mirrors the runtime's single-input
/// fold semantics.
fn function_expr(function: CalculateFunction, v: &str) -> String {
    match function {
        // Unary math functions.
        CalculateFunction::Ceil => format!("ceil({v})"),
        CalculateFunction::Floor => format!("floor({v})"),
        CalculateFunction::Round => format!("round({v})"),
        // Multi-input folds collapse to the first input when only one is wired.
        // `add`/`subtract`/`multiply`/`divide`/`modulo`/`max`/`min`/`pow` all
        // yield the input value itself for a single input.
        _ => format!("({v})"),
    }
}

/// Emit C++ for a Calculate Node. `driver` is the C++ numeric expression that
/// feeds the Node, or `None` when nothing is wired in (the runtime leaves the
/// value at its `0.0` initial state).
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let var = value_var(node);
    let config: CalculateConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();

    let mut e = NodeEmission {
        declarations: vec![format!("double {var} = 0.0;")],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        let computed = function_expr(config.function, &format!("(double)({expr})"));
        e.loop_body.push(format!("{var} = {computed};"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn declares_output_variable() {
        let e = emit(&calc("c-1", json!({ "function": "add" })), None);
        assert!(e.declarations.iter().any(|d| d.contains("calculate_c_1_value")));
    }

    #[test]
    fn add_passes_single_input_through() {
        let e = emit(&calc("c-1", json!({ "function": "add" })), Some("sensor_s_1_value"));
        assert!(e.loop_body.iter().any(|l| l.contains("sensor_s_1_value")));
        assert!(!e.loop_body.iter().any(|l| l.contains("ceil")));
    }

    #[test]
    fn ceil_floor_round_emit_unary_math() {
        for func in ["ceil", "floor", "round"] {
            let e = emit(&calc("c-1", json!({ "function": func })), Some("x"));
            assert!(
                e.loop_body.iter().any(|l| l.contains(func)),
                "expected {func} call"
            );
        }
    }

    #[test]
    fn no_driver_emits_no_loop_body() {
        let e = emit(&calc("c-1", json!({ "function": "add" })), None);
        assert!(e.loop_body.is_empty());
    }

    #[test]
    fn emits_deterministically() {
        let n = calc("c-1", json!({ "function": "multiply" }));
        assert_eq!(emit(&n, Some("x")), emit(&n, Some("x")));
    }
}
