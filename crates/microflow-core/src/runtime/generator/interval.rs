//! Interval Component — Generator (software timer).
//!
//! Note vs. the desktop original: the `std::thread` + `std::thread::sleep`
//! self-emit loop and its `Arc<AtomicBool>` "running" flag are dropped. Timing
//! is sans-IO now: `start` arms a wakeup via `ctx.schedule_wakeup("_tick", …)`,
//! `dispatch_internal("tick", …)` emits the elapsed-time event and re-arms, and
//! `stop` cancels via `ctx.cancel_wakeup("_tick")`. Auto-start moves from
//! `set_event_sender` to `on_start`. Elapsed time is read from `ctx.now_ms()`.

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext, RuntimeError,
};
use std::borrow::Cow;
// `IntervalConfig` moved to the ungated `config::interval` module so the codegen
// emitter shares the exact same fields + defaults (single source of truth — see
// `crate::config`). Re-exported so this module's impls are unchanged.
pub use crate::config::interval::IntervalConfig;

const MIN_INTERVAL_MS: u64 = 16;

pub struct Interval {
    base: ComponentBase,
    config: IntervalConfig,
    /// `now_ms` captured when the interval (re)started, so each tick can report
    /// elapsed time like the desktop node did.
    started_at_ms: Option<f64>,
}

impl Interval {
    #[must_use]
    pub fn new(id: String, config: IntervalConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            started_at_ms: None,
        }
    }

    /// Period the timer fires at, floored at `MIN_INTERVAL_MS`.
    fn period_ms(&self) -> u64 {
        self.config.interval.max(MIN_INTERVAL_MS)
    }

    fn start(&mut self, ctx: &mut RuntimeContext) {
        // Cancel any outstanding tick before re-arming, mirroring the desktop
        // `self.stop()` at the top of `start`.
        ctx.cancel_wakeup("_tick");
        self.started_at_ms = Some(ctx.now_ms());
        ctx.schedule_wakeup("_tick", self.period_ms());
    }

    fn stop(&mut self, ctx: &mut RuntimeContext) {
        ctx.cancel_wakeup("_tick");
        self.started_at_ms = None;
    }

    /// Fired by the runtime when the `_tick` wakeup elapses: emit elapsed-ms on
    /// the `event` handle and re-arm for the next period.
    fn tick(&mut self, ctx: &mut RuntimeContext) {
        let elapsed = match self.started_at_ms {
            Some(start) => ctx.now_ms() - start,
            // No active start window (e.g. a stray wakeup after stop): swallow it.
            None => return,
        };
        self.base
            .emit_with_value("event", Cow::Owned(ComponentValue::Number(elapsed)));
        ctx.schedule_wakeup("_tick", self.period_ms());
    }
}

impl Component for Interval {
    fn ports() -> &'static [&'static str] {
        &["start", "stop"]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Interval"
    }

    fn dispatch(
        &mut self,
        method: &str,
        _args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "start" => {
                self.start(ctx);
                Ok(())
            }
            "stop" => {
                self.stop(ctx);
                Ok(())
            }
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn dispatch_internal(
        &mut self,
        method: &str,
        _value: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "tick" => {
                self.tick(ctx);
                Ok(())
            }
            _ => Err(RuntimeError::ComponentError(format!("Unknown internal method: {method}"))),
        }
    }

    fn on_start(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        if self.config.auto_start {
            self.start(ctx);
        }
        Ok(())
    }
}

impl ComponentBuilder for Interval {
    type Config = IntervalConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
