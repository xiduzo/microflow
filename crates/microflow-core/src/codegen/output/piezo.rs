//! Piezo emitter — mirrors `runtime/output/piezo.rs`.
//!
//! The live Piezo buzzer plays a tone by toggling its pin at the note's
//! half-period (the Johnny-Five approach). The Arduino core exposes exactly this
//! via the built-in `tone(pin, frequency, duration)` / `noTone(pin)`, which is
//! non-blocking (it runs off a hardware timer). The generated sketch sets the
//! pin OUTPUT, and — when triggered from an upstream signal — sounds the
//! configured frequency for the configured duration, falling silent otherwise.
//! No blocking `delay()` is used: `tone(...)` returns immediately.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::config::piezo::PiezoConfig;
use crate::flow::FlowNode;

/// Emit C++ for a Piezo Node. `driver` is an optional boolean trigger: while
/// true the buzzer sounds, otherwise it is silenced.
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let token = node.id_token();
    let pin_var = format!("piezo_{token}_pin");
    let config: PiezoConfig = serde_json::from_value(node.data.clone()).unwrap_or_default();
    let pin = config.pin;
    let frequency = config.frequency;
    let duration = config.duration;

    let mut e = NodeEmission {
        declarations: vec![format!("const uint8_t {pin_var} = {pin};")],
        setup: vec![
            format!("pinMode({pin_var}, OUTPUT);"),
            // Mirror runtime initialize: silent at start.
            format!("noTone({pin_var});"),
        ],
        ..NodeEmission::default()
    };

    if let Some(expr) = driver {
        e.loop_body.push(format!("if ({expr}) {{"));
        // tone() is non-blocking — it drives a hardware timer and returns at once.
        e.loop_body
            .push(format!("  tone({pin_var}, {frequency}, {duration});"));
        e.loop_body.push("} else {".to_string());
        e.loop_body.push(format!("  noTone({pin_var});"));
        e.loop_body.push("}".to_string());
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn piezo(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Piezo".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    #[test]
    fn piezo_sets_output_and_starts_silent() {
        let e = emit(&piezo("pz-1", json!({ "pin": 11 })), None);
        assert!(e.setup.iter().any(|s| s.contains("pinMode") && s.contains("OUTPUT")));
        assert!(e.setup.iter().any(|s| s.contains("noTone")));
    }

    #[test]
    fn piezo_sounds_configured_frequency_when_triggered() {
        let e = emit(&piezo("pz-1", json!({ "frequency": 880, "duration": 250 })), Some("btn_state"));
        assert!(e.loop_body.iter().any(|l| l.contains("tone(") && l.contains("880") && l.contains("250")));
    }

    #[test]
    fn piezo_is_non_blocking() {
        let e = emit(&piezo("pz-1", json!({})), Some("v"));
        assert!(!e.loop_body.iter().any(|l| l.contains("delay(")), "piezo must not block");
    }

    #[test]
    fn piezo_uses_default_frequency() {
        let e = emit(&piezo("pz-1", json!({})), Some("v"));
        assert!(e.loop_body.iter().any(|l| l.contains("440")));
    }

    #[test]
    fn piezo_emits_deterministically() {
        let n = piezo("pz-1", json!({ "frequency": 440 }));
        assert_eq!(emit(&n, Some("v")), emit(&n, Some("v")));
    }
}
