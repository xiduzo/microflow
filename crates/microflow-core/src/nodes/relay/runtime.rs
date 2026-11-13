//! Relay Component — Output. Template port for the workflow node fan-out.

use crate::runtime::{
    pin_mode, Component, ComponentBase, ComponentBuilder, ComponentValue, HardwareComponent,
    RuntimeContext, RuntimeError,
};

use super::config::{RelayConfig, RelayType};

pub(crate) struct Relay {
    base: ComponentBase,
    config: RelayConfig,
    is_open: bool,
}

impl Relay {
    #[must_use]
    pub(crate) fn new(id: String, config: RelayConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            is_open: false,
        }
    }

    fn open(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        let signal = matches!(self.config.r#type, RelayType::NO);
        ctx.board().digital_write(self.config.pin, signal)?;
        self.is_open = true;
        self.base.set_value(ComponentValue::Bool(true));
        Ok(())
    }

    fn close(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        let signal = matches!(self.config.r#type, RelayType::NC);
        ctx.board().digital_write(self.config.pin, signal)?;
        self.is_open = false;
        self.base.set_value(ComponentValue::Bool(false));
        Ok(())
    }

    fn toggle(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        if self.is_open {
            self.close(ctx)
        } else {
            self.open(ctx)
        }
    }
}

impl Component for Relay {
    fn ports() -> &'static [&'static str] {
        &["true", "false", "toggle"]
    }

    fn emits() -> &'static [&'static str] {
        &[ComponentBase::VALUE_HANDLE]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Relay"
    }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> {
        Some(self)
    }

    fn dispatch(
        &mut self,
        method: &str,
        _args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "true" => self.open(ctx),
            "false" => self.close(ctx),
            "toggle" => self.toggle(ctx),
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }
}

impl HardwareComponent for Relay {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().set_pin_mode(self.config.pin, pin_mode::OUTPUT)?;
        self.close(ctx)
    }
}

impl ComponentBuilder for Relay {
    type Config = RelayConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

#[cfg(test)]
mod sim_tests {
    use crate::firmata::sim::rig::{node, SimRig};
    use crate::firmata::sim::{BoardLayout, SimBoard};
    use crate::firmata::MODE_OUTPUT;
    use serde_json::json;

    fn relay(kind: &str) -> SimRig {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(vec![node("relay", "Relay", json!({ "pin": 10, "type": kind }))], vec![]);
        rig
    }

    #[test]
    fn normally_open_relay_energises_the_coil_to_open() {
        let mut rig = relay("NO");
        assert_eq!(rig.board.pin(10).mode(), Some(MODE_OUTPUT));
        assert!(!rig.board.pin(10).is_high(), "starts closed: coil off");
        rig.dispatch("relay", "true", true);
        assert!(rig.board.pin(10).is_high());
        rig.dispatch("relay", "toggle", true);
        assert!(!rig.board.pin(10).is_high());
    }

    #[test]
    fn normally_closed_relay_holds_the_coil_while_closed() {
        let mut rig = relay("NC");
        assert!(rig.board.pin(10).is_high(), "starts closed: coil on");
        rig.dispatch("relay", "true", true);
        assert!(!rig.board.pin(10).is_high());
        rig.dispatch("relay", "false", true);
        assert!(rig.board.pin(10).is_high());
    }
}
