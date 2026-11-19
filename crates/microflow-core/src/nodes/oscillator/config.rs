//! Oscillator Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

/// How often, in ms, a running Oscillator samples its wave and hands the
/// sample on (~60 per second), counted from its start — live and on the board.
pub(crate) const SAMPLE_MS: u64 = 1000 / 60;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Waveform {
    #[default]
    Sinus,
    Square,
    Sawtooth,
    Triangle,
    Random,
    /// Bounded random walk: linear drift to a new random target each period.
    RandomWalk,
    /// Smooth organic noise: two octaves of smoothstep-faded value noise.
    Perlin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct OscillatorConfig {
    #[serde(default)]
    pub(crate) waveform: Waveform,
    #[serde(default = "default_period")]
    pub(crate) period: f64,
    #[serde(default = "default_amplitude")]
    pub(crate) amplitude: f64,
    #[serde(default)]
    pub(crate) phase: f64,
    #[serde(default)]
    pub(crate) shift: f64,
    #[serde(default = "default_auto_start", rename = "autoStart")]
    pub(crate) auto_start: bool,
}

fn default_period() -> f64 {
    1000.0
}
fn default_amplitude() -> f64 {
    1.0
}
fn default_auto_start() -> bool {
    true
}
