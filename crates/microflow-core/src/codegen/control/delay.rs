//! Delay emitter — mirrors `runtime/control/delay.rs`.
//!
//! The live Delay stores an incoming signal and re-emits it `delay` ms later
//! (default `1000`) via a spawned thread that sleeps. On device the wait must be
//! non-blocking, so the generated Sketch captures the input value and a
//! deadline timestamp in module-level state, then fires when
//! `millis() - armed_at >= delay`. The loop never blocks while the Delay is
//! pending — the rest of the Flow keeps running — and the unsigned elapsed-time
//! subtraction survives `millis()` rollover.
//!
//! Arming is edge-triggered (a rising edge on the driver) so a single signal
//! schedules a single fire, matching one `trigger` call == one delayed emit.
//! `forgetPrevious` is reproduced by re-arming on each new edge (the latest edge
//! wins), which is the same observable result as the runtime cancelling the
//! prior thread.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::config::delay::DelayConfig;
use crate::flow::FlowNode;

/// The C++ `double` variable holding this Delay Node's most recently emitted
/// (delayed) value, read by downstream Nodes.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("delay_{}_value", node.id_token())
}

/// Emit C++ for a Delay Node. `driver` is the wired input to be delayed, or
/// `None` when nothing is connected (the runtime never arms without a signal).
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let token = node.id_token();
    let var = value_var(node);
    let pending = format!("delay_{token}_pending");
    let armed = format!("delay_{token}_armed_at");
    let stored = format!("delay_{token}_stored");
    let prev = format!("delay_{token}_prev");
    let config: DelayConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    let delay_ms = config.delay;

    let mut e = NodeEmission {
        declarations: vec![format!("double {var} = 0.0;")],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        e.declarations.push(format!("bool {pending} = false;"));
        e.declarations.push(format!("unsigned long {armed} = 0;"));
        e.declarations.push(format!("double {stored} = 0.0;"));
        e.declarations.push(format!("bool {prev} = false;"));

        // Arm on a rising edge: capture the value and the deadline start.
        e.loop_body.push(format!("bool delay_{token}_now = (bool)({expr});"));
        e.loop_body.push(format!("if (delay_{token}_now && !{prev}) {{"));
        e.loop_body.push(format!("  {stored} = (double)({expr});"));
        e.loop_body.push(format!("  {armed} = millis();"));
        e.loop_body.push(format!("  {pending} = true;"));
        e.loop_body.push("}".to_string());
        e.loop_body.push(format!("{prev} = delay_{token}_now;"));
        // Fire once the delay has elapsed — non-blocking elapsed-time compare.
        e.loop_body
            .push(format!("if ({pending} && millis() - {armed} >= {delay_ms}UL) {{"));
        e.loop_body.push(format!("  {var} = {stored};"));
        e.loop_body.push(format!("  {pending} = false;"));
        e.loop_body.push("}".to_string());
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn fires_after_configured_delay_without_blocking() {
        let e = emit(&delay("d-1", json!({ "delay": 750 })), Some("v"));
        assert!(
            e.loop_body.iter().any(|l| l.contains("millis() - delay_d_1_armed_at >= 750UL")),
            "delay must fire on an elapsed-time comparison"
        );
        assert!(!e.loop_body.iter().any(|l| l.contains("delay(")), "must not block");
    }

    #[test]
    fn defaults_to_one_second() {
        let e = emit(&delay("d-1", json!({})), Some("v"));
        assert!(e.loop_body.iter().any(|l| l.contains(">= 1000UL")));
    }

    #[test]
    fn state_persists_across_iterations() {
        let e = emit(&delay("d-1", json!({})), Some("v"));
        assert!(e.declarations.iter().any(|d| d.contains("bool delay_d_1_pending")));
        assert!(e.declarations.iter().any(|d| d.contains("unsigned long delay_d_1_armed_at")));
    }

    #[test]
    fn no_driver_emits_no_timing() {
        let e = emit(&delay("d-1", json!({})), None);
        assert!(e.loop_body.is_empty());
        assert!(e.declarations.iter().any(|d| d.contains("delay_d_1_value = 0.0")));
    }

    #[test]
    fn emits_deterministically() {
        let n = delay("d-1", json!({ "delay": 200 }));
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }
}
