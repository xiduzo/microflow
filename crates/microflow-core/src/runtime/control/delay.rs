//! Delay Component — Control. Template port for the workflow node fan-out.
//!
//! Note vs. the desktop original: the `std::thread::spawn` + `sleep` + cancel
//! flag is gone. A `trigger` stores the incoming value (without emitting) and
//! arms a `_tick` wakeup at `delay`; `dispatch_internal("tick", …)` emits the
//! stored value on the "event" handle. `forget_previous` cancels the pending
//! `_tick` before re-arming, so only the latest trigger fires — replacing the
//! desktop's `AtomicBool` cancellation flag.

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext, RuntimeError,
};
// `DelayConfig` moved to the ungated `config::delay` module so the codegen
// emitter shares the exact same fields + defaults (single source of truth — see
// `crate::config`). Re-exported so this module's impls are unchanged.
pub use crate::config::delay::DelayConfig;

pub struct Delay {
    base: ComponentBase,
    config: DelayConfig,
}

impl Delay {
    #[must_use]
    pub fn new(id: String, config: DelayConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
        }
    }

    fn signal(&mut self, value: ComponentValue, ctx: &mut RuntimeContext) {
        if self.config.forget_previous {
            // Drop the pending wakeup so only the latest trigger fires its event.
            ctx.cancel_wakeup("_tick");
        }

        // Store value without emitting (delay stores input now, emits later on
        // the `_tick` wakeup, whose value is this stored `base.value`).
        self.base.value = value;
        ctx.schedule_wakeup("_tick", self.config.delay);
    }
}

impl Component for Delay {
    fn ports() -> &'static [&'static str] {
        &["trigger"]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Delay"
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "trigger" => {
                self.signal(args, ctx);
                Ok(())
            }
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
            // Delay elapsed: emit the stored value on the "event" handle.
            "tick" => {
                self.base.emit("event");
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

impl ComponentBuilder for Delay {
    type Config = DelayConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
