//! Button Component — Input. Template port for the workflow node fan-out.
//!
//! Note vs. the desktop original: the vestigial `poll_handle` / `polling_active`
//! tokio polling fields are dropped (the board reader, now `feed_bytes`, drives
//! `on_pin_change`), and digital reporting is no longer enabled here — the
//! runtime's `update_flow` reconciles reporting centrally from `listener_wiring`.
//! Debounce and hold timing move off `std::time::Instant` onto the host clock
//! (`ctx.now_ms`) and the wakeup scheduler: a press arms a `_hold` wakeup at
//! `holdtime`; `dispatch_internal("hold", …)` emits "hold" if still held; a
//! release cancels it.

use crate::runtime::{
    pin_mode, serde_utils, Component, ComponentBase, ComponentBuilder, ComponentValue,
    HardwareComponent, ListenerWiring, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};

/// Debounce window: state changes arriving within this many milliseconds of the
/// previous one are ignored. Most mechanical switches settle within ~5ms, so
/// latency stays imperceptible for real-time flows.
const DEBOUNCE_MS: f64 = 20.0;

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
            invert: false,
        }
    }
}

pub struct Button {
    base: ComponentBase,
    config: ButtonConfig,
    is_pressed: bool,
    hold_emitted: bool,
    /// Host-clock timestamp (ms) of the last accepted state change, for debounce.
    last_change_ms: Option<f64>,
}

impl Button {
    #[must_use]
    pub fn new(id: String, config: ButtonConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            is_pressed: false,
            hold_emitted: false,
            last_change_ms: None,
        }
    }

    fn process_state(&mut self, pressed: bool, ctx: &mut RuntimeContext) {
        if pressed != self.is_pressed {
            // Debounce: ignore state changes that arrive within DEBOUNCE_MS of the
            // last one.
            if let Some(last) = self.last_change_ms {
                if ctx.now_ms() - last < DEBOUNCE_MS {
                    return;
                }
            }
            self.last_change_ms = Some(ctx.now_ms());
            self.is_pressed = pressed;
            self.hold_emitted = false;
            self.base.set_value(ComponentValue::Bool(pressed));
            if pressed {
                // Arm the hold wakeup; fires once after `holdtime` ms if still held.
                ctx.schedule_wakeup("_hold", self.config.holdtime);
                self.base.emit("event");
                self.base.emit("true");
            } else {
                // Released before (or after) hold — cancel any pending hold wakeup.
                ctx.cancel_wakeup("_hold");
                self.base.emit("event");
                self.base.emit("false");
            }
        }
    }
}

impl Component for Button {
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
        "Button"
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

    fn dispatch_internal(
        &mut self,
        method: &str,
        _value: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            // Hold timer fired: emit "hold" once if the button is still held.
            "hold" => {
                if self.is_pressed && !self.hold_emitted {
                    self.hold_emitted = true;
                    self.base.emit("hold");
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

impl HardwareComponent for Button {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        let mode = if self.config.is_pullup {
            pin_mode::PULLUP
        } else {
            pin_mode::INPUT
        };
        ctx.board().set_pin_mode(self.config.pin, mode)?;
        Ok(())
    }

    fn on_pin_change(
        &mut self,
        value: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        if let Some(pressed) = value.as_bool() {
            self.process_state(pressed, ctx);
        }
        Ok(())
    }
}

impl ComponentBuilder for Button {
    type Config = ButtonConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
