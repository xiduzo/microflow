//! Interval emitter — mirrors `runtime/generator/interval.rs`.
//!
//! The live Interval schedules a wakeup every `interval` ms (clamped to a
//! `MIN_INTERVAL_MS` of 16) and emits the elapsed milliseconds on `event` each
//! tick; it starts running on flow start, and its `start` / `stop` ports
//! re-arm (resetting the elapsed base) or halt it. On device there is no
//! scheduler to arm, so the generated Sketch keeps the timer's last-fire
//! timestamp in a module-level `unsigned long` and, each `loop()` iteration,
//! fires when `millis() - previous >= interval` while running. This is fully
//! non-blocking: the loop never waits, multiple Intervals tick concurrently,
//! and the unsigned subtraction survives `millis()` rollover (~49 days).
//!
//! The output `double` holds the elapsed time since the current start window
//! (mirroring the runtime's `now - started_at` payload) and a `fired` flag is
//! true exactly on firing iterations — the on-device twin of the `event`
//! emission, consumed by pulse-driven downstream ports.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, NodeInputs};
use crate::config::interval::IntervalConfig;
use crate::flow::FlowNode;

/// Runtime clamps the interval to at least this many milliseconds.
const MIN_INTERVAL_MS: u64 = 16;

/// The C++ `double` variable holding this Interval Node's latest elapsed-time
/// output (milliseconds since its start window), updated on each fire.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("interval_{}_value", node.id_token())
}

/// The C++ `bool` variable that is true only on the loop iteration in which
/// the Interval's `event` fires.
#[must_use]
pub fn fired_var(node: &FlowNode) -> String {
    format!("interval_{}_fired", node.id_token())
}

/// Emit C++ for an Interval Node. The Interval free-runs from `setup()` (the
/// runtime arms itself on flow start); wired `start` / `stop` ports gate and
/// re-base it exactly like the runtime's dispatch.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let token = node.id_token();
    let var = value_var(node);
    let fired = fired_var(node);
    let previous = format!("interval_{token}_previous");
    let start = format!("interval_{token}_start");
    let running = format!("interval_{token}_running");
    let config: IntervalConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    let interval_ms = config.interval.max(MIN_INTERVAL_MS);
    // Mirrors on_start: the timer only free-runs when autoStart is set;
    // otherwise a wired `start` pulse must arm it.
    let auto_start = config.auto_start;

    let mut e = NodeEmission {
        declarations: vec![
            format!("unsigned long {previous} = 0;"),
            format!("unsigned long {start} = 0;"),
            format!("double {var} = 0.0;"),
            format!("bool {fired} = false;"),
            format!("bool {running} = {auto_start};"),
        ],
        // Seed both timestamps so the first tick is measured from boot, not 0.
        setup: vec![format!("{previous} = millis();"), format!("{start} = millis();")],
        ..NodeEmission::default()
    };

    e.loop_body.push(format!("{fired} = false;"));

    // start: re-arm and reset the elapsed base; stop: halt. Mirrors dispatch.
    let start_binding = bind_pulses(&format!("interval_{token}_start_port"), inputs.on("start"));
    e.declarations.extend(start_binding.declarations.iter().cloned());
    e.loop_body.extend(start_binding.loop_lines.iter().cloned());
    if let Some(any) = start_binding.any_fired() {
        e.loop_body.push(format!(
            "if ({any}) {{ {running} = true; {previous} = millis(); {start} = millis(); }}"
        ));
    }
    let stop_binding = bind_pulses(&format!("interval_{token}_stop_port"), inputs.on("stop"));
    e.declarations.extend(stop_binding.declarations.iter().cloned());
    e.loop_body.extend(stop_binding.loop_lines.iter().cloned());
    if let Some(any) = stop_binding.any_fired() {
        e.loop_body.push(format!("if ({any}) {{ {running} = false; }}"));
    }

    e.loop_body.extend([
        // Non-blocking: compare elapsed time, never block the loop.
        format!("if ({running} && millis() - {previous} >= {interval_ms}UL) {{"),
        format!("  {previous} += {interval_ms}UL;"),
        format!("  {var} = (double)(millis() - {start});"),
        format!("  {fired} = true;"),
        "}".to_string(),
    ]);
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
    use crate::flow::Position;
    use serde_json::json;

    fn interval(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Interval".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn fires_on_millis_comparison_without_blocking() {
        let e = emit(&interval("iv-1", json!({ "interval": 500 })), &NodeInputs::default());
        assert!(
            e.loop_body
                .iter()
                .any(|l| l.contains("millis() - interval_iv_1_previous >= 500UL")),
            "must compare elapsed millis against the configured interval"
        );
        assert!(
            !e.loop_body.iter().any(|l| l.contains("delay(")),
            "interval must never block"
        );
    }

    #[test]
    fn exposes_a_one_tick_fired_flag() {
        let e = emit(&interval("iv-1", json!({})), &NodeInputs::default());
        assert!(e.declarations.iter().any(|d| d.contains("bool interval_iv_1_fired")));
        assert_eq!(e.loop_body.first().unwrap(), "interval_iv_1_fired = false;");
        assert!(e.loop_body.iter().any(|l| l.contains("interval_iv_1_fired = true")));
    }

    #[test]
    fn clamps_to_min_interval() {
        let e = emit(&interval("iv-1", json!({ "interval": 1 })), &NodeInputs::default());
        assert!(
            e.loop_body.iter().any(|l| l.contains(">= 16UL")),
            "interval below the runtime minimum must clamp to 16ms"
        );
    }

    #[test]
    fn defaults_to_one_second() {
        let e = emit(&interval("iv-1", json!({})), &NodeInputs::default());
        assert!(e.loop_body.iter().any(|l| l.contains(">= 1000UL")));
    }

    #[test]
    fn keeps_timestamps_across_iterations() {
        let e = emit(&interval("iv-1", json!({})), &NodeInputs::default());
        assert!(e.declarations.iter().any(|d| d.contains("unsigned long interval_iv_1_previous")));
        assert!(e.setup.iter().any(|s| s.contains("= millis()")), "timer seeded in setup");
    }

    #[test]
    fn wired_start_and_stop_ports_gate_the_timer() {
        let mut inputs = NodeInputs::default();
        inputs.add("start", SourceExpr::level(CppExpr::boolean("go")));
        inputs.add("stop", SourceExpr::level(CppExpr::boolean("halt")));
        let e = emit(&interval("iv-1", json!({})), &inputs);
        let body = e.loop_body.join("\n");
        assert!(body.contains("interval_iv_1_running = true"), "start re-arms: {body}");
        assert!(body.contains("interval_iv_1_running = false"), "stop halts: {body}");
        assert!(body.contains("if (interval_iv_1_running && millis()"), "tick is gated: {body}");
    }

    #[test]
    fn emits_deterministically() {
        let n = interval("iv-1", json!({ "interval": 250 }));
        assert_eq!(emit(&n, &NodeInputs::default()), emit(&n, &NodeInputs::default()));
    }
}
