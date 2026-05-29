//! Oscillator emitter — mirrors `runtime/generator/oscillator.rs`.
//!
//! The live Oscillator runs a thread that samples a waveform against the elapsed
//! time since start and emits the value. On device there is no thread; the
//! generated sketch instead samples the same waveform against `millis()` since
//! `setup()` on every loop iteration, writing the result into a module-level
//! `double`. The waveform math (sine, square, sawtooth, triangle, random) is the
//! exact port of the runtime's `calculate_waveform`, so the on-device signal
//! matches live mode. It is self-driving and fully non-blocking — it only reads
//! the scheduler's clock, never waits.

use crate::codegen::emit::{cpp_double, f64_or_default, NodeEmission, NodeToken};
use crate::runtime::types::FlowNode;

/// Default period matches `runtime/generator/oscillator.rs::default_period` (1000ms).
const DEFAULT_PERIOD: f64 = 1000.0;
/// Default amplitude matches `runtime/generator/oscillator.rs::default_amplitude` (1.0).
const DEFAULT_AMPLITUDE: f64 = 1.0;

/// The C++ `double` variable holding this Oscillator's current output sample.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("oscillator_{}_value", node.id_token())
}

/// The configured waveform, lowercased to match the runtime's `rename_all`.
fn waveform(node: &FlowNode) -> String {
    node.data
        .get("waveform")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("sinus")
        .to_ascii_lowercase()
}

/// Emit C++ for an Oscillator Node. The Oscillator is a generator: it ignores
/// any wired input and ticks purely off the loop scheduler's `millis()` clock.
#[must_use]
pub fn emit(node: &FlowNode) -> NodeEmission {
    let token = node.id_token();
    let value = value_var(node);
    let start = format!("oscillator_{token}_start");
    let t = format!("oscillator_{token}_t");

    // Guard against a zero period (division by zero) by clamping to the default.
    let period_raw = f64_or_default(node, "period", DEFAULT_PERIOD);
    let period = cpp_double(if period_raw.abs() < f64::EPSILON { DEFAULT_PERIOD } else { period_raw });
    let amplitude = cpp_double(f64_or_default(node, "amplitude", DEFAULT_AMPLITUDE));
    let phase = cpp_double(f64_or_default(node, "phase", 0.0));
    let shift = cpp_double(f64_or_default(node, "shift", 0.0));

    // `t` is the elapsed-millis timestamp plus phase, mirroring the runtime which
    // adds `config.phase` to `start.elapsed()`. All branches reduce `t` modulo
    // the period before sampling, exactly as `calculate_waveform` does.
    let mut loop_body = vec![
        format!("double {t} = (double)(millis() - {start}) + {phase};"),
    ];
    let sample = match waveform(node).as_str() {
        "square" => {
            loop_body.push(format!("{t} = fmod({t}, {period});"));
            loop_body.push(format!("if ({t} < 0.0) {{ {t} += {period}; }}"));
            format!("{value} = (({t} * 2.0 < {period}) ? {amplitude} : -({amplitude})) + {shift};")
        }
        "sawtooth" => {
            loop_body.push(format!("{t} = fmod({t}, {period});"));
            loop_body.push(format!("if ({t} < 0.0) {{ {t} += {period}; }}"));
            format!("{value} = {amplitude} * (-1.0 + {t} * (2.0 / {period})) + {shift};")
        }
        "triangle" => {
            loop_body.push(format!("{t} = fmod(fabs({t}), {period});"));
            format!(
                "{value} = (({t} * 2.0 < {period}) ? ({amplitude} * (-1.0 + {t} * (4.0 / {period}))) : ({amplitude} * (3.0 - {t} * (4.0 / {period})))) + {shift};"
            )
        }
        "random" => {
            // Runtime: (shift + amplitude) * rand in [0,1).
            format!("{value} = ({shift} + {amplitude}) * ((double)random(0, 10000) / 10000.0);")
        }
        // Sinus is the runtime default.
        _ => format!(
            "{value} = {amplitude} * sin({t} * (2.0 * PI / {period})) + {shift};"
        ),
    };
    loop_body.push(sample);

    NodeEmission {
        declarations: vec![
            format!("unsigned long {start} = 0;"),
            format!("double {value} = 0.0;"),
        ],
        setup: vec![format!("{start} = millis();")],
        loop_body,
        ..NodeEmission::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::Position;
    use serde_json::json;

    fn oscillator(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Oscillator".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn oscillator_samples_against_millis_non_blocking() {
        let e = emit(&oscillator("osc-1", json!({ "waveform": "sinus", "period": 1000 })));
        assert!(e.loop_body.iter().any(|l| l.contains("millis() - oscillator_osc_1_start")));
        assert!(e.loop_body.iter().any(|l| l.contains("sin(")), "sinus waveform");
        assert!(!e.loop_body.iter().any(|l| l.contains("delay(")), "must not block");
    }

    #[test]
    fn oscillator_square_waveform() {
        let e = emit(&oscillator("osc-1", json!({ "waveform": "square" })));
        assert!(e.loop_body.iter().any(|l| l.contains("* 2.0 <")));
    }

    #[test]
    fn oscillator_sawtooth_and_triangle() {
        let saw = emit(&oscillator("osc-1", json!({ "waveform": "sawtooth" })));
        assert!(saw.loop_body.iter().any(|l| l.contains("2.0 /")));
        let tri = emit(&oscillator("osc-1", json!({ "waveform": "triangle" })));
        assert!(tri.loop_body.iter().any(|l| l.contains("4.0 /")));
    }

    #[test]
    fn oscillator_random_uses_amplitude_and_shift() {
        let e = emit(&oscillator("osc-1", json!({ "waveform": "random", "amplitude": 2.0, "shift": 1.0 })));
        assert!(e.loop_body.iter().any(|l| l.contains("random(")));
    }

    #[test]
    fn oscillator_clamps_zero_period() {
        let e = emit(&oscillator("osc-1", json!({ "period": 0 })));
        // Falls back to the default period rather than dividing by zero.
        assert!(e.loop_body.iter().any(|l| l.contains("1000.0")));
    }

    #[test]
    fn oscillator_seeds_start_in_setup() {
        let e = emit(&oscillator("osc-1", json!({})));
        assert!(e.setup.iter().any(|s| s.contains("= millis()")));
        assert!(e.declarations.iter().any(|d| d.contains("double oscillator_osc_1_value")));
    }

    #[test]
    fn oscillator_emits_deterministically() {
        let n = oscillator("osc-1", json!({ "waveform": "square", "period": 500 }));
        assert_eq!(emit(&n), emit(&n));
    }
}
