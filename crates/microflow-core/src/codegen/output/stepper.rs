//! Stepper emitter — mirrors `runtime/output/stepper.rs`.
//!
//! The live Stepper drives a stepper motor through Firmata's `AccelStepper`
//! protocol; its ports are `value` (a *relative* move of that many steps, one
//! move per received sample, zero-step samples skipped), `to` (an absolute
//! target), `stop`, `zero` (reset the current position to 0), and `enable`
//! (energize/de-energize the outputs, truthy ⇢ enabled). The generated sketch
//! uses the Arduino `AccelStepper` library directly with the matching port
//! semantics: `value` issues `move(steps)` on each new sample, `to` targets
//! `moveTo(position)`, and `run()` is called every loop — it steps at most
//! once per call and returns immediately, so motion is fully non-blocking and
//! other Nodes keep ticking.

use crate::codegen::emit::{cpp_double, NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, extra_sources_note, NodeInputs};
use crate::config::stepper::StepperConfig;
use crate::flow::FlowNode;

/// Emit C++ for a Stepper Node. Unwired, the motor parks at zero.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let token = node.id_token();
    let obj = format!("stepper_{token}");
    let config: StepperConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    let step_pin = config.step_pin;
    let dir_pin = config.dir_pin;
    // Runtime stores speed/acceleration as floats; widen to the f64 the C++
    // literal formatter expects.
    let speed = cpp_double(f64::from(config.speed));
    let acceleration = cpp_double(f64::from(config.acceleration));

    let mut e = NodeEmission {
        includes: vec!["#include <AccelStepper.h>".to_string()],
        declarations: vec![format!(
            "AccelStepper {obj}(AccelStepper::DRIVER, {step_pin}, {dir_pin});"
        )],
        setup: vec![
            format!("{obj}.setMaxSpeed({speed});"),
            format!("{obj}.setAcceleration({acceleration});"),
        ],
        ..NodeEmission::default()
    };

    // value: one relative move per new sample; zero steps are skipped.
    let value_sources = inputs.on("value");
    if let Some(note) = extra_sources_note("value", value_sources) {
        e.declarations.push(note);
    }
    if let Some(source) = value_sources.first() {
        let binding = bind_pulses(&format!("stepper_{token}_value"), &value_sources[..1]);
        e.declarations.extend(binding.declarations.iter().cloned());
        e.loop_body.extend(binding.loop_lines.iter().cloned());
        let fired = &binding.fired[0];
        let steps = format!("stepper_{token}_steps");
        e.loop_body.push(format!("if ({fired}) {{"));
        e.loop_body
            .push(format!("  long {steps} = (long)({});", source.value.as_double()));
        e.loop_body
            .push(format!("  if ({steps} != 0) {{ {obj}.move({steps}); }}"));
        e.loop_body.push("}".to_string());
    }

    // to: an absolute target; a level write is idempotent, like repeated CMD_TO.
    let to_sources = inputs.on("to");
    if let Some(note) = extra_sources_note("to", to_sources) {
        e.declarations.push(note);
    }
    if let Some(source) = to_sources.first() {
        e.loop_body
            .push(format!("{obj}.moveTo((long)({}));", source.value.as_double()));
    }

    // stop / zero: pulses.
    let binding = bind_pulses(&format!("stepper_{token}_stop"), inputs.on("stop"));
    e.declarations.extend(binding.declarations.iter().cloned());
    e.loop_body.extend(binding.loop_lines.iter().cloned());
    if let Some(any) = binding.any_fired() {
        e.loop_body.push(format!("if ({any}) {{ {obj}.stop(); }}"));
    }
    let binding = bind_pulses(&format!("stepper_{token}_zero"), inputs.on("zero"));
    e.declarations.extend(binding.declarations.iter().cloned());
    e.loop_body.extend(binding.loop_lines.iter().cloned());
    if let Some(any) = binding.any_fired() {
        e.loop_body
            .push(format!("if ({any}) {{ {obj}.setCurrentPosition(0); }}"));
    }

    // enable: energize per new sample's truthiness (runtime: n > 0).
    let enable_sources = inputs.on("enable");
    if let Some(note) = extra_sources_note("enable", enable_sources) {
        e.declarations.push(note);
    }
    if let Some(source) = enable_sources.first() {
        let binding = bind_pulses(&format!("stepper_{token}_enable"), &enable_sources[..1]);
        e.declarations.extend(binding.declarations.iter().cloned());
        e.loop_body.extend(binding.loop_lines.iter().cloned());
        let fired = &binding.fired[0];
        e.loop_body.push(format!(
            "if ({fired}) {{ if ({}) {{ {obj}.enableOutputs(); }} else {{ {obj}.disableOutputs(); }} }}",
            source.value.as_bool()
        ));
    }

    // The motor must keep stepping toward its target every loop, even when
    // unconnected (no-op until a target is set), so always emit run().
    e.loop_body.push(format!("{obj}.run();"));
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
    use crate::flow::Position;
    use serde_json::json;

    fn stepper(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Stepper".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn on(port: &str, expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add(port, SourceExpr::level(expr));
        inputs
    }

    #[test]
    fn stepper_includes_library_and_declares_motor() {
        let e = emit(&stepper("st-1", json!({})), &NodeInputs::default());
        assert!(e.includes.iter().any(|i| i.contains("AccelStepper.h")));
        assert!(e.declarations.iter().any(|d| d.contains("AccelStepper stepper_st_1(AccelStepper::DRIVER, 2, 3)")));
    }

    #[test]
    fn stepper_sets_speed_and_acceleration() {
        let e = emit(&stepper("st-1", json!({ "speed": 800, "acceleration": 200 })), &NodeInputs::default());
        assert!(e.setup.iter().any(|s| s.contains("setMaxSpeed(800")));
        assert!(e.setup.iter().any(|s| s.contains("setAcceleration(200")));
    }

    #[test]
    fn value_port_issues_relative_moves_per_sample() {
        let e = emit(&stepper("st-1", json!({})), &on("value", CppExpr::number("steps_src")));
        let body = e.loop_body.join("\n");
        assert!(body.contains(".move(stepper_st_1_steps)"), "relative move: {body}");
        assert!(body.contains("!= 0"), "zero-step samples skipped: {body}");
        assert!(body.contains("!="), "change-pulsed: {body}");
    }

    #[test]
    fn to_port_targets_absolute_position() {
        let e = emit(&stepper("st-1", json!({})), &on("to", CppExpr::number("target")));
        assert!(e.loop_body.iter().any(|l| l.contains(".moveTo((long)(((double)(target))))")));
    }

    #[test]
    fn stop_zero_and_enable_ports_are_bound() {
        let mut inputs = NodeInputs::default();
        inputs.add("stop", SourceExpr::level(CppExpr::boolean("halt")));
        inputs.add("zero", SourceExpr::level(CppExpr::boolean("z")));
        inputs.add("enable", SourceExpr::level(CppExpr::boolean("en")));
        let e = emit(&stepper("st-1", json!({})), &inputs);
        let body = e.loop_body.join("\n");
        assert!(body.contains(".stop()"), "{body}");
        assert!(body.contains(".setCurrentPosition(0)"), "{body}");
        assert!(body.contains(".enableOutputs()") && body.contains(".disableOutputs()"), "{body}");
    }

    #[test]
    fn stepper_runs_non_blocking_even_when_unconnected() {
        let e = emit(&stepper("st-1", json!({})), &NodeInputs::default());
        assert!(e.loop_body.iter().any(|l| l.contains(".run()")));
        assert!(!e.loop_body.iter().any(|l| l.contains("delay(")), "stepper must not block");
    }

    #[test]
    fn stepper_emits_deterministically() {
        let n = stepper("st-1", json!({ "speed": 1000 }));
        let inputs = on("value", CppExpr::number("v"));
        assert_eq!(emit(&n, &inputs), emit(&n, &inputs));
    }
}
