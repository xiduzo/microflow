//! MIDI host-peripheral node on core's [`Component`] trait.
//!
//! MIDI is not a cloud service, but it is mechanically the same sans-IO shape
//! (ADR-0009), and — like the Mqtt node — ONE node covers both directions:
//!
//! - **`direction = "in"`**: describes its interest via
//!   [`midi_wiring`](Component::midi_wiring) (a device-name filter the host uses
//!   to open MIDI inputs). The host feeds every raw 3-byte message through
//!   [`receive_raw_message`](Component::receive_raw_message) (`topic` = the host
//!   port name, `payload` = `[status, data1, data2]`); ALL parsing/filtering
//!   lives here in core so both hosts route bytes identically.
//! - **`direction = "out"`**: `dispatch("send")` records a
//!   [`CloudRequestKind::MidiSend`] for the host's `EffectsSink::perform_cloud`
//!   to write to the device.
//!
//! [`Component`]: crate::runtime::Component

use crate::runtime::{
    CloudRequestKind, Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext,
    RuntimeError,
};
use std::borrow::Cow;

pub use crate::config::midi::{MidiConfig, MidiDirection, MidiMode};

/// MIDI status nibbles (high 4 bits of the status byte).
const NOTE_OFF: u8 = 0x80;
const NOTE_ON: u8 = 0x90;
const CONTROL_CHANGE: u8 = 0xB0;

/// One flattened song step: a note (`None` = rest/silence) held for
/// `duration_ms`, played at its own `velocity`.
#[derive(Debug, Clone, Copy)]
struct SongStep {
    note: Option<u8>,
    duration_ms: u64,
    velocity: u8,
}

/// Map a Piezo-style note name (`"C4"`, `"F#5"`, sharps only) to a MIDI note
/// number, using the C4 = 60 convention (matching the node's default note).
/// Returns `None` for a rest, an unknown letter, or an out-of-range result.
fn note_name_to_midi(name: &str) -> Option<u8> {
    let bytes = name.trim().as_bytes();
    let semitone = match bytes.first()?.to_ascii_uppercase() {
        b'C' => 0,
        b'D' => 2,
        b'E' => 4,
        b'F' => 5,
        b'G' => 7,
        b'A' => 9,
        b'B' => 11,
        _ => return None,
    };
    let mut idx = 1;
    let semitone = if bytes.get(idx) == Some(&b'#') {
        idx += 1;
        semitone + 1
    } else {
        semitone
    };
    let octave: i32 = std::str::from_utf8(&bytes[idx..]).ok()?.parse().ok()?;
    let midi = (octave + 1) * 12 + semitone;
    u8::try_from(midi).ok().filter(|n| *n <= 127)
}

pub struct Midi {
    base: ComponentBase,
    config: MidiConfig,
    /// Flattened song queue, walked one step per `_note` wakeup. Empty when idle.
    steps: Vec<SongStep>,
    /// Index of the next step to play.
    cursor: usize,
    /// The note currently sounding, so the next step can note-off it first.
    sounding: Option<u8>,
    is_playing: bool,
}

impl Midi {
    pub const E_NOTE: &'static str = "note";
    pub const E_VELOCITY: &'static str = "velocity";
    pub const E_ON: &'static str = "on";
    pub const E_OFF: &'static str = "off";

    #[must_use]
    pub fn new(id: String, config: MidiConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            steps: Vec::new(),
            cursor: 0,
            sounding: None,
            is_playing: false,
        }
    }

    #[must_use]
    pub fn is_out(&self) -> bool {
        self.config.direction == MidiDirection::Out
    }

    /// Does `status`'s channel nibble pass this node's channel filter (0 = omni)?
    fn channel_matches(&self, status: u8) -> bool {
        self.config.channel == 0 || self.config.channel - 1 == (status & 0x0F)
    }

    /// The status byte for `nibble` on this node's send channel (1-16 → 0-15).
    fn status(&self, nibble: u8) -> u8 {
        nibble | (self.config.channel.clamp(1, 16) - 1)
    }

    /// The 3-byte message one `send` value produces. CC mode maps the number
    /// (clamped 0-127) onto the configured control; note mode maps truthy →
    /// note-on at the configured velocity, falsy → note-off.
    fn encode(&self, args: &ComponentValue) -> Vec<u8> {
        match self.config.mode {
            MidiMode::Cc => {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let n = args.as_number().unwrap_or(0.0).round().clamp(0.0, 127.0) as u8;
                vec![self.status(CONTROL_CHANGE), self.config.control, n]
            }
            MidiMode::Note if args.is_truthy() => {
                vec![self.status(NOTE_ON), self.config.note, self.config.velocity]
            }
            MidiMode::Note => vec![self.status(NOTE_OFF), self.config.note, 0],
            // Song playback issues its own messages via the wakeup chain, never
            // through `encode` (which is per-sample). Nothing to send here.
            MidiMode::Song => Vec::new(),
        }
    }

    fn emit_number(&mut self, handle: &str, n: u8) {
        self.base
            .emit_with_value(handle, Cow::Owned(ComponentValue::Number(f64::from(n))));
    }

    /// Record one raw MIDI message for the host to write (ADR-0009).
    fn send_bytes(&self, ctx: &mut RuntimeContext, bytes: Vec<u8>) {
        ctx.request_cloud(CloudRequestKind::MidiSend {
            device_name: self.config.device_name.clone(),
            bytes,
        });
    }

    /// Flatten the configured song into note/rest steps at the current tempo.
    fn build_steps(&self) -> Vec<SongStep> {
        let beat_ms = 60_000.0 / f64::from(self.config.tempo.max(1));
        self.config
            .song
            .iter()
            .map(|(name, beats, velocity)| {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let duration_ms = (beat_ms * beats).max(0.0) as u64;
                let note = name.as_deref().and_then(note_name_to_midi);
                SongStep { note, duration_ms, velocity: (*velocity).min(127) }
            })
            .collect()
    }

    /// (Re)start song playback: silence anything sounding, load the queue, and
    /// arm the first `_note` wakeup. The runtime delivers it as
    /// `dispatch_internal("note")`, which plays each step and chains the next.
    fn start_song(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        self.stop_song(ctx);
        self.steps = self.build_steps();
        if self.steps.is_empty() {
            return Ok(());
        }
        self.is_playing = true;
        self.base.set_value(ComponentValue::Number(1.0));
        ctx.schedule_wakeup("_note", 0);
        Ok(())
    }

    /// Note-off whatever is sounding, cancel the outstanding step wakeup, and
    /// reset to idle. Safe to call when already stopped.
    fn stop_song(&mut self, ctx: &mut RuntimeContext) {
        ctx.cancel_wakeup("_note");
        if let Some(note) = self.sounding.take() {
            self.send_bytes(ctx, vec![self.status(NOTE_OFF), note, 0]);
        }
        self.is_playing = false;
        self.steps.clear();
        self.cursor = 0;
        self.base.set_value(ComponentValue::Number(0.0));
    }

    /// Play the step at `cursor`: note-off the previous note, note-on the current
    /// one, and arm the next `_note` wakeup for its duration. Finalize when the
    /// queue is exhausted.
    fn advance(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        if !self.is_playing {
            return Ok(());
        }
        if let Some(note) = self.sounding.take() {
            self.send_bytes(ctx, vec![self.status(NOTE_OFF), note, 0]);
        }
        match self.steps.get(self.cursor).copied() {
            Some(step) => {
                self.cursor += 1;
                if let Some(note) = step.note {
                    self.send_bytes(ctx, vec![self.status(NOTE_ON), note, step.velocity]);
                    self.sounding = Some(note);
                }
                ctx.schedule_wakeup("_note", step.duration_ms);
            }
            None => {
                self.is_playing = false;
                self.base.set_value(ComponentValue::Number(0.0));
            }
        }
        Ok(())
    }
}

impl ComponentBuilder for Midi {
    type Config = MidiConfig;
    fn build(id: String, config: MidiConfig) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl Component for Midi {
    fn ports() -> &'static [&'static str] {
        &["send"]
    }

    fn emits() -> &'static [&'static str] {
        &[
            ComponentBase::VALUE_HANDLE,
            Self::E_NOTE,
            Self::E_VELOCITY,
            Self::E_ON,
            Self::E_OFF,
        ]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Midi"
    }

    fn midi_wiring(&self) -> Option<String> {
        if self.is_out() {
            return None;
        }
        Some(self.config.device_name.clone())
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "send" => {
                if !self.is_out() {
                    return Err(RuntimeError::ComponentError(
                        "This MIDI node is configured for in, not out".to_string(),
                    ));
                }
                // Song mode: a truthy sample (re)starts the sequence, a falsy one
                // stops it. Note/CC mode: one sample == one message.
                if self.config.mode == MidiMode::Song {
                    if args.is_truthy() {
                        return self.start_song(ctx);
                    }
                    self.stop_song(ctx);
                    return Ok(());
                }
                self.base.value = args.clone();
                // Sans-IO: record the message for the host to write (ADR-0009).
                ctx.request_cloud(CloudRequestKind::MidiSend {
                    device_name: self.config.device_name.clone(),
                    bytes: self.encode(&args),
                });
                Ok(())
            }
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    /// The self-scheduled `_note` wakeup that walks the song queue.
    fn dispatch_internal(
        &mut self,
        method: &str,
        _value: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "note" => self.advance(ctx),
            _ => Err(RuntimeError::ComponentError(format!(
                "Unknown internal method: {method}"
            ))),
        }
    }

    fn destroy(&mut self) {
        // No ctx here, so we cannot note-off; just drop playback state. The
        // host tears down its MIDI ports on flow teardown.
        self.is_playing = false;
        self.steps.clear();
        self.cursor = 0;
        self.sounding = None;
    }

    /// One raw MIDI message from the host (`payload` = `[status, data1, data2]`).
    /// Note mode: note-on emits `note` + `velocity` + `on`; note-off (incl. the
    /// running-status convention note-on @ velocity 0) emits `note` + `velocity 0`
    /// + `off`. CC mode: a matching control emits its value on `value`.
    fn receive_raw_message(&mut self, _topic: &str, payload: &[u8]) {
        let [status, data1, data2] = *payload else { return };
        if self.is_out() || !self.channel_matches(status) {
            return;
        }
        match (status & 0xF0, self.config.mode) {
            (NOTE_ON, MidiMode::Note) if data2 > 0 => {
                self.base.value = ComponentValue::Number(f64::from(data2));
                self.emit_number(Self::E_NOTE, data1);
                self.emit_number(Self::E_VELOCITY, data2);
                self.base
                    .emit_with_value(Self::E_ON, Cow::Owned(ComponentValue::Bool(true)));
            }
            (NOTE_ON | NOTE_OFF, MidiMode::Note) => {
                self.base.value = ComponentValue::Number(0.0);
                self.emit_number(Self::E_NOTE, data1);
                self.emit_number(Self::E_VELOCITY, 0);
                self.base
                    .emit_with_value(Self::E_OFF, Cow::Owned(ComponentValue::Bool(true)));
            }
            (CONTROL_CHANGE, MidiMode::Cc) if data1 == self.config.control => {
                self.base.set_value(ComponentValue::Number(f64::from(data2)));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::cloud::test_support::{recorded_cloud_requests, with_test_ctx};
    use crate::runtime::{ComponentEvent, EventSink};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;

    fn sink() -> EventSink {
        Rc::new(RefCell::new(VecDeque::new()))
    }

    fn drain(sink: &EventSink) -> Vec<ComponentEvent> {
        sink.borrow_mut().drain(..).collect()
    }

    fn note_in(channel: u8) -> Midi {
        let mut node = Midi::new(
            "in-1".into(),
            MidiConfig { channel, mode: MidiMode::Note, ..MidiConfig::default() },
        );
        node.set_sink(sink());
        node
    }

    fn handles(events: &[ComponentEvent]) -> Vec<&str> {
        events.iter().map(|e| e.source_handle.as_ref()).collect()
    }

    #[test]
    fn note_on_emits_note_velocity_and_on() {
        let mut node = note_in(0);
        let s = node.base.sink.clone().expect("sink");
        node.receive_raw_message("dev", &[0x90, 60, 100]);
        let events = drain(&s);
        assert_eq!(handles(&events), vec!["note", "velocity", "on"]);
        assert_eq!(events[0].value, ComponentValue::Number(60.0));
        assert_eq!(events[1].value, ComponentValue::Number(100.0));
        assert_eq!(events[2].value, ComponentValue::Bool(true));
    }

    #[test]
    fn note_off_and_zero_velocity_note_on_both_emit_off() {
        for msg in [[0x80u8, 60, 64], [0x90, 60, 0]] {
            let mut node = note_in(0);
            let s = node.base.sink.clone().expect("sink");
            node.receive_raw_message("dev", &msg);
            let events = drain(&s);
            assert_eq!(handles(&events), vec!["note", "velocity", "off"], "msg {msg:?}");
            assert_eq!(events[1].value, ComponentValue::Number(0.0));
        }
    }

    #[test]
    fn channel_filter_drops_other_channels_and_omni_accepts_all() {
        // Channel 2 filter: status nibble 0x91 = channel 2 passes, 0x90 = channel 1 dropped.
        let mut node = note_in(2);
        let s = node.base.sink.clone().expect("sink");
        node.receive_raw_message("dev", &[0x90, 60, 100]);
        assert!(drain(&s).is_empty(), "channel 1 must not pass a channel-2 filter");
        node.receive_raw_message("dev", &[0x91, 60, 100]);
        assert_eq!(drain(&s).len(), 3);

        let mut omni = note_in(0);
        let s = omni.base.sink.clone().expect("sink");
        omni.receive_raw_message("dev", &[0x9F, 60, 100]);
        assert_eq!(drain(&s).len(), 3, "omni accepts channel 16");
    }

    #[test]
    fn cc_mode_emits_matching_control_value_only() {
        let mut node = Midi::new(
            "in-1".into(),
            MidiConfig { mode: MidiMode::Cc, control: 7, ..MidiConfig::default() },
        );
        node.set_sink(sink());
        let s = node.base.sink.clone().expect("sink");
        node.receive_raw_message("dev", &[0xB0, 1, 99]);
        assert!(drain(&s).is_empty(), "non-matching control is ignored");
        node.receive_raw_message("dev", &[0xB0, 7, 99]);
        let events = drain(&s);
        assert_eq!(handles(&events), vec!["value"]);
        assert_eq!(events[0].value, ComponentValue::Number(99.0));
    }

    #[test]
    fn in_node_reports_its_device_filter_and_out_node_reports_none() {
        let in_node = Midi::new(
            "in-1".into(),
            MidiConfig { device_name: "Launchpad".into(), ..MidiConfig::default() },
        );
        assert_eq!(in_node.midi_wiring(), Some("Launchpad".to_string()));

        let out_node = Midi::new(
            "out-1".into(),
            MidiConfig { direction: MidiDirection::Out, ..MidiConfig::default() },
        );
        assert_eq!(out_node.midi_wiring(), None);
    }

    #[test]
    fn in_node_rejects_send() {
        let mut node = note_in(0);
        let err = with_test_ctx("in-1", |ctx| {
            node.dispatch("send", ComponentValue::Bool(true), ctx)
                .expect_err("in-direction should refuse send")
        });
        assert!(err.to_string().contains("in, not out"));
    }

    #[test]
    fn out_node_ignores_inbound_messages() {
        let mut node = Midi::new(
            "out-1".into(),
            MidiConfig { direction: MidiDirection::Out, mode: MidiMode::Cc, ..MidiConfig::default() },
        );
        node.set_sink(sink());
        let s = node.base.sink.clone().expect("sink");
        node.receive_raw_message("dev", &[0xB0, 1, 99]);
        assert!(drain(&s).is_empty(), "an out node must not re-emit inbound messages");
    }

    #[test]
    fn cc_send_records_clamped_control_change() {
        let mut node = Midi::new(
            "out-1".into(),
            MidiConfig {
                direction: MidiDirection::Out,
                device_name: "Synth".into(),
                channel: 2,
                mode: MidiMode::Cc,
                control: 7,
                ..MidiConfig::default()
            },
        );
        let mut reqs = recorded_cloud_requests("out-1", |ctx| {
            node.dispatch("send", ComponentValue::Number(300.0), ctx).expect("dispatch ok");
        });
        assert_eq!(reqs.len(), 1);
        match reqs.remove(0) {
            CloudRequestKind::MidiSend { device_name, bytes } => {
                assert_eq!(device_name, "Synth");
                assert_eq!(bytes, vec![0xB1, 7, 127], "channel 2 status, clamped value");
            }
            other => panic!("expected MidiSend, got {other:?}"),
        }
    }

    #[test]
    fn note_send_maps_truthy_to_on_and_falsy_to_off() {
        let mut node = Midi::new(
            "out-1".into(),
            MidiConfig {
                direction: MidiDirection::Out,
                mode: MidiMode::Note,
                note: 64,
                velocity: 90,
                ..MidiConfig::default()
            },
        );
        let reqs = recorded_cloud_requests("out-1", |ctx| {
            node.dispatch("send", ComponentValue::Bool(true), ctx).expect("on ok");
            node.dispatch("send", ComponentValue::Number(0.0), ctx).expect("off ok");
        });
        let bytes: Vec<Vec<u8>> = reqs
            .into_iter()
            .map(|kind| match kind {
                CloudRequestKind::MidiSend { bytes, .. } => bytes,
                other => panic!("expected MidiSend, got {other:?}"),
            })
            .collect();
        assert_eq!(bytes, vec![vec![0x90, 64, 90], vec![0x80, 64, 0]]);
    }

    #[test]
    fn note_name_to_midi_maps_scientific_pitch() {
        assert_eq!(note_name_to_midi("C4"), Some(60), "middle C");
        assert_eq!(note_name_to_midi("A4"), Some(69), "A440");
        assert_eq!(note_name_to_midi("C#5"), Some(73));
        assert_eq!(note_name_to_midi("c4"), Some(60), "case-insensitive letter");
        assert_eq!(note_name_to_midi("H4"), None, "unknown letter");
        assert_eq!(note_name_to_midi(""), None);
    }

    #[test]
    fn song_mode_plays_note_on_then_off_through_the_wakeup_chain() {
        let mut node = Midi::new(
            "out-1".into(),
            MidiConfig {
                direction: MidiDirection::Out,
                mode: MidiMode::Song,
                tempo: 120,
                song: vec![(Some("C4".into()), 1.0, 90)],
                ..MidiConfig::default()
            },
        );
        // start (dispatch send=truthy) then walk the queue via two `_note` wakeups:
        // advance #1 sounds C4, advance #2 releases it and finds the queue empty.
        let reqs = recorded_cloud_requests("out-1", |ctx| {
            node.dispatch("send", ComponentValue::Bool(true), ctx).expect("start");
            node.dispatch_internal("note", ComponentValue::default(), ctx).expect("advance 1");
            node.dispatch_internal("note", ComponentValue::default(), ctx).expect("advance 2");
        });
        let bytes: Vec<Vec<u8>> = reqs
            .into_iter()
            .map(|kind| match kind {
                CloudRequestKind::MidiSend { bytes, .. } => bytes,
                other => panic!("expected MidiSend, got {other:?}"),
            })
            .collect();
        assert_eq!(bytes, vec![vec![0x90, 60, 90], vec![0x80, 60, 0]]);
    }

    #[test]
    fn falsy_send_stops_a_playing_song_with_a_note_off() {
        let mut node = Midi::new(
            "out-1".into(),
            MidiConfig {
                direction: MidiDirection::Out,
                mode: MidiMode::Song,
                song: vec![(Some("C4".into()), 4.0, 100)],
                ..MidiConfig::default()
            },
        );
        let reqs = recorded_cloud_requests("out-1", |ctx| {
            node.dispatch("send", ComponentValue::Bool(true), ctx).expect("start");
            node.dispatch_internal("note", ComponentValue::default(), ctx).expect("sound C4");
            node.dispatch("send", ComponentValue::Bool(false), ctx).expect("stop");
        });
        let bytes: Vec<Vec<u8>> = reqs
            .into_iter()
            .map(|kind| match kind {
                CloudRequestKind::MidiSend { bytes, .. } => bytes,
                other => panic!("expected MidiSend, got {other:?}"),
            })
            .collect();
        assert_eq!(bytes, vec![vec![0x90, 60, 100], vec![0x80, 60, 0]], "on then off on stop");
    }

    #[test]
    fn each_song_note_sounds_at_its_own_velocity() {
        let mut node = Midi::new(
            "out-1".into(),
            MidiConfig {
                direction: MidiDirection::Out,
                mode: MidiMode::Song,
                tempo: 120,
                song: vec![(Some("C4".into()), 1.0, 40), (Some("E4".into()), 1.0, 120)],
                ..MidiConfig::default()
            },
        );
        let reqs = recorded_cloud_requests("out-1", |ctx| {
            node.dispatch("send", ComponentValue::Bool(true), ctx).expect("start");
            for _ in 0..3 {
                node.dispatch_internal("note", ComponentValue::default(), ctx).expect("advance");
            }
        });
        let bytes: Vec<Vec<u8>> = reqs
            .into_iter()
            .map(|kind| match kind {
                CloudRequestKind::MidiSend { bytes, .. } => bytes,
                other => panic!("expected MidiSend, got {other:?}"),
            })
            .collect();
        // C4@40 on, C4 off + E4@120 on, E4 off.
        assert_eq!(
            bytes,
            vec![
                vec![0x90, 60, 40],
                vec![0x80, 60, 0],
                vec![0x90, 64, 120],
                vec![0x80, 64, 0],
            ]
        );
    }
}
