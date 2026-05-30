//! Interval emitter — mirrors `runtime/generator/interval.rs`.
//!
//! The live Interval spawns a thread that sleeps `interval` ms (clamped to a
//! `MIN_INTERVAL_MS` of 16) and emits the elapsed milliseconds on every tick. On
//! device there is no thread to sleep, so the generated Sketch keeps the timer's
//! last-fire timestamp in a module-level `unsigned long` and, each `loop()`
//! iteration, fires when `millis() - previous >= interval`. This is fully
//! non-blocking: the loop never waits, multiple Intervals tick concurrently, and
//! the unsigned subtraction survives `millis()` rollover (~49 days) without
//! stalling. The output `double` holds the elapsed time since `setup()`, mirror‑
//! ing the runtime's `start.elapsed()` value, so downstream Nodes see the same
//! signal they do in live mode.

use crate::codegen::emit::{u64_or_default, NodeEmission, NodeToken};
use crate::flow::FlowNode;

/// Runtime clamps the interval to at least this many milliseconds.
const MIN_INTERVAL_MS: u64 = 16;

/// The C++ `double` variable holding this Interval Node's latest elapsed-time
/// output (milliseconds since `setup()`), updated on each fire.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("interval_{}_value", node.id_token())
}

/// Emit C++ for an Interval Node. The Interval is self-driving (it is a
/// generator), so it ignores any `driver`; it ticks purely off the loop
/// scheduler's `millis()` clock.
#[must_use]
pub fn emit(node: &FlowNode) -> NodeEmission {
    let token = node.id_token();
    let var = value_var(node);
    let previous = format!("interval_{token}_previous");
    let start = format!("interval_{token}_start");
    let interval_ms = u64_or_default(node, "interval", 1000).max(MIN_INTERVAL_MS);

    NodeEmission {
        declarations: vec![
            format!("unsigned long {previous} = 0;"),
            format!("unsigned long {start} = 0;"),
            format!("double {var} = 0.0;"),
        ],
        // Seed both timestamps so the first tick is measured from boot, not 0.
        setup: vec![format!("{previous} = millis();"), format!("{start} = millis();")],
        loop_body: vec![
            // Non-blocking: compare elapsed time, never block the loop.
            format!("if (millis() - {previous} >= {interval_ms}UL) {{"),
            format!("  {previous} += {interval_ms}UL;"),
            format!("  {var} = (double)(millis() - {start});"),
            "}".to_string(),
        ],
        ..NodeEmission::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let e = emit(&interval("iv-1", json!({ "interval": 500 })));
        assert!(
            e.loop_body.iter().any(|l| l.contains("millis() - interval_iv_1_previous >= 500UL")),
            "must compare elapsed millis against the configured interval"
        );
        assert!(
            !e.loop_body.iter().any(|l| l.contains("delay(")),
            "interval must never block"
        );
    }

    #[test]
    fn clamps_to_min_interval() {
        let e = emit(&interval("iv-1", json!({ "interval": 1 })));
        assert!(
            e.loop_body.iter().any(|l| l.contains(">= 16UL")),
            "interval below the runtime minimum must clamp to 16ms"
        );
    }

    #[test]
    fn defaults_to_one_second() {
        let e = emit(&interval("iv-1", json!({})));
        assert!(e.loop_body.iter().any(|l| l.contains(">= 1000UL")));
    }

    #[test]
    fn keeps_timestamps_across_iterations() {
        let e = emit(&interval("iv-1", json!({})));
        assert!(e.declarations.iter().any(|d| d.contains("unsigned long interval_iv_1_previous")));
        assert!(e.setup.iter().any(|s| s.contains("= millis()")), "timer seeded in setup");
    }

    #[test]
    fn emits_deterministically() {
        let n = interval("iv-1", json!({ "interval": 250 }));
        assert_eq!(emit(&n), emit(&n));
    }
}
