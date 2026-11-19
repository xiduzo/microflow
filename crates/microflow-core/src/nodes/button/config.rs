//! Button Node config — shared by the live runtime and the codegen emitter.

use crate::config::serde_utils;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ButtonConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub(crate) pin: u8,
    #[serde(default)]
    pub(crate) is_pullup: bool,
    #[serde(default)]
    pub(crate) is_pulldown: bool,
    #[serde(default = "default_holdtime", deserialize_with = "serde_utils::deserialize_whole")]
    pub(crate) holdtime: u64,
    // `invert` is gone: neither the runtime nor the sketch ever read it and no
    // editor control set it. A stored `"invert"` key is ignored on read (serde
    // skips unknown fields), so old documents load unchanged.
}

fn default_pin() -> u8 {
    6
}
fn default_holdtime() -> u64 {
    500
}

impl Default for ButtonConfig {
    fn default() -> Self {
        Self {
            pin: default_pin(),
            is_pullup: false,
            is_pulldown: false,
            holdtime: default_holdtime(),
        }
    }
}

impl ButtonConfig {
    /// The pin level that reads as "pressed" — the one rule the live runtime
    /// and the emitted sketch both apply. With the internal pull-up the line
    /// rests HIGH and a press pulls it to ground (active-low).
    #[must_use]
    pub(crate) fn pressed_when_high(&self) -> bool {
        !self.is_pullup
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Documents saved while the config still had `invert` load unchanged.
    #[test]
    fn a_stored_invert_key_is_ignored() {
        let config: ButtonConfig =
            serde_json::from_value(serde_json::json!({ "pin": 4, "invert": true, "isPullup": true })).unwrap();
        assert_eq!(config.pin, 4);
        assert!(!config.pressed_when_high());
    }
}
