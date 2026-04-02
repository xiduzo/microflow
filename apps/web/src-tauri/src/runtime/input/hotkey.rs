//! Hotkey Component - Input
//!
//! Software-only component that responds to keyboard key press/release events
//! routed from the HotkeyManager. Emits events on "event", "true", and "false" handles.

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

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
    pub fn accelerator(&self) -> &str {
        &self.config.accelerator
    }
}

impl Component for Hotkey {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Hotkey" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        Ok(())
    }

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

    fn destroy(&mut self) {}

    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> {
        self.base.event_sender.clone()
    }

    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) {
        self.base.event_sender = Some(sender);
    }
}
