//! Piezo emitter — mirrors `nodes/piezo/runtime.rs`.
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
//!
//! The Piezo emits on `value` whether it is sounding: `true` from the trigger
//! until the buzz's `duration` has passed or `stop` silences it, as the
//! runtime's playback chain sets it. The sketch keeps that flag and the
//! `millis()` the buzz began, and lets the flag fall when `tone()`'s own
//! timer does. A buzz of 0 ms is silent on both sides: the sketch never calls
//! `tone()` without a duration, which would sound until `noTone()`.

use super::config::{PiezoConfig, PiezoType};
use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{CppExpr, NodeInputs, SourceExpr};
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;

/// Whether the Piezo is sounding.
fn playing_var(node: &FlowNode) -> String {
    format!("piezo_{}_playing", node.id_token())
}

/// What the Piezo emits on `value`: whether it is sounding.
#[must_use]
pub(crate) fn output(node: &FlowNode) -> SourceExpr {
    SourceExpr::level(CppExpr::boolean(playing_var(node)))
}

/// The pin this Piezo is emitted on — the same resolution `emit` uses, exposed
/// so validation can never drift from emission.
pub(crate) fn pin(node: &FlowNode) -> Result<u8, UnreadableConfig> {
    Ok(resolve::<PiezoConfig>(&node.data)?.pin)
}

/// Emit C++ for a Piezo Node. Unwired, it stays silent.
pub(crate) fn emit(node: &FlowNode, inputs: &NodeInputs) -> Result<NodeEmission, UnreadableConfig> {
    let token = node.id_token();
    let pin_var = format!("piezo_{token}_pin");
    let config = resolve::<PiezoConfig>(&node.data)?;
    let pin = config.pin;
    let frequency = config.frequency;
    let duration = config.duration;

    let playing = playing_var(node);
    let started = format!("piezo_{token}_started");

    let mut e = NodeEmission {
        declarations: vec![
            format!("const uint8_t {pin_var} = {pin};"),
            format!("bool {playing} = false;"),
        ],
        setup: vec![
            format!("pinMode({pin_var}, OUTPUT);"),
            // Mirror runtime initialize: silent at start.
            format!("noTone({pin_var});"),
        ],
        ..NodeEmission::default()
    };

    // trigger: one buzz per firing source. Song playback is host-only.
    let trigger_sources = inputs.on("trigger");
    if duration == 0 && !trigger_sources.is_empty() {
        // `tone()` without a duration sounds until `noTone()`; the runtime's
        // buzz of 0 ms sounds nothing, and so does the sketch.
        e.declarations.push("// note: a buzz of 0 ms is silent, so 'trigger' sounds nothing".to_string());
        return Ok(bind_stop(e, &token, &pin_var, &playing, inputs));
    }
    if !trigger_sources.is_empty() {
        // The buzz is over once its duration has passed — `tone()` stops on
        // its own timer then, as the runtime's last `_note` wakeup does. This
        // runs before a new trigger, which starts a fresh buzz; a trigger
        // while it sounds starts the buzz over and `value` stays true, as the
        // runtime restarts its playback.
        e.declarations.push(format!("unsigned long {started} = 0;"));
        e.loop_body.push(format!(
            "if ({playing} && millis() - {started} >= {duration}UL) {{ {playing} = false; }}"
        ));
    }
    let trigger_binding = e.bind_port(&format!("piezo_{token}_trigger"), trigger_sources);
    if let Some(any) = trigger_binding.any_fired() {
        if config.r#type == PiezoType::Song {
            e.declarations.push(
                "// note: song playback is not generated on-device; the trigger buzzes the base frequency instead, and `value` is true while that buzz sounds"
                    .to_string(),
            );
        }
        // tone() is non-blocking — it drives a hardware timer and returns at once.
        e.loop_body.push(format!(
            "if ({any}) {{ tone({pin_var}, {frequency}, {duration}); {playing} = true; {started} = millis(); }}"
        ));
    }

    Ok(bind_stop(e, &token, &pin_var, &playing, inputs))
}

/// `stop`: silence on any firing source.
fn bind_stop(mut e: NodeEmission, token: &str, pin_var: &str, playing: &str, inputs: &NodeInputs) -> NodeEmission {
    let stop_binding = e.bind_port(&format!("piezo_{token}_stop"), inputs.on("stop"));
    if let Some(any) = stop_binding.any_fired() {
        e.loop_body
            .push(format!("if ({any}) {{ noTone({pin_var}); {playing} = false; }}"));
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
        let e = emit(&piezo("pz-1", json!({ "pin": 11 })), &NodeInputs::default()).unwrap();
        assert!(e.setup.iter().any(|s| s.contains("pinMode") && s.contains("OUTPUT")));
        assert!(e.setup.iter().any(|s| s.contains("noTone")));
    }

    #[test]
    fn piezo_sounds_configured_frequency_once_per_trigger_pulse() {
        let e = emit(
            &piezo("pz-1", json!({ "frequency": 880, "duration": 250 })),
            &on("trigger", CppExpr::boolean("btn_state")),
        ).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains("tone(") && body.contains("880") && body.contains("250"), "{body}");
        assert!(
            body.contains("!= piezo_pz_1_trigger_prev0"),
            "one-shot per trigger change, not every truthy tick: {body}"
        );
    }

    #[test]
    fn stop_port_silences_the_buzzer() {
        let e = emit(&piezo("pz-1", json!({})), &on("stop", CppExpr::boolean("halt"))).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("noTone(piezo_pz_1_pin)")));
    }

    #[test]
    fn piezo_is_non_blocking() {
        let e = emit(&piezo("pz-1", json!({})), &on("trigger", CppExpr::boolean("v"))).unwrap();
        assert!(!e.loop_body.iter().any(|l| l.contains("delay(")), "piezo must not block");
    }

    #[test]
    fn piezo_uses_default_frequency() {
        let e = emit(&piezo("pz-1", json!({})), &on("trigger", CppExpr::boolean("v"))).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("440")));
    }

    #[test]
    fn song_configuration_is_noted() {
        let e = emit(&piezo("pz-1", json!({ "type": "song" })), &on("trigger", CppExpr::boolean("v"))).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("song playback")));
    }

    #[test]
    fn piezo_emits_deterministically() {
        let n = piezo("pz-1", json!({ "frequency": 440 }));
        let inputs = on("trigger", CppExpr::boolean("v"));
        assert_eq!(emit(&n, &inputs).unwrap(), emit(&n, &inputs).unwrap());
    }
}
