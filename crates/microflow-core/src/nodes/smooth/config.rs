//! Smooth Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SmoothType {
    #[default]
    Smooth,
    MovingAverage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmoothConfig {
    #[serde(default, rename = "type")]
    pub smooth_type: SmoothType,
    #[serde(default = "default_attenuation")]
    pub attenuation: f64,
    #[serde(default = "default_window_size", rename = "windowSize")]
    pub window_size: usize,
}

fn default_attenuation() -> f64 {
    0.995
}
fn default_window_size() -> usize {
    25
}

impl Default for SmoothConfig {
    fn default() -> Self {
        Self {
            smooth_type: SmoothType::default(),
            attenuation: default_attenuation(),
            window_size: default_window_size(),
        }
    }
}
