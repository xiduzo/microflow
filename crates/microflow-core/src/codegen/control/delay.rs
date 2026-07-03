//! Delay emitter — mirrors `runtime/control/delay.rs`.
//!
//! The live Delay stores the value arriving on its `trigger` port and re-emits
//! it on `event` `delay` ms later (default `1000`). On device the wait must be
//! non-blocking, so the generated Sketch captures the input value and a
//! deadline timestamp in module-level state, then fires when
//! `millis() - armed_at >= delay`. The loop never blocks while the Delay is
//! pending — the rest of the Flow keeps running — and the unsigned elapsed-time
//! subtraction survives `millis()` rollover.
//!
//! Arming is pulse-driven: event sources arm on their firing tick, level
//! sources on a rising edge, so a single signal schedules a single fire. A
//! `fired` flag is true exactly on the firing loop iteration — the on-device
//! twin of the `event` emission — so pulse-consuming downstream ports see one
//! event per fire even when consecutive delayed values are equal.
//!
//! `forgetPrevious` (the default) re-arms on every new trigger — the latest
//! trigger wins, the same observable result as the runtime cancelling the
//! prior wakeup. With `forgetPrevious` off the runtime queues every trigger
//! independently; a single C++ timer slot cannot queue, so the generated code
//! keeps the *first* pending deadline and ignores triggers while pending (the
//! closest single-slot approximation).

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, NodeInputs};
use crate::config::delay::DelayConfig;
use crate::flow::FlowNode;

/// The C++ `double` variable holding this Delay Node's most recently emitted
/// (delayed) value, read by downstream Nodes.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("delay_{}_value", node.id_token())
}

/// The C++ `bool` variable that is true only on the loop iteration in which
/// the delayed `event` fires.
#[must_use]
pub fn fired_var(node: &FlowNode) -> String {
    format!("delay_{}_fired", node.id_token())
}

/// Emit C++ for a Delay Node from its `trigger` port. With nothing connected
/// the Delay never arms (the runtime never fires without a signal).
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let token = node.id_token();
    let var = value_var(node);
    let fired = fired_var(node);
    let pending = format!("delay_{token}_pending");
    let armed = format!("delay_{token}_armed_at");
    let stored = format!("delay_{token}_stored");
    let config: DelayConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    let delay_ms = config.delay;

    let mut e = NodeEmission {
        declarations: vec![
            format!("double {var} = 0.0;"),
            format!("bool {fired} = false;"),
        ],
        ..NodeEmission::default()
    };

    let sources = inputs.on("trigger");
    if sources.is_empty() {
        return e;
    }

    e.declarations.push(format!("bool {pending} = false;"));
    e.declarations.push(format!("unsigned long {armed} = 0;"));
    e.declarations.push(format!("double {stored} = 0.0;"));

    let binding = bind_pulses(&format!("delay_{token}_trigger"), sources);
    e.declarations.extend(binding.declarations.iter().cloned());
    e.loop_body.push(format!("{fired} = false;"));
    e.loop_body.extend(binding.loop_lines.iter().cloned());

    // Arm per fired source: capture the value and the deadline start. With
    // `forgetPrevious` off, a pending deadline is kept (single-slot queue).
    let arm_guard = if config.forget_previous {
        String::new()
    } else {
        format!("!{pending} && ")
    };
    for (fired_expr, source) in binding.fired.iter().zip(sources) {
        e.loop_body.push(format!("if ({arm_guard}{fired_expr}) {{"));
        e.loop_body
            .push(format!("  {stored} = {};", source.value.as_double()));
        e.loop_body.push(format!("  {armed} = millis();"));
        e.loop_body.push(format!("  {pending} = true;"));
        e.loop_body.push("}".to_string());
    }

    // Fire once the delay has elapsed — non-blocking elapsed-time compare.
    e.loop_body
        .push(format!("if ({pending} && millis() - {armed} >= {delay_ms}UL) {{"));
    e.loop_body.push(format!("  {var} = {stored};"));
    e.loop_body.push(format!("  {fired} = true;"));
    e.loop_body.push(format!("  {pending} = false;"));
    e.loop_body.push("}".to_string());
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
    use crate::flow::Position;
    use serde_json::json;

    fn delay(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Delay".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn trigger_input(expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add("trigger", SourceExpr::level(expr));
        inputs
    }

    #[test]
    fn fires_after_configured_delay_without_blocking() {
        let e = emit(&delay("d-1", json!({ "delay": 750 })), &trigger_input(CppExpr::boolean("v")));
        assert!(
            e.loop_body.iter().any(|l| l.contains("millis() - delay_d_1_armed_at >= 750UL")),
            "delay must fire on an elapsed-time comparison"
        );
        assert!(!e.loop_body.iter().any(|l| l.contains("delay(")), "must not block");
    }

    #[test]
    fn exposes_a_one_tick_fired_flag() {
        let e = emit(&delay("d-1", json!({})), &trigger_input(CppExpr::boolean("v")));
        assert!(e.declarations.iter().any(|d| d.contains("bool delay_d_1_fired = false")));
        assert_eq!(e.loop_body.first().unwrap(), "delay_d_1_fired = false;");
        assert!(e.loop_body.iter().any(|l| l.contains("delay_d_1_fired = true")));
    }

    #[test]
    fn defaults_to_one_second() {
        let e = emit(&delay("d-1", json!({})), &trigger_input(CppExpr::boolean("v")));
        assert!(e.loop_body.iter().any(|l| l.contains(">= 1000UL")));
    }

    #[test]
    fn state_persists_across_iterations() {
        let e = emit(&delay("d-1", json!({})), &trigger_input(CppExpr::boolean("v")));
        assert!(e.declarations.iter().any(|d| d.contains("bool delay_d_1_pending")));
        assert!(e.declarations.iter().any(|d| d.contains("unsigned long delay_d_1_armed_at")));
    }

    #[test]
    fn forget_previous_off_keeps_the_first_pending_deadline() {
        let e = emit(
            &delay("d-1", json!({ "forgetPrevious": false })),
            &trigger_input(CppExpr::boolean("v")),
        );
        assert!(
            e.loop_body.iter().any(|l| l.contains("if (!delay_d_1_pending && ")),
            "arming is gated while pending"
        );
    }

    #[test]
    fn no_input_declares_but_never_arms() {
        let e = emit(&delay("d-1", json!({})), &NodeInputs::default());
        assert!(e.loop_body.is_empty());
        assert!(e.declarations.iter().any(|d| d.contains("delay_d_1_value = 0.0")));
        assert!(e.declarations.iter().any(|d| d.contains("delay_d_1_fired = false")));
    }

    #[test]
    fn emits_deterministically() {
        let n = delay("d-1", json!({ "delay": 200 }));
        let inputs = trigger_input(CppExpr::boolean("v"));
        assert_eq!(emit(&n, &inputs), emit(&n, &inputs));
    }
}
