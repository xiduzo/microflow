//! Interval Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntervalConfig {
    #[serde(default = "default_interval")]
    pub interval: u64,
    #[serde(default = "default_auto_start", rename = "autoStart")]
    pub auto_start: bool,
}

fn default_interval() -> u64 {
    1000
}
fn default_auto_start() -> bool {
    true
}

impl Default for IntervalConfig {
    fn default() -> Self {
        Self { interval: default_interval(), auto_start: default_auto_start() }
    }
}
