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

use crate::codegen::emit::{cpp_double, NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, NodeInputs};
use crate::config::oscillator::{OscillatorConfig, Waveform};
use crate::flow::FlowNode;

/// Default period matches `config::oscillator::default_period` (1000ms). Reused
/// here as the zero-period guard fallback.
const DEFAULT_PERIOD: f64 = 1000.0;

/// The C++ `double` variable holding this Oscillator's current output sample.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("oscillator_{}_value", node.id_token())
}

/// Emit C++ for an Oscillator Node. It samples its waveform off the loop
/// scheduler's `millis()` clock while running; `autoStart` (mirroring the
/// runtime's `on_start`) decides whether it free-runs from `setup()`, and
/// wired `start` / `stop` / `reset` ports gate and re-base it exactly like
/// the runtime's dispatch (`reset` restarts the phase only while running).
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let token = node.id_token();
    let value = value_var(node);
    let start = format!("oscillator_{token}_start");
    let running = format!("oscillator_{token}_running");
    let t = format!("oscillator_{token}_t");

    let config: OscillatorConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    // Guard against a zero period (division by zero) by clamping to the default.
    let period = cpp_double(if config.period.abs() < f64::EPSILON { DEFAULT_PERIOD } else { config.period });
    let amplitude = cpp_double(config.amplitude);
    let phase = cpp_double(config.phase);
    let shift = cpp_double(config.shift);

    // `t` is the elapsed-millis timestamp plus phase, mirroring the runtime which
    // adds `config.phase` to `start.elapsed()`. All branches reduce `t` modulo
    // the period before sampling, exactly as `calculate_waveform` does. The
    // whole sample block is gated on `running`, indented for readability.
    let mut sample_lines = vec![
        format!("double {t} = (double)(millis() - {start}) + {phase};"),
    ];
    let loop_body = &mut sample_lines;
    let sample = match config.waveform {
        Waveform::Square => {
            loop_body.push(format!("{t} = fmod({t}, {period});"));
            loop_body.push(format!("if ({t} < 0.0) {{ {t} += {period}; }}"));
            format!("{value} = (({t} * 2.0 < {period}) ? {amplitude} : -({amplitude})) + {shift};")
        }
        Waveform::Sawtooth => {
            loop_body.push(format!("{t} = fmod({t}, {period});"));
            loop_body.push(format!("if ({t} < 0.0) {{ {t} += {period}; }}"));
            format!("{value} = {amplitude} * (-1.0 + {t} * (2.0 / {period})) + {shift};")
        }
        Waveform::Triangle => {
            loop_body.push(format!("{t} = fmod(fabs({t}), {period});"));
            format!(
                "{value} = (({t} * 2.0 < {period}) ? ({amplitude} * (-1.0 + {t} * (4.0 / {period}))) : ({amplitude} * (3.0 - {t} * (4.0 / {period})))) + {shift};"
            )
        }
        Waveform::Random => {
            // Runtime: (shift + amplitude) * rand in [0,1).
            format!("{value} = ({shift} + {amplitude}) * ((double)random(0, 10000) / 10000.0);")
        }
        // Sinus is the runtime default.
        Waveform::Sinus => format!(
            "{value} = {amplitude} * sin({t} * (2.0 * PI / {period})) + {shift};"
        ),
    };
    loop_body.push(sample);

    let mut e = NodeEmission {
        declarations: vec![
            format!("unsigned long {start} = 0;"),
            format!("double {value} = 0.0;"),
            format!("bool {running} = {};", config.auto_start),
        ],
        setup: vec![format!("{start} = millis();")],
        ..NodeEmission::default()
    };

    // start: run and re-base the phase; stop: halt; reset: restart the phase
    // only while running (the runtime's stop-then-start-if-was-running).
    let start_binding = bind_pulses(&format!("oscillator_{token}_start_port"), inputs.on("start"));
    e.declarations.extend(start_binding.declarations.iter().cloned());
    e.loop_body.extend(start_binding.loop_lines.iter().cloned());
    if let Some(any) = start_binding.any_fired() {
        e.loop_body
            .push(format!("if ({any}) {{ {running} = true; {start} = millis(); }}"));
    }
    let stop_binding = bind_pulses(&format!("oscillator_{token}_stop_port"), inputs.on("stop"));
    e.declarations.extend(stop_binding.declarations.iter().cloned());
    e.loop_body.extend(stop_binding.loop_lines.iter().cloned());
    if let Some(any) = stop_binding.any_fired() {
        e.loop_body.push(format!("if ({any}) {{ {running} = false; }}"));
    }
    let reset_binding = bind_pulses(&format!("oscillator_{token}_reset_port"), inputs.on("reset"));
    e.declarations.extend(reset_binding.declarations.iter().cloned());
    e.loop_body.extend(reset_binding.loop_lines.iter().cloned());
    if let Some(any) = reset_binding.any_fired() {
        e.loop_body
            .push(format!("if ({any} && {running}) {{ {start} = millis(); }}"));
    }

    e.loop_body.push(format!("if ({running}) {{"));
    e.loop_body.extend(sample_lines.iter().map(|l| format!("  {l}")));
    e.loop_body.push("}".to_string());
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
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
        let e = emit(&oscillator("osc-1", json!({ "waveform": "sinus", "period": 1000 })), &NodeInputs::default());
        assert!(e.loop_body.iter().any(|l| l.contains("millis() - oscillator_osc_1_start")));
        assert!(e.loop_body.iter().any(|l| l.contains("sin(")), "sinus waveform");
        assert!(!e.loop_body.iter().any(|l| l.contains("delay(")), "must not block");
    }

    #[test]
    fn oscillator_square_waveform() {
        let e = emit(&oscillator("osc-1", json!({ "waveform": "square" })), &NodeInputs::default());
        assert!(e.loop_body.iter().any(|l| l.contains("* 2.0 <")));
    }

    #[test]
    fn oscillator_sawtooth_and_triangle() {
        let saw = emit(&oscillator("osc-1", json!({ "waveform": "sawtooth" })), &NodeInputs::default());
        assert!(saw.loop_body.iter().any(|l| l.contains("2.0 /")));
        let tri = emit(&oscillator("osc-1", json!({ "waveform": "triangle" })), &NodeInputs::default());
        assert!(tri.loop_body.iter().any(|l| l.contains("4.0 /")));
    }

    #[test]
    fn oscillator_random_uses_amplitude_and_shift() {
        let e = emit(
            &oscillator("osc-1", json!({ "waveform": "random", "amplitude": 2.0, "shift": 1.0 })),
            &NodeInputs::default(),
        );
        assert!(e.loop_body.iter().any(|l| l.contains("random(")));
    }

    #[test]
    fn oscillator_clamps_zero_period() {
        let e = emit(&oscillator("osc-1", json!({ "period": 0 })), &NodeInputs::default());
        // Falls back to the default period rather than dividing by zero.
        assert!(e.loop_body.iter().any(|l| l.contains("1000.0")));
    }

    #[test]
    fn oscillator_seeds_start_in_setup() {
        let e = emit(&oscillator("osc-1", json!({})), &NodeInputs::default());
        assert!(e.setup.iter().any(|s| s.contains("= millis()")));
        assert!(e.declarations.iter().any(|d| d.contains("double oscillator_osc_1_value")));
    }

    #[test]
    fn oscillator_gates_sampling_on_running() {
        let e = emit(&oscillator("osc-1", json!({})), &NodeInputs::default());
        assert!(
            e.loop_body.iter().any(|l| l.starts_with("if (oscillator_osc_1_running) {")),
            "sample block is gated on running"
        );
    }

    #[test]
    fn oscillator_start_stop_reset_ports_gate_the_signal() {
        use crate::codegen::wire::{CppExpr, SourceExpr};
        let mut inputs = NodeInputs::default();
        inputs.add("start", SourceExpr::level(CppExpr::boolean("go")));
        inputs.add("stop", SourceExpr::level(CppExpr::boolean("halt")));
        inputs.add("reset", SourceExpr::level(CppExpr::boolean("again")));
        let e = emit(&oscillator("osc-1", json!({})), &inputs);
        let body = e.loop_body.join("\n");
        assert!(body.contains("oscillator_osc_1_running = true"), "start runs: {body}");
        assert!(body.contains("oscillator_osc_1_running = false"), "stop halts: {body}");
        assert!(
            body.contains("&& oscillator_osc_1_running) { oscillator_osc_1_start = millis(); }"),
            "reset re-bases only while running: {body}"
        );
    }

    #[test]
    fn oscillator_emits_deterministically() {
        let n = oscillator("osc-1", json!({ "waveform": "square", "period": 500 }));
        assert_eq!(emit(&n, &NodeInputs::default()), emit(&n, &NodeInputs::default()));
    }
}
