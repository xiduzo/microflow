//! Counter emitter — mirrors `runtime/control/counter.rs`.
//!
//! The live Counter starts at `0.0` and exposes four ports: `increment` and
//! `decrement` step the count by one per received signal, `reset` returns it to
//! zero, and `set` overwrites it with the incoming value. The generated C++
//! binds each port to the edges actually wired into it: pulse ports fire on a
//! source's emission tick (event sources) or on a rising edge of its level
//! (state sources), and `set` fires whenever a wired source's value changes —
//! one dispatch per new sample. Within one tick the ports apply in the fixed
//! order `increment`, `decrement`, `reset`, `set`, keeping simultaneous firings
//! deterministic. The count is a module-level `double` so it persists across
//! `loop()` iterations exactly as the runtime's value persists across signals.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, NodeInputs};
use crate::flow::FlowNode;

/// The C++ `double` variable holding this Counter Node's running count. Exposed
/// as the Node's readable value for downstream Nodes.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("counter_{}_count", node.id_token())
}

/// Emit C++ for a Counter Node, binding every wired port.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let token = node.id_token();
    let var = value_var(node);

    let mut e = NodeEmission {
        declarations: vec![format!("double {var} = 0.0;")],
        ..NodeEmission::default()
    };

    // increment / decrement / reset: one action per fired source.
    for (port, action) in [
        ("increment", format!("{var} += 1.0;")),
        ("decrement", format!("{var} -= 1.0;")),
        ("reset", format!("{var} = 0.0;")),
    ] {
        let binding = bind_pulses(&format!("counter_{token}_{port}"), inputs.on(port));
        e.declarations.extend(binding.declarations.iter().cloned());
        e.loop_body.extend(binding.loop_lines.iter().cloned());
        for fired in &binding.fired {
            e.loop_body.push(format!("if ({fired}) {{ {action} }}"));
        }
    }

    // set: every new sample from a wired source overwrites the count.
    let sources = inputs.on("set");
    let binding = bind_pulses(&format!("counter_{token}_set"), sources);
    e.declarations.extend(binding.declarations.iter().cloned());
    e.loop_body.extend(binding.loop_lines.iter().cloned());
    for (fired, source) in binding.fired.iter().zip(sources) {
        e.loop_body.push(format!(
            "if ({fired}) {{ {var} = {}; }}",
            source.value.as_double()
        ));
    }

    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
    use crate::flow::Position;
    use serde_json::json;

    fn counter(id: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Counter".to_string()),
            data: json!({}),
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn on(port: &str, expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add(port, SourceExpr::level(expr));
        inputs
    }

    #[test]
    fn count_starts_at_zero_and_persists() {
        let e = emit(&counter("ct-1"), &on("increment", CppExpr::boolean("v")));
        // Module-level declaration => persists across loop iterations.
        assert!(e.declarations.iter().any(|d| d.contains("double counter_ct_1_count = 0.0")));
    }

    #[test]
    fn increments_once_per_source_change() {
        let e = emit(&counter("ct-1"), &on("increment", CppExpr::boolean("v")));
        let body = e.loop_body.join("\n");
        assert!(body.contains("+= 1.0"), "must increment");
        assert!(
            body.contains("!= counter_ct_1_increment_prev0"),
            "one increment per source change — a sustained level counts once: {body}"
        );
    }

    #[test]
    fn rising_edge_sources_increment_only_on_entry() {
        // A `true`-handle source (rising detector) counts presses only.
        let mut inputs = NodeInputs::default();
        inputs.add("increment", SourceExpr::rising(CppExpr::boolean("btn")));
        let e = emit(&counter("ct-1"), &inputs);
        assert!(
            e.loop_body.iter().any(|l| l.contains("&& !counter_ct_1_increment_prev0")),
            "rising sources keep their edge shape"
        );
    }

    #[test]
    fn decrement_reset_and_set_ports_are_bound() {
        let mut inputs = NodeInputs::default();
        inputs.add("decrement", SourceExpr::level(CppExpr::boolean("d")));
        inputs.add("reset", SourceExpr::level(CppExpr::boolean("r")));
        inputs.add("set", SourceExpr::level(CppExpr::number("s")));
        let e = emit(&counter("ct-1"), &inputs);
        let body = e.loop_body.join("\n");
        assert!(body.contains("-= 1.0"), "decrement bound: {body}");
        assert!(body.contains("= 0.0;"), "reset bound: {body}");
        assert!(body.contains("counter_ct_1_count = ((double)(s))"), "set bound: {body}");
    }

    #[test]
    fn set_fires_on_value_change_not_rising_edge() {
        let e = emit(&counter("ct-1"), &on("set", CppExpr::number("s")));
        let body = e.loop_body.join("\n");
        assert!(body.contains("!="), "set uses change detection: {body}");
    }

    #[test]
    fn event_sources_reuse_their_fired_flag() {
        let mut inputs = NodeInputs::default();
        inputs.add(
            "increment",
            SourceExpr::event(CppExpr::number("delay_d_value"), "delay_d_fired"),
        );
        let e = emit(&counter("ct-1"), &inputs);
        let body = e.loop_body.join("\n");
        assert!(body.contains("if (delay_d_fired)"), "uses the source's fired flag: {body}");
        assert!(!body.contains("_prev0"), "no synthesized tracker needed");
    }

    #[test]
    fn no_input_keeps_count_static() {
        let e = emit(&counter("ct-1"), &NodeInputs::default());
        assert!(e.loop_body.is_empty(), "no input => no updates");
        assert!(e.declarations.iter().any(|d| d.contains("= 0.0")));
    }

    #[test]
    fn emits_deterministically() {
        let n = counter("ct-1");
        let inputs = on("increment", CppExpr::boolean("v"));
        assert_eq!(emit(&n, &inputs), emit(&n, &inputs));
    }
}
