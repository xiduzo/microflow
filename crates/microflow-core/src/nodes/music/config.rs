//! Music Node config — host audio playback (no device equivalent).
//!
//! The audio files are **not** here: they live in the node's `data.tracks[].src`
//! as data URLs on the frontend and never cross into the runtime, which would
//! drag megabytes of base64 through every effects turn. The runtime decides
//! *which* record plays and *when*; the host resolves the source by index from
//! the flow it already holds.

use serde::{Deserialize, Serialize};

/// One record on the node. `name` is also the record's dynamic **Port** id on
/// the canvas, so wiring a trigger to it plays that record — the frontend keeps
/// names unique for exactly that reason.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicTrack {
    pub(crate) name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicConfig {
    /// The records, in the same order as the host's sources.
    #[serde(default)]
    pub(crate) tracks: Vec<MusicTrack>,
    /// Which record is selected when the flow starts. `set` moves it at runtime.
    #[serde(default)]
    pub(crate) track: usize,
    /// Playback volume, 0.0–1.0.
    #[serde(default = "default_volume")]
    pub(crate) volume: f32,
    /// Restart the record when it ends instead of stopping.
    #[serde(default)]
    pub(crate) r#loop: bool,
}

fn default_volume() -> f32 {
    0.8
}

impl Default for MusicConfig {
    fn default() -> Self {
        Self { tracks: Vec::new(), track: 0, volume: default_volume(), r#loop: false }
    }
}
