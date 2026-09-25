//! Hotkey Node config — shared by the live runtime and the codegen emitter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyConfig {
    #[serde(default = "default_accelerator")]
    pub accelerator: String,
}

fn default_accelerator() -> String {
    "x".to_string()
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            accelerator: default_accelerator(),
        }
    }
}
