//! Interpret↔emit parity guards.
//!
//! The live runtime (`runtime/`) and the codegen emitters (`codegen/`) are two
//! implementations of the same Node semantics. The config single-source work
//! (see `crate::config`) makes them share a Node's fields + defaults, but the
//! *behavior* is still written twice — and codegen's single-driver value model
//! deliberately cannot reproduce some multi-input runtime behaviors.
//!
//! These tests pin every operation variant (and Counter's ports) to an explicit,
//! EXHAUSTIVE classification: a newly added operation or port won't compile until
//! it is categorized here, forcing a conscious "emit it, or record the
//! single-driver limitation" decision. They are the CI replacement for the prose
//! docstrings that previously kept the two sides in sync by hand — the kind of
//! hand-sync that let the Smooth attenuation invert silently (commit `e1e1eb9`)
//! and that leaves Calculate's folds / Counter's extra ports unemittable today.

#[cfg(test)]
mod tests {
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

    /// How a codegen emitter treats one operation variant under the single-driver
    /// model: it either emits operation-specific C++, or collapses to the
    /// single-input form (the runtime's fold/aggregate reduced to one input).
    enum Emit {
        /// Emits C++ containing this distinctive token.
        Distinct(&'static str),
        /// Single-input passthrough (no operation-specific C++).
        Passthrough,
    }

    // ---- Calculate: 11 arithmetic functions ------------------------------

    /// EXHAUSTIVE over `CalculateFunction`. Add a variant → this won't compile
    /// until you classify it. `ceil`/`floor`/`round` are unary math the Sketch
    /// applies to one input; the eight folds reduce to their single input
    /// (documented in `codegen/transformation/calculate.rs`).
    fn calculate_kind(f: crate::config::calculate::CalculateFunction) -> Emit {
        use crate::config::calculate::CalculateFunction::{
            Add, Ceil, Divide, Floor, Max, Min, Modulo, Multiply, Pow, Round, Subtract,
        };
        match f {
            Ceil => Emit::Distinct("ceil"),
            Floor => Emit::Distinct("floor"),
            Round => Emit::Distinct("round"),
            Add | Subtract | Multiply | Divide | Modulo | Max | Min | Pow => Emit::Passthrough,
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
                Some("drv"),
            );
            let body = e.loop_body.join("\n");
            match calculate_kind(variant) {
                Emit::Distinct(tok) => {
                    assert!(body.contains(tok), "Calculate `{wire}` must emit `{tok}`, got: {body}");
                }
                Emit::Passthrough => {
                    for unary in ["ceil", "floor", "round"] {
                        assert!(
                            !body.contains(unary),
                            "Calculate `{wire}` must pass its single input through, but emitted `{unary}`: {body}"
                        );
                    }
                    assert!(body.contains("drv"), "Calculate `{wire}` must reference the driver: {body}");
                }
            }
        }
    }

    // ---- Gate: 6 boolean gates -------------------------------------------

    /// EXHAUSTIVE over `GateType`. Inverting gates negate the single input;
    /// pass-through gates forward it (`and`/`or`/`xor` all equal the lone input).
    fn gate_kind(g: crate::config::gate::GateType) -> Emit {
        use crate::config::gate::GateType::{And, Nand, Nor, Or, Xnor, Xor};
        match g {
            Nand | Nor | Xnor => Emit::Distinct("!((bool)"),
            And | Or | Xor => Emit::Passthrough,
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
                Some("drv"),
            );
            let body = e.loop_body.join("\n");
            match gate_kind(variant) {
                Emit::Distinct(tok) => {
                    assert!(body.contains(tok), "Gate `{wire}` must invert (`{tok}`), got: {body}");
                }
                Emit::Passthrough => assert!(
                    body.contains("(bool)(drv)") && !body.contains("!((bool)"),
                    "Gate `{wire}` must pass its single input through, got: {body}"
                ),
            }
        }
    }

    // ---- Counter: 4 ports, single-driver model emits only `increment` ----

    /// Runtime `Counter` accepts four ports; the codegen single-driver model can
    /// only pulse one. The other three are intentionally UNREACHABLE on-device
    /// (generated C++ has no multi-port input binding). Gated on `runtime`
    /// because `Component::ports()` lives there. A new/renamed port hits the
    /// `other =>` arm and fails until classified.
    #[cfg(feature = "runtime")]
    #[test]
    fn counter_ports_classified_for_codegen() {
        use crate::runtime::{control::counter::Counter, Component};

        let mut emittable = vec![];
        for &port in Counter::ports() {
            match port {
                "increment" => emittable.push(port), // the driver pulse (rising edge)
                "decrement" | "reset" | "set" => {}  // unreachable: single-driver model
                other => panic!(
                    "Counter port `{other}` is unclassified for codegen parity — emit it in \
                     codegen/control/counter.rs, or record it as a single-driver limitation \
                     in codegen/parity.rs."
                ),
            }
        }
        assert_eq!(emittable, ["increment"], "Counter's only codegen-emittable port is `increment`");

        // And the emitter actually produces that increment.
        let e = crate::codegen::control::counter::emit(&node("Counter", json!({})), Some("drv"));
        assert!(
            e.loop_body.join("\n").contains("+= 1.0"),
            "Counter codegen must emit the rising-edge increment"
        );
    }
}
