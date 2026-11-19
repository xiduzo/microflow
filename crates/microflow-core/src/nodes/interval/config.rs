//! Interval Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct IntervalConfig {
    #[serde(default = "default_interval", deserialize_with = "serde_utils::deserialize_whole")]
    pub(crate) interval: u64,
    #[serde(default = "default_auto_start", rename = "autoStart")]
    pub(crate) auto_start: bool,
}

fn default_interval() -> u64 {
    1000
}
fn default_auto_start() -> bool {
    true
}
