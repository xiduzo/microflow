//! Stepper emitter — mirrors `runtime/output/stepper.rs`.
//!
//! The live Stepper drives a stepper motor through Firmata's `AccelStepper`
//! protocol — configuring the interface (step/direction driver or 4-wire), max
//! speed and acceleration, then moving to absolute/relative positions. The
//! generated sketch uses the Arduino `AccelStepper` library directly: it
//! `#include <AccelStepper.h>`, declares the motor with the matching interface
//! and pins, sets max speed + acceleration in `setup()`, and — when wired from
//! an upstream value — targets that position and calls `run()` every loop. `run()`
//! steps at most once per call and returns immediately, so motion is fully
//! non-blocking and other Nodes keep ticking.

use crate::codegen::emit::{cpp_double, NodeEmission, NodeToken};
use crate::config::stepper::StepperConfig;
use crate::flow::FlowNode;

/// Emit C++ for a Stepper Node. `driver` is an optional target-position
/// expression (absolute step count); `None` leaves the motor parked at zero.
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
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

    if let Some(expr) = driver {
        // Non-blocking: moveTo sets the target, run() steps at most once per call.
        e.loop_body.push(format!("{obj}.moveTo((long)({expr}));"));
    }
    // The motor must keep stepping toward its target every loop, even when
    // unconnected (no-op until a target is set), so always emit run().
    e.loop_body.push(format!("{obj}.run();"));
    e
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn stepper_includes_library_and_declares_motor() {
        let e = emit(&stepper("st-1", json!({})), None);
        assert!(e.includes.iter().any(|i| i.contains("AccelStepper.h")));
        assert!(e.declarations.iter().any(|d| d.contains("AccelStepper stepper_st_1(AccelStepper::DRIVER, 2, 3)")));
    }

    #[test]
    fn stepper_sets_speed_and_acceleration() {
        let e = emit(&stepper("st-1", json!({ "speed": 800, "acceleration": 200 })), None);
        assert!(e.setup.iter().any(|s| s.contains("setMaxSpeed(800")));
        assert!(e.setup.iter().any(|s| s.contains("setAcceleration(200")));
    }

    #[test]
    fn stepper_targets_value_and_runs_non_blocking() {
        let e = emit(&stepper("st-1", json!({})), Some("sensor_x_value"));
        assert!(e.loop_body.iter().any(|l| l.contains("moveTo") && l.contains("sensor_x_value")));
        assert!(e.loop_body.iter().any(|l| l.contains(".run()")));
        assert!(!e.loop_body.iter().any(|l| l.contains("delay(")), "stepper must not block");
    }

    #[test]
    fn stepper_runs_even_when_unconnected() {
        let e = emit(&stepper("st-1", json!({})), None);
        assert!(e.loop_body.iter().any(|l| l.contains(".run()")));
    }

    #[test]
    fn stepper_emits_deterministically() {
        let n = stepper("st-1", json!({ "speed": 1000 }));
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }
}
