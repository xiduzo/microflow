//! Switch Component - Input
//!
//! A latching on/off toggle switch (as opposed to a momentary Button).
//! Supports Normally-Open (NO) and Normally-Closed (NC) wiring.
//! Reference: <https://johnny-five.io/examples/switch/>

use crate::runtime::base::{
    pin_mode, serde_utils, BoardCommand, BoardHandle, Component, ComponentBase, ComponentValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    is_closed: bool,
    /// Timestamp of the last state change, used for debouncing
    last_change: Option<Instant>,
}

impl Switch {
    #[must_use]
    pub fn new(id: String, config: SwitchConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            board: None,
            is_closed: false,
            last_change: None,
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

    fn process_state(&mut self, pin_high: bool) {
        let closed = self.is_logically_closed(pin_high);
        log::info!("Switch {} process_state: pin_high={}, closed={}, was_closed={}, type={:?}",
            self.base.id, pin_high, closed, self.is_closed, self.config.switch_type);

        if closed != self.is_closed {
            // Debounce: ignore changes within 20ms of the last one
            if let Some(last) = self.last_change {
                if last.elapsed() < Duration::from_millis(20) {
                    return;
                }
            }
            self.last_change = Some(Instant::now());
            self.is_closed = closed;
            self.base.set_value(ComponentValue::Bool(closed));

            // Emit on every state change
            self.base.emit("event");

            if closed {
                self.base.emit("true");
            } else {
                self.base.emit("false");
            }
        }
    }
}

impl Component for Switch {
    fn base(&self) -> &ComponentBase { &self.base }
    fn base_mut(&mut self) -> &mut ComponentBase { &mut self.base }
    fn component_type(&self) -> &'static str { "Switch" }
    fn requires_hardware(&self) -> bool { true }

    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        log::info!("Switch {} initialize: pin={}, type={:?}", self.base.id, self.config.pin, self.config.switch_type);
        board.send_command(BoardCommand::SetPinMode { pin: self.config.pin, mode: pin_mode::INPUT })?;
        board.send_command(BoardCommand::EnableDigitalReporting { pin: self.config.pin })?;
        self.board = Some(board);
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "read" => Ok(()),
            "pin_change" => {
                log::info!("Switch {} pin_change called with args: {:?}", self.base.id, args);
                if let Some(pin_high) = args.as_bool() {
                    self.process_state(pin_high);
                } else {
                    log::warn!("Switch {} pin_change: could not extract bool from {:?}", self.base.id, args);
                }
                Ok(())
            }
            _ => Err(crate::error::RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) {
        if let Some(board) = &self.board {
            log::info!("Switch {} destroy: disabling digital reporting for pin {}", self.base.id, self.config.pin);
            let _ = board.send_command(BoardCommand::DisableDigitalReporting { pin: self.config.pin });
        }
        self.board = None;
    }
}
