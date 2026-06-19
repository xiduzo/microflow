//! Smooth emitter — mirrors `runtime/transformation/smooth.rs`.
//!
//! The live Smooth Node holds state across evaluations:
//! - `smooth` (default) — exponential smoothing:
//!   `result = (1 - attenuation) * value + attenuation * previous`,
//!   seeded from the Node's running value. `attenuation` is the share of the
//!   previous running value retained each step, so a high attenuation
//!   (default 0.995) damps the signal heavily.
//! - `movingAverage` — the mean of the last `windowSize` inputs (a rolling
//!   window that drops the oldest sample once full).
//!
//! Per the Feature's stateful-Node approach, the generated Sketch keeps a
//! module-level state variable updated each loop iteration rather than
//! recomputing from a full history. Exponential smoothing persists a single
//! running `double`; the moving average persists a fixed-size ring buffer plus
//! its fill count, reproducing the same rolling mean on-device. The output
//! `double` is read by downstream Nodes.

use crate::codegen::emit::{cpp_double, NodeEmission, NodeToken};
use crate::config::smooth::{SmoothConfig, SmoothType};
use crate::flow::FlowNode;

/// The C++ `double` variable holding this Smooth Node's latest output.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("smooth_{}_value", node.id_token())
}

/// Emit C++ for a Smooth Node. `driver` is the wired numeric input, or `None`
/// when nothing is connected (the runtime leaves the value at `0.0`).
///
/// Deserializes the shared [`SmoothConfig`] from `node.data`, so the fields and
/// defaults are exactly the ones the live runtime uses — no re-typed literals.
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let token = node.id_token();
    let var = value_var(node);
    let config: SmoothConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();

    match config.smooth_type {
        SmoothType::MovingAverage => moving_average(&token, &var, config.window_size, driver),
        SmoothType::Smooth => exponential(&var, config.attenuation, driver),
    }
}

/// Exponential smoothing: a single persistent running value.
fn exponential(var: &str, attenuation: f64, driver: Option<&str>) -> NodeEmission {
    let attenuation = cpp_double(attenuation);

    let mut e = NodeEmission {
        declarations: vec![format!("double {var} = 0.0;")],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        // Seed the running value with the first sample so the output starts at
        // the signal instead of ramping up from 0.0 ("slow to wake").
        let seeded = format!("{var}_seeded");
        e.declarations.push(format!("bool {seeded} = false;"));
        e.loop_body.push(format!(
            "if (!{seeded}) {{ {var} = (double)({expr}); {seeded} = true; }} \
             else {{ {var} = (1.0 - {attenuation}) * (double)({expr}) + {attenuation} * {var}; }}"
        ));
    }
    e
}

/// Moving average over a fixed-size ring buffer plus fill count.
fn moving_average(token: &str, var: &str, window_size: usize, driver: Option<&str>) -> NodeEmission {
    // Guard against a 0 window to avoid a zero-length buffer / divide-by-zero in
    // the emitted C++ (the runtime default is 25, applied during deserialization).
    let window = window_size.max(1);
    let buf = format!("smooth_{token}_window");
    let idx = format!("smooth_{token}_index");
    let count = format!("smooth_{token}_count");

    let mut e = NodeEmission {
        declarations: vec![
            format!("double {buf}[{window}] = {{0}};"),
            format!("int {idx} = 0;"),
            format!("int {count} = 0;"),
            format!("double {var} = 0.0;"),
        ],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        e.loop_body.push(format!("{buf}[{idx}] = (double)({expr});"));
        e.loop_body.push(format!("{idx} = ({idx} + 1) % {window};"));
        e.loop_body
            .push(format!("if ({count} < {window}) {{ {count}++; }}"));
        e.loop_body.push(format!("double smooth_{token}_sum = 0.0;"));
        e.loop_body
            .push(format!("for (int i = 0; i < {count}; i++) {{ smooth_{token}_sum += {buf}[i]; }}"));
        e.loop_body
            .push(format!("{var} = smooth_{token}_sum / {count};"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn smooth(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Smooth".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn exponential_persists_running_value() {
        let e = emit(&smooth("s-1", json!({ "type": "smooth", "attenuation": 0.9 })), Some("v"));
        // Decl is a single persistent double; loop updates it from itself.
        assert!(e.declarations.iter().any(|d| d.contains("smooth_s_1_value")));
        assert!(e.loop_body.iter().any(|l| l.contains("0.9") && l.contains("smooth_s_1_value")));
    }

    #[test]
    fn moving_average_uses_ring_buffer() {
        let e = emit(
            &smooth("s-1", json!({ "type": "movingAverage", "windowSize": 5 })),
            Some("v"),
        );
        assert!(e.declarations.iter().any(|d| d.contains("smooth_s_1_window[5]")));
        assert!(e.loop_body.iter().any(|l| l.contains("% 5")));
        assert!(e.loop_body.iter().any(|l| l.contains("sum")));
    }

    #[test]
    fn moving_average_guards_zero_window() {
        let e = emit(
            &smooth("s-1", json!({ "type": "movingAverage", "windowSize": 0 })),
            Some("v"),
        );
        assert!(e.declarations.iter().any(|d| d.contains("smooth_s_1_window[1]")));
    }

    #[test]
    fn default_type_is_exponential() {
        let e = emit(&smooth("s-1", json!({})), Some("v"));
        assert!(e.loop_body.iter().any(|l| l.contains("0.995")));
    }

    #[test]
    fn no_driver_emits_no_loop_body() {
        let e = emit(&smooth("s-1", json!({})), None);
        assert!(e.loop_body.is_empty());
        assert!(e.declarations.iter().any(|d| d.contains("= 0.0;")));
    }

    #[test]
    fn emits_deterministically() {
        let n = smooth("s-1", json!({ "type": "movingAverage", "windowSize": 3 }));
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }
}
