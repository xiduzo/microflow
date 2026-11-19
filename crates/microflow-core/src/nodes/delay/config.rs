//! Delay Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

/// How many triggers a Delay that keeps every trigger can hold at once. The
/// live runtime and the generated Sketch share this bound, so a Flow drops the
/// same triggers on the device as it does live. On the device every slot is a
/// value plus a timestamp in RAM: 8 bytes on an Uno, 128 for the whole queue.
pub(crate) const QUEUE_CAPACITY: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DelayConfig {
    #[serde(default = "default_delay", deserialize_with = "serde_utils::deserialize_whole")]
    pub(crate) delay: u64,
    #[serde(default, rename = "forgetPrevious")]
    pub(crate) forget_previous: bool,
}

impl DelayConfig {
    /// How many triggers can be pending at once: one when the Delay forgets
    /// the previous trigger (debounce), [`QUEUE_CAPACITY`] when it keeps every
    /// trigger (queue). A trigger that arrives while this many are pending
    /// takes the place of the newest pending one — which, with one slot, is
    /// the whole of debounce.
    pub(crate) fn capacity(&self) -> usize {
        if self.forget_previous {
            1
        } else {
            QUEUE_CAPACITY
        }
    }
}

fn default_delay() -> u64 {
    1000
}
