//! MIDI Node config — shared by the live runtime and the codegen emitter.
//!
//! One node, two directions (mirroring the Mqtt node's publish/subscribe):
//! `direction = "in"` listens to host MIDI inputs, `direction = "out"` sends to
//! host MIDI outputs. `device_name` is a case-insensitive substring filter
//! against the host's MIDI port names ("" = every device); it is meaningless
//! on-device (codegen targets the serial MIDI jack instead).

use serde::{Deserialize, Serialize};

/// One song step: note name (`Some("C4")`, sharps only) or `None` for a rest,
/// its length in beats, and its note-on velocity (0-127). Unlike the Piezo song
/// (a buzzer has no dynamics), each MIDI note carries its own velocity.
pub type SongNote = (Option<String>, f64, u8);

/// Which way this node speaks MIDI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MidiDirection {
    #[default]
    In,
    Out,
}

/// Which MIDI messages the node speaks: note-on/off pairs, a control-change, or
/// (out-direction only) an embedded note sequence played back on the host clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MidiMode {
    #[default]
    Note,
    Cc,
    /// Play the embedded `song` — the MIDI twin of the Piezo "song" type. Only
    /// meaningful on an out-direction node; ignored on in.
    Song,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiConfig {
    #[serde(default)]
    pub direction: MidiDirection,
    /// Substring filter on the host MIDI port name; "" matches every device.
    #[serde(default)]
    pub device_name: String,
    /// 1-16; 0 = omni (in-direction accepts every channel; out clamps to 1).
    #[serde(default)]
    pub channel: u8,
    #[serde(default)]
    pub mode: MidiMode,
    /// CC number to listen for / send on (cc mode only).
    #[serde(default = "default_control")]
    pub control: u8,
    /// Note number to play (out + note mode only).
    #[serde(default = "default_note")]
    pub note: u8,
    /// Note-on velocity (out + note/song mode only).
    #[serde(default = "default_velocity")]
    pub velocity: u8,
    /// Note sequence for song mode (out + song only); each note carries its
    /// own velocity. `velocity` above is the fallback default for new notes.
    #[serde(default)]
    pub song: Vec<SongNote>,
    /// Playback tempo in BPM for song mode.
    #[serde(default = "default_tempo")]
    pub tempo: u32,
}

impl Default for MidiConfig {
    fn default() -> Self {
        Self {
            direction: MidiDirection::default(),
            device_name: String::new(),
            channel: 0,
            mode: MidiMode::default(),
            control: default_control(),
            note: default_note(),
            velocity: default_velocity(),
            song: Vec::new(),
            tempo: default_tempo(),
        }
    }
}

/// CC 1 = the mod wheel, the knob most controllers map first.
fn default_control() -> u8 {
    1
}
/// Middle C.
fn default_note() -> u8 {
    60
}
fn default_velocity() -> u8 {
    127
}
/// A brisk-but-common default, matching the Piezo song tempo.
fn default_tempo() -> u32 {
    113
}
