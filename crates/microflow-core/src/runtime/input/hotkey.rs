//! Hotkey Component — Input.
//!
//! Software-only component that responds to keyboard key press/release events
//! routed from the host's hotkey manager via the `key_event` port. Emits events
//! on "event", "true", and "false" handles. Pure logic: no board, no timers.

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, ListenerWiring, RuntimeContext,
    RuntimeError,
};

pub use crate::config::hotkey::HotkeyConfig;

pub struct Hotkey {
    base: ComponentBase,
    config: HotkeyConfig,
}

impl Hotkey {
    const E_EVENT: &'static str = "event";
    const E_TRUE: &'static str = "true";
    const E_FALSE: &'static str = "false";

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
    fn ports() -> &'static [&'static str] {
        &["key_event"]
    }

    fn emits() -> &'static [&'static str] {
        &[
            Self::E_EVENT,
            Self::E_TRUE,
            Self::E_FALSE,
            ComponentBase::VALUE_HANDLE,
        ]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Hotkey"
    }

    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        vec![ListenerWiring::HotKey {
            accelerator: self.config.accelerator.to_lowercase(),
        }]
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "key_event" => {
                let pressed = args.is_truthy();
                self.base.set_value(ComponentValue::Bool(pressed));
                self.base.emit(Self::E_EVENT);
                if pressed {
                    self.base.emit(Self::E_TRUE);
                } else {
                    self.base.emit(Self::E_FALSE);
                }
                Ok(())
            }
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}

impl ComponentBuilder for Hotkey {
    type Config = HotkeyConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
