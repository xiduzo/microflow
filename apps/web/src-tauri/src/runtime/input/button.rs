//! Button Component - Input
//!
//! A momentary push button. Debounce is delegated to the shared
//! [`super::debounce::Debouncer`] (deferred-settle, never drops an edge); the
//! Button only adds its `hold` pulse, configured via `holdtime`. See
//! `debounce.rs` for why dropping edges desyncs a digital-on-change input.

use crate::runtime::base::{
    pin_mode, serde_utils, BoardHandle, Component, ComponentBase, ComponentValue, HardwareComponent,
};
use crate::runtime::wiring::ListenerWiring;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use super::debounce::Debouncer;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default)]
    pub is_pullup: bool,
    #[serde(default)]
    pub is_pulldown: bool,
    #[serde(default = "default_holdtime")]
    pub holdtime: u64,
    #[serde(default)]
    pub invert: bool,
}

fn default_pin() -> u8 { 6 }
fn default_holdtime() -> u64 { 500 }

impl Default for ButtonConfig {
    fn default() -> Self {
        Self { pin: default_pin(), is_pullup: false, is_pulldown: false, holdtime: default_holdtime(), invert: false }
    }
}

pub struct Button {
    base: ComponentBase,
    config: ButtonConfig,
    board: Option<Arc<BoardHandle>>,
    debounce: Option<Debouncer>,
}

impl Button {
    #[must_use]
    pub fn new(id: String, config: ButtonConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            board: None,
            debounce: None,
        }
    }

    /// Spawn the debounce worker on first use. Needs the event sender wired, so
    /// it is created lazily from `on_pin_change` (by which point the registry
    /// has set the sender) rather than in `new`.
    fn ensure_debouncer(&mut self) {
        if self.debounce.is_some() {
            return;
        }
        if let Some(sender) = self.base.event_sender.clone() {
            self.debounce = Some(Debouncer::spawn(
                sender,
                self.base.id.clone(),
                Some(Duration::from_millis(self.config.holdtime)),
            ));
        }
    }
}

impl Component for Button {
    fn ports() -> &'static [&'static str] { &["read"] }

    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Button" }

    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        vec![ListenerWiring::DigitalPin { pin: self.config.pin }]
    }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> { Some(self) }

    fn dispatch(&mut self, method: &str, _args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "read" => Ok(()),
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) {
        // Dropping the debouncer stops and joins its worker.
        self.debounce = None;
        if let Some(board) = &self.board {
            log::info!("Button {} destroy: disabling digital reporting for pin {}", self.base.id, self.config.pin);
            board.disable_digital_reporting(self.config.pin).ignore();
        }
        self.board = None;
    }
}

impl HardwareComponent for Button {
    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        let mode = if self.config.is_pullup { pin_mode::PULLUP } else { pin_mode::INPUT };
        board.set_pin_mode(self.config.pin, mode).ignore();
        board.enable_digital_reporting(self.config.pin).ignore();
        self.board = Some(board);
        Ok(())
    }

    fn on_pin_change(&mut self, value: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        if let Some(pressed) = value.as_bool() {
            self.ensure_debouncer();
            if let Some(debounce) = &self.debounce {
                debounce.feed(pressed);
            }
        }
        Ok(())
    }
}
