//! Interpret↔emit parity guards.
//!
//! The live runtime (`runtime/`) and the codegen emitters (`codegen/`) are two
//! implementations of the same Node semantics. The config single-source work
//! (see `crate::config`) makes them share a Node's fields + defaults, and the
//! handle-aware wiring model (`codegen/wire.rs`) gives codegen the same
//! port/emit routing the runtime router uses — but the *behavior* is still
//! written twice.
//!
//! These tests pin every operation variant (and Counter's ports) to an
//! explicit, EXHAUSTIVE classification: a newly added operation or port won't
//! compile until it is categorized here, forcing a conscious "emit it, or
//! record the limitation" decision. They are the CI replacement for the prose
//! docstrings that previously kept the two sides in sync by hand — the kind of
//! hand-sync that let the Smooth attenuation invert silently (commit
//! `e1e1eb9`).

#[cfg(test)]
mod tests {
    use crate::codegen::wire::{CppExpr, NodeInputs, SourceExpr};
    use crate::flow::{FlowNode, Position};
    use serde_json::json;

    fn node(node_type: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: "p".to_string(),
            node_type: Some(node_type.to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    /// Two numeric sources wired into one port — the shape that exercises a
    /// fold's multi-input path.
    fn two_inputs(port: &str) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add(port, SourceExpr::level(CppExpr::number("a")));
        inputs.add(port, SourceExpr::level(CppExpr::number("b")));
        inputs
    }

    // ---- Calculate: 11 arithmetic functions ------------------------------

    /// EXHAUSTIVE over `CalculateFunction`: the C++ token each variant's fold
    /// must contain when two inputs are wired. Add a variant → this won't
    /// compile until you name its emitted token.
    fn calculate_token(f: crate::config::calculate::CalculateFunction) -> &'static str {
        use crate::config::calculate::CalculateFunction::{
            Add, Ceil, Divide, Floor, Max, Min, Modulo, Multiply, Pow, Round, Subtract,
        };
        match f {
            Add => " + ",
            Subtract => " - ",
            Multiply => " * ",
            Divide => ") / ",
            Modulo => "fmod(",
            Max => "fmax(",
            Min => "fmin(",
            Pow => "pow(",
            Ceil => "ceil(",
            Floor => "floor(",
            Round => "round(",
        }
    }

    #[test]
    fn calculate_emit_covers_every_function() {
        use crate::config::calculate::CalculateFunction as F;
        // (wire-name, variant). Wire names are the serde `rename_all="lowercase"`
        // forms — feeding them re-checks the runtime↔wire mapping too.
        let all = [
            ("add", F::Add),
            ("subtract", F::Subtract),
            ("multiply", F::Multiply),
            ("divide", F::Divide),
            ("modulo", F::Modulo),
            ("max", F::Max),
            ("min", F::Min),
            ("pow", F::Pow),
            ("ceil", F::Ceil),
            ("floor", F::Floor),
            ("round", F::Round),
        ];
        for (wire, variant) in all {
            let e = crate::codegen::transformation::calculate::emit(
                &node("Calculate", json!({ "function": wire })),
                &two_inputs("value"),
            );
            let body = e.loop_body.join("\n");
            let token = calculate_token(variant);
            assert!(
                body.contains(token),
                "Calculate `{wire}` must emit its fold (`{token}`), got: {body}"
            );
            assert!(body.contains("(a)"), "Calculate `{wire}` must read its inputs: {body}");
        }
    }

    // ---- Gate: 6 boolean gates -------------------------------------------

    /// EXHAUSTIVE over `GateType`: the truthy-count comparison each gate emits
    /// over two wired inputs, transcribing the runtime's `passes_gate`.
    fn gate_comparison(g: crate::config::gate::GateType) -> &'static str {
        use crate::config::gate::GateType::{And, Nand, Nor, Or, Xnor, Xor};
        match g {
            And => "== 2",
            Nand => "!= 2",
            Or => "> 0",
            Nor => "== 0",
            Xor => "== 1",
            Xnor => "!= 1",
        }
    }

    #[test]
    fn gate_emit_covers_every_gate() {
        use crate::config::gate::GateType as G;
        let all = [
            ("and", G::And),
            ("nand", G::Nand),
            ("or", G::Or),
            ("xor", G::Xor),
            ("nor", G::Nor),
            ("xnor", G::Xnor),
        ];
        for (wire, variant) in all {
            let e = crate::codegen::transformation::gate::emit(
                &node("Gate", json!({ "gate": wire })),
                &two_inputs("value"),
            );
            let body = e.loop_body.join("\n");
            assert!(
                body.contains("true_count"),
                "Gate `{wire}` must count truthy inputs, got: {body}"
            );
            let cmp = gate_comparison(variant);
            assert!(
                body.contains(cmp),
                "Gate `{wire}` must compare the count (`{cmp}`), got: {body}"
            );
        }
    }

    // ---- Counter: 4 ports, all bound by the handle-aware wiring ----------

    /// Runtime `Counter` accepts four ports; the handle-aware wiring model
    /// emits all of them. Gated on `runtime` because `Component::ports()`
    /// lives there. A new/renamed port hits the `other =>` arm and fails
    /// until classified.
    #[cfg(feature = "runtime")]
    #[test]
    fn counter_ports_classified_for_codegen() {
        use crate::runtime::{control::counter::Counter, Component};

        // (port, the C++ action its binding must emit).
        let expected_action = |port: &str| match port {
            "increment" => "+= 1.0",
            "decrement" => "-= 1.0",
            "reset" => "= 0.0",
            "set" => "counter_p_count = ",
            other => panic!(
                "Counter port `{other}` is unclassified for codegen parity — bind it in \
                 codegen/control/counter.rs and name its emitted action here."
            ),
        };

        for &port in Counter::ports() {
            let mut inputs = NodeInputs::default();
            let expr = if port == "set" { CppExpr::number("v") } else { CppExpr::boolean("v") };
            inputs.add(port, SourceExpr::level(expr));
            let e = crate::codegen::control::counter::emit(&node("Counter", json!({})), &inputs);
            let body = e.loop_body.join("\n");
            let action = expected_action(port);
            assert!(
                body.contains(action),
                "Counter port `{port}` must emit `{action}`, got: {body}"
            );
        }
    }
}
