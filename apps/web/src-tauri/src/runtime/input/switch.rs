//! Switch Component - Input
//!
//! A latching on/off toggle switch (as opposed to a momentary Button).
//! Supports Normally-Open (NO) and Normally-Closed (NC) wiring.
//! Reference: <https://johnny-five.io/examples/switch/>
//!
//! Debounce is delegated to the shared [`super::debounce::Debouncer`]
//! (deferred-settle, never drops an edge — see `debounce.rs`). The raw pin
//! level is translated to the logical closed/open level *before* being fed in,
//! so the worker debounces the logical state. No hold pulse (latching switch).

use crate::runtime::base::{
    pin_mode, serde_utils, BoardHandle, Component, ComponentBase, ComponentValue, HardwareComponent,
};
use crate::runtime::wiring::ListenerWiring;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::debounce::Debouncer;

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub enum SwitchType {
    /// Normally Open — circuit is open when not actuated
    #[default]
    NO,
    /// Normally Closed — circuit is closed when not actuated
    NC,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default, rename = "type")]
    pub switch_type: SwitchType,
}

fn default_pin() -> u8 { 2 }

impl Default for SwitchConfig {
    fn default() -> Self {
        Self { pin: default_pin(), switch_type: SwitchType::default() }
    }
}

pub struct Switch {
    base: ComponentBase,
    config: SwitchConfig,
    board: Option<Arc<BoardHandle>>,
    debounce: Option<Debouncer>,
}

impl Switch {
    #[must_use]
    pub fn new(id: String, config: SwitchConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            board: None,
            debounce: None,
        }
    }

    /// Translate raw pin reading to logical closed/open based on wiring type.
    /// - NO (normally open): pin HIGH (pulled up) = open, pin LOW = closed
    /// - NC (normally closed): pin HIGH (pulled up) = closed, pin LOW = open
    fn is_logically_closed(&self, pin_high: bool) -> bool {
        match self.config.switch_type {
            SwitchType::NO => !pin_high,
            SwitchType::NC => pin_high,
        }
    }

    /// Spawn the debounce worker on first use (needs the event sender wired).
    fn ensure_debouncer(&mut self) {
        if self.debounce.is_some() {
            return;
        }
        if let Some(sender) = self.base.event_sender.clone() {
            // No hold for a latching switch.
            self.debounce = Some(Debouncer::spawn(sender, self.base.id.clone(), None));
        }
    }
}

impl Component for Switch {
    fn ports() -> &'static [&'static str] { &["read"] }

    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Switch" }

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
            log::info!("Switch {} destroy: disabling digital reporting for pin {}", self.base.id, self.config.pin);
            board.disable_digital_reporting(self.config.pin).ignore();
        }
        self.board = None;
    }
}

impl HardwareComponent for Switch {
    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        log::info!("Switch {} initialize: pin={}, type={:?}", self.base.id, self.config.pin, self.config.switch_type);
        board.set_pin_mode(self.config.pin, pin_mode::INPUT).ignore();
        board.enable_digital_reporting(self.config.pin).ignore();
        self.board = Some(board);
        Ok(())
    }

    fn on_pin_change(&mut self, value: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        if let Some(pin_high) = value.as_bool() {
            let closed = self.is_logically_closed(pin_high);
            self.ensure_debouncer();
            if let Some(debounce) = &self.debounce {
                debounce.feed(closed);
            }
        }
        Ok(())
    }
}
