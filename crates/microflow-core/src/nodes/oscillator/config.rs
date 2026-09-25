//! Oscillator Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

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

impl Default for OscillatorConfig {
    fn default() -> Self {
        Self {
            waveform: Waveform::default(),
            period: default_period(),
            amplitude: default_amplitude(),
            phase: 0.0,
            shift: 0.0,
            auto_start: default_auto_start(),
        }
    }
}
