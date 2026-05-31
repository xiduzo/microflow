//! Switch Component — Input. Template port for the workflow node fan-out.
//!
//! A latching on/off toggle switch (as opposed to a momentary Button).
//! Supports Normally-Open (NO) and Normally-Closed (NC) wiring.
//! Reference: <https://johnny-five.io/examples/switch/>
//!
//! Note vs. the desktop original: the `board: Option<Arc<BoardHandle>>` field is
//! dropped (the board arrives per-dispatch via `RuntimeContext`), digital
//! reporting is no longer enabled here (the runtime reconciles reporting
//! centrally from `listener_wiring`), and the `Instant`-based debounce now reads
//! the host clock via `ctx.now_ms()`.

use crate::runtime::{
    pin_mode, serde_utils, Component, ComponentBase, ComponentBuilder, ComponentValue,
    HardwareComponent, ListenerWiring, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};

/// Debounce window: ignore state changes within this many milliseconds of the last.
const DEBOUNCE_MS: f64 = 20.0;

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

fn default_pin() -> u8 {
    2
}

impl Default for SwitchConfig {
    fn default() -> Self {
        Self { pin: default_pin(), switch_type: SwitchType::default() }
    }
}

pub struct Switch {
    base: ComponentBase,
    config: SwitchConfig,
    is_closed: bool,
    /// Timestamp (host clock, ms) of the last state change, used for debouncing.
    last_change_ms: Option<f64>,
}

impl Switch {
    #[must_use]
    pub fn new(id: String, config: SwitchConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            is_closed: false,
            last_change_ms: None,
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

    fn process_state(&mut self, pin_high: bool, ctx: &mut RuntimeContext) {
        let closed = self.is_logically_closed(pin_high);

        if closed != self.is_closed {
            // Debounce: ignore changes within DEBOUNCE_MS of the last one.
            let now = ctx.now_ms();
            if let Some(last) = self.last_change_ms {
                if now - last < DEBOUNCE_MS {
                    return;
                }
            }
            self.last_change_ms = Some(now);
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
    fn ports() -> &'static [&'static str] {
        &["read"]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Switch"
    }

    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        vec![ListenerWiring::DigitalPin { pin: self.config.pin }]
    }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> {
        Some(self)
    }

    fn dispatch(
        &mut self,
        method: &str,
        _args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "read" => Ok(()),
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}

impl HardwareComponent for Switch {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().set_pin_mode(self.config.pin, pin_mode::INPUT)?;
        Ok(())
    }

    fn on_pin_change(
        &mut self,
        value: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        if let Some(pin_high) = value.as_bool() {
            self.process_state(pin_high, ctx);
        }
        Ok(())
    }
}

impl ComponentBuilder for Switch {
    type Config = SwitchConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
