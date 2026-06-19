//! Delay Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelayConfig {
    #[serde(default = "default_delay")]
    pub delay: u64,
    #[serde(default, rename = "forgetPrevious")]
    pub forget_previous: bool,
}

fn default_delay() -> u64 {
    1000
}

impl Default for DelayConfig {
    fn default() -> Self {
        Self { delay: default_delay(), forget_previous: false }
    }
}
