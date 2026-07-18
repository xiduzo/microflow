//! Midi emitter — the on-device counterpart of `runtime/cloud/midi.rs`.
//!
//! The live Midi node speaks to host MIDI ports (Web MIDI / `midir`). On-device
//! there is no host: the generated sketch speaks **serial MIDI** (the DIN-5 jack
//! / MIDI shield convention, 31250 baud on the board's primary hardware serial)
//! via the ubiquitous `FortySevenEffects` Arduino MIDI Library (`MIDI.h`),
//! `MIDI_CREATE_DEFAULT_INSTANCE()`. The node's `deviceName` filter is
//! meaningless here — the jack IS the device — and validation warns that the
//! hardware UART is claimed.
//!
//! Several Midi nodes share ONE `MIDI` instance, one `MIDI.begin`, and one
//! read-pump per scheduler tick — emitted through the assembler's shared-block
//! regions ([`NodeEmission::shared_declarations`] etc.), which de-duplicate by
//! block equality. The pump mirrors the hosts' fan-out: it parses one inbound
//! message per tick into shared rx state that every in-node then filters
//! exactly like the runtime's `receive_raw_message` (channel, mode, control).
//!
//! Like every emitter this is a pure function of the [`FlowNode`]: identical
//! input yields byte-identical output (determinism invariant).

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::{bind_pulses, CppExpr, NodeInputs, SourceExpr};
use crate::config::midi::{MidiConfig, MidiDirection, MidiMode};
use crate::flow::FlowNode;

/// The shared `MIDI` instance + inbound rx state + the once-per-tick pump.
/// One block, deduplicated across every Midi node in the flow.
const SHARED_DECLS: &str = "\
MIDI_CREATE_DEFAULT_INSTANCE();
byte midi_rx_type = 0;
byte midi_rx_channel = 0;
byte midi_rx_data1 = 0;
byte midi_rx_data2 = 0;
bool midi_rx_fresh = false;
void midi_pump() {
  midi_rx_fresh = MIDI.read();
  if (midi_rx_fresh) {
    midi_rx_type = (byte)MIDI.getType();
    midi_rx_channel = (byte)MIDI.getChannel();
    midi_rx_data1 = (byte)MIDI.getData1();
    midi_rx_data2 = (byte)MIDI.getData2();
  }
}";

/// Shared boot: listen omni (each in-node filters its own channel, mirroring
/// the runtime) and disable the library's default soft-thru echo.
const SHARED_SETUP: &str = "\
MIDI.begin(MIDI_CHANNEL_OMNI);
MIDI.turnThruOff();";

/// The pump runs once per tick, before every in-node reads the rx state.
const SHARED_LOOP: &str = "midi_pump();";

fn config_of(node: &FlowNode) -> MidiConfig {
    serde_json::from_value(node.data.clone()).unwrap_or_default()
}

/// The send channel: the runtime clamps 1-16 (0/omni is receive-only).
fn send_channel(config: &MidiConfig) -> u8 {
    config.channel.clamp(1, 16)
}

/// Emit C++ for a Midi Node. In-direction filters the shared rx state into
/// node-scoped variables (the exact port of `Midi::receive_raw_message`);
/// out-direction sends one message per new sample on the `send` port (the
/// on-device twin of one dispatch == one `MidiSend`).
#[must_use]
pub fn emit(node: &FlowNode, inputs: &NodeInputs) -> NodeEmission {
    let config = config_of(node);
    let mut e = NodeEmission {
        includes: vec!["#include <MIDI.h>".to_string()],
        shared_declarations: vec![SHARED_DECLS.to_string()],
        shared_setup: vec![SHARED_SETUP.to_string()],
        ..NodeEmission::default()
    };

    match config.direction {
        MidiDirection::In => emit_in(node, &config, &mut e),
        MidiDirection::Out => emit_out(node, &config, inputs, &mut e),
    }
    e
}

fn emit_in(node: &FlowNode, config: &MidiConfig, e: &mut NodeEmission) {
    let token = node.id_token();
    e.shared_loop.push(SHARED_LOOP.to_string());

    // Channel filter mirrors `Midi::channel_matches` (0 = omni).
    let channel_ok = if config.channel == 0 {
        String::new()
    } else {
        format!(" && midi_rx_channel == {}", config.channel)
    };

    match config.mode {
        MidiMode::Note => {
            e.declarations.extend([
                format!("byte midi_{token}_note = 0;"),
                format!("byte midi_{token}_velocity = 0;"),
                format!("bool midi_{token}_gate = false;"),
            ]);
            // NoteOn (0x90) with velocity 0 is a NoteOff by MIDI convention,
            // exactly as the runtime treats it.
            e.loop_body.extend([
                format!("if (midi_rx_fresh{channel_ok}) {{"),
                format!("  if (midi_rx_type == 0x90 && midi_rx_data2 > 0) {{ midi_{token}_note = midi_rx_data1; midi_{token}_velocity = midi_rx_data2; midi_{token}_gate = true; }}"),
                format!("  else if (midi_rx_type == 0x80 || midi_rx_type == 0x90) {{ midi_{token}_note = midi_rx_data1; midi_{token}_velocity = 0; midi_{token}_gate = false; }}"),
                "}".to_string(),
            ]);
        }
        MidiMode::Cc => {
            e.declarations.push(format!("byte midi_{token}_value = 0;"));
            e.loop_body.extend([
                format!(
                    "if (midi_rx_fresh{channel_ok} && midi_rx_type == 0xB0 && midi_rx_data1 == {}) {{",
                    config.control
                ),
                format!("  midi_{token}_value = midi_rx_data2;"),
                "}".to_string(),
            ]);
        }
        // Song is an out-only playback mode; an in-node has nothing to filter.
        MidiMode::Song => {}
    }
}

fn emit_out(node: &FlowNode, config: &MidiConfig, inputs: &NodeInputs, e: &mut NodeEmission) {
    let token = node.id_token();
    let channel = send_channel(config);

    // Song playback is sequenced on the host clock and has no generated
    // counterpart (same as the Piezo song). On-device a song-configured out-node
    // degrades to the base note on the `send` port.
    if config.mode == MidiMode::Song {
        e.declarations.push(
            "// note: MIDI song playback is host-only; on-device the trigger sends the base note"
                .to_string(),
        );
    }

    let sources = inputs.on("send");
    let binding = bind_pulses(&format!("midi_{token}_send"), sources);
    e.declarations.extend(binding.declarations.iter().cloned());
    e.loop_body.extend(binding.loop_lines.iter().cloned());
    if binding.fired.is_empty() {
        e.loop_body
            .push(format!("// midi Node {token} has no wired send input — nothing to send"));
    }
    for (fired, source) in binding.fired.iter().zip(sources) {
        match config.mode {
            // CC: clamp the firing sample to 0-127, mirror of `Midi::encode`.
            MidiMode::Cc => e.loop_body.push(format!(
                "if ({fired}) {{ MIDI.sendControlChange({}, (byte)constrain((int)({}), 0, 127), {channel}); }}",
                config.control,
                source.value.as_double_or("0.0"),
            )),
            // Note (and the song degrade): truthy sample → note-on at the
            // configured velocity, falsy → note-off.
            MidiMode::Note | MidiMode::Song => e.loop_body.push(format!(
                "if ({fired}) {{ if ({}) {{ MIDI.sendNoteOn({}, {}, {channel}); }} else {{ MIDI.sendNoteOff({}, 0, {channel}); }} }}",
                source.value.as_bool(),
                config.note,
                config.velocity,
                config.note,
            )),
        }
    }
}

/// What downstream Nodes read from an in-direction Midi Node, per emit handle —
/// the codegen twin of the runtime's emits. Out-direction exposes nothing.
#[must_use]
pub fn output(node: &FlowNode, handle: &str) -> Option<SourceExpr> {
    let config = config_of(node);
    if config.direction == MidiDirection::Out {
        return None;
    }
    let token = node.id_token();
    match (config.mode, handle) {
        (MidiMode::Note, "note") => {
            Some(SourceExpr::level(CppExpr::number(format!("(double)midi_{token}_note"))))
        }
        // The runtime keeps `value` = the latest velocity in note mode.
        (MidiMode::Note, "velocity" | "value") => {
            Some(SourceExpr::level(CppExpr::number(format!("(double)midi_{token}_velocity"))))
        }
        (MidiMode::Note, "on") => {
            Some(SourceExpr::rising(CppExpr::boolean(format!("midi_{token}_gate"))))
        }
        (MidiMode::Note, "off") => {
            Some(SourceExpr::rising(CppExpr::boolean(format!("!midi_{token}_gate"))))
        }
        (MidiMode::Cc, "value") => {
            Some(SourceExpr::level(CppExpr::number(format!("(double)midi_{token}_value"))))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn midi(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Midi".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn send_input(expr: &str) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add("send", SourceExpr::level(CppExpr::number(expr)));
        inputs
    }

    #[test]
    fn every_direction_shares_one_instance_setup_and_includes() {
        for data in [json!({ "direction": "in" }), json!({ "direction": "out" })] {
            let e = emit(&midi("m-1", data), &NodeInputs::default());
            assert!(e.includes.iter().any(|i| i.contains("MIDI.h")));
            assert_eq!(e.shared_declarations, vec![SHARED_DECLS.to_string()]);
            assert_eq!(e.shared_setup, vec![SHARED_SETUP.to_string()]);
        }
    }

    #[test]
    fn in_note_mode_filters_the_pumped_message_like_the_runtime() {
        let e = emit(
            &midi("m-1", json!({ "direction": "in", "mode": "note", "channel": 2 })),
            &NodeInputs::default(),
        );
        let body = e.loop_body.join("\n");
        assert_eq!(e.shared_loop, vec![SHARED_LOOP.to_string()], "in-nodes arm the pump");
        assert!(body.contains("midi_rx_channel == 2"), "channel filter: {body}");
        assert!(body.contains("midi_rx_type == 0x90 && midi_rx_data2 > 0"), "note-on: {body}");
        assert!(
            body.contains("midi_rx_type == 0x80 || midi_rx_type == 0x90"),
            "note-off incl. velocity-0 note-on: {body}"
        );
    }

    #[test]
    fn in_omni_channel_has_no_channel_filter() {
        let e = emit(&midi("m-1", json!({ "direction": "in", "channel": 0 })), &NodeInputs::default());
        assert!(!e.loop_body.join("\n").contains("midi_rx_channel"), "omni filters nothing");
    }

    #[test]
    fn in_cc_mode_latches_only_its_control() {
        let e = emit(
            &midi("m-1", json!({ "direction": "in", "mode": "cc", "control": 7 })),
            &NodeInputs::default(),
        );
        let body = e.loop_body.join("\n");
        assert!(body.contains("midi_rx_type == 0xB0 && midi_rx_data1 == 7"), "{body}");
        assert!(body.contains("midi_m_1_value = midi_rx_data2"), "{body}");
    }

    #[test]
    fn out_cc_sends_clamped_control_change_per_new_sample() {
        let e = emit(
            &midi("m-1", json!({ "direction": "out", "mode": "cc", "control": 7, "channel": 2 })),
            &send_input("pot_p_1_value"),
        );
        let body = e.loop_body.join("\n");
        assert!(body.contains("sendControlChange(7, (byte)constrain((int)("), "clamped CC send: {body}");
        assert!(body.contains("pot_p_1_value"), "sends the wired sample: {body}");
        assert!(body.contains(", 0, 127), 2)"), "clamps to 0-127 on channel 2: {body}");
        assert!(body.contains("!= midi_m_1_send_prev0"), "sends once per new sample: {body}");
        assert!(e.shared_loop.is_empty(), "out-nodes do not arm the pump");
    }

    #[test]
    fn out_note_maps_truthy_to_on_and_falsy_to_off() {
        let e = emit(
            &midi("m-1", json!({ "direction": "out", "mode": "note", "note": 64, "velocity": 90 })),
            &send_input("btn_b_1_value"),
        );
        let body = e.loop_body.join("\n");
        assert!(body.contains("sendNoteOn(64, 90, 1)"), "{body}");
        assert!(body.contains("sendNoteOff(64, 0, 1)"), "{body}");
    }

    #[test]
    fn output_maps_in_handles_and_out_exposes_nothing() {
        let note_in = midi("m-1", json!({ "direction": "in", "mode": "note" }));
        assert_eq!(output(&note_in, "note").map(|s| s.value.code), Some("(double)midi_m_1_note".into()));
        assert_eq!(
            output(&note_in, "velocity").map(|s| s.value.code),
            Some("(double)midi_m_1_velocity".into())
        );
        assert_eq!(output(&note_in, "on").map(|s| s.value.code), Some("midi_m_1_gate".into()));
        assert_eq!(output(&note_in, "off").map(|s| s.value.code), Some("!midi_m_1_gate".into()));

        let cc_in = midi("m-1", json!({ "direction": "in", "mode": "cc" }));
        assert_eq!(output(&cc_in, "value").map(|s| s.value.code), Some("(double)midi_m_1_value".into()));
        assert!(output(&cc_in, "note").is_none(), "cc mode exposes only value");

        let out = midi("m-1", json!({ "direction": "out" }));
        assert!(output(&out, "value").is_none());
    }

    #[test]
    fn emits_deterministically() {
        let n = midi("m-1", json!({ "direction": "out", "mode": "cc" }));
        assert_eq!(emit(&n, &send_input("v")), emit(&n, &send_input("v")));
    }
}
