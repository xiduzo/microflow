//! Hotkey Component - Input
//!
//! Software-only component that responds to keyboard key press/release events
//! routed from the `HotkeyManager`. Emits events on "event", "true", and "false" handles.

use crate::runtime::base::{Component, ComponentBase, ComponentValue};
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

pub struct Hotkey {
    base: ComponentBase,
    config: HotkeyConfig,
}

impl Hotkey {
    #[must_use]
    pub fn new(id: String, config: HotkeyConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
        }
    }

    /// Get the configured accelerator key (lowercase)
    #[must_use]
    pub fn accelerator(&self) -> &str {
        &self.config.accelerator
    }
}

impl Component for Hotkey {
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Hotkey" }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "key_event" => {
                let pressed = args.is_truthy();
                self.base.set_value(ComponentValue::Bool(pressed));
                self.base.emit("event");
                if pressed {
                    self.base.emit("true");
                } else {
                    self.base.emit("false");
                }
                Ok(())
            }
            _ => Err(crate::error::RuntimeError::ComponentError(
                format!("Unknown method: {method}"),
            )),
        }
    }
}
