//! Piezo emitter — mirrors `runtime/output/piezo.rs`.
//!
//! The live Piezo exposes a `trigger` port (buzz the configured frequency for
//! the configured duration, or start the configured song) and a `stop` port.
//! The Arduino core provides exactly the buzz primitive via the built-in
//! `tone(pin, frequency, duration)` / `noTone(pin)`, which is non-blocking (it
//! runs off a hardware timer). The generated sketch sets the pin OUTPUT and
//! binds both ports as pulses: one `tone(...)` per trigger firing — the
//! one-shot twin of the runtime's buzz-per-event — and `noTone` on stop.
//! Song playback walks a scheduled note queue on the host and has no
//! generated counterpart yet; a song-configured Node emits an explicit note.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, NodeInputs};
use crate::config::piezo::PiezoConfig;
use crate::flow::FlowNode;

/// True when the Node is configured as a song player rather than a buzzer.
fn is_song(node: &FlowNode) -> bool {
    node.data
        .get("type")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|t| t.eq_ignore_ascii_case("song"))
}

/// Emit C++ for a Piezo Node. Unwired, it stays silent.
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
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

    // trigger: one buzz per firing source. Song playback is host-only.
    let trigger_binding = bind_pulses(&format!("piezo_{token}_trigger"), inputs.on("trigger"));
    e.declarations.extend(trigger_binding.declarations.iter().cloned());
    e.loop_body.extend(trigger_binding.loop_lines.iter().cloned());
    if let Some(any) = trigger_binding.any_fired() {
        if is_song(node) {
            e.declarations.push(
                "// note: song playback is not generated on-device; the trigger buzzes the base frequency instead"
                    .to_string(),
            );
        }
        // tone() is non-blocking — it drives a hardware timer and returns at once.
        e.loop_body
            .push(format!("if ({any}) {{ tone({pin_var}, {frequency}, {duration}); }}"));
    }

    // stop: silence on any firing source.
    let stop_binding = bind_pulses(&format!("piezo_{token}_stop"), inputs.on("stop"));
    e.declarations.extend(stop_binding.declarations.iter().cloned());
    e.loop_body.extend(stop_binding.loop_lines.iter().cloned());
    if let Some(any) = stop_binding.any_fired() {
        e.loop_body.push(format!("if ({any}) {{ noTone({pin_var}); }}"));
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
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

    fn on(port: &str, expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add(port, SourceExpr::level(expr));
        inputs
    }

    #[test]
    fn piezo_sets_output_and_starts_silent() {
        let e = emit(&piezo("pz-1", json!({ "pin": 11 })), &NodeInputs::default());
        assert!(e.setup.iter().any(|s| s.contains("pinMode") && s.contains("OUTPUT")));
        assert!(e.setup.iter().any(|s| s.contains("noTone")));
    }

    #[test]
    fn piezo_sounds_configured_frequency_once_per_trigger_pulse() {
        let e = emit(
            &piezo("pz-1", json!({ "frequency": 880, "duration": 250 })),
            &on("trigger", CppExpr::boolean("btn_state")),
        );
        let body = e.loop_body.join("\n");
        assert!(body.contains("tone(") && body.contains("880") && body.contains("250"), "{body}");
        assert!(
            body.contains("!= piezo_pz_1_trigger_prev0"),
            "one-shot per trigger change, not every truthy tick: {body}"
        );
    }

    #[test]
    fn stop_port_silences_the_buzzer() {
        let e = emit(&piezo("pz-1", json!({})), &on("stop", CppExpr::boolean("halt")));
        assert!(e.loop_body.iter().any(|l| l.contains("noTone(piezo_pz_1_pin)")));
    }

    #[test]
    fn piezo_is_non_blocking() {
        let e = emit(&piezo("pz-1", json!({})), &on("trigger", CppExpr::boolean("v")));
        assert!(!e.loop_body.iter().any(|l| l.contains("delay(")), "piezo must not block");
    }

    #[test]
    fn piezo_uses_default_frequency() {
        let e = emit(&piezo("pz-1", json!({})), &on("trigger", CppExpr::boolean("v")));
        assert!(e.loop_body.iter().any(|l| l.contains("440")));
    }

    #[test]
    fn song_configuration_is_noted() {
        let e = emit(&piezo("pz-1", json!({ "type": "song" })), &on("trigger", CppExpr::boolean("v")));
        assert!(e.declarations.iter().any(|d| d.contains("song playback")));
    }

    #[test]
    fn piezo_emits_deterministically() {
        let n = piezo("pz-1", json!({ "frequency": 440 }));
        let inputs = on("trigger", CppExpr::boolean("v"));
        assert_eq!(emit(&n, &inputs), emit(&n, &inputs));
    }
}
