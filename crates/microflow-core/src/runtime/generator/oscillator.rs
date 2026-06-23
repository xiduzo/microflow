//! Oscillator Component — Generator. Emits a periodic waveform.
//!
//! The desktop drove this from a 60 FPS `std::thread` + `Instant`. Here it is a
//! `schedule_wakeup` chain on the host clock: `start` arms `_tick`, each tick
//! computes the waveform from `now_ms() - start_ms`, emits, and re-arms.

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext, RuntimeError,
};
use std::borrow::Cow;
// `OscillatorConfig` + `Waveform` moved to the ungated `config::oscillator`
// module so the codegen emitter shares the exact same fields + defaults (single
// source of truth — see `crate::config`). Re-exported so this module's impls and
// waveform helpers are unchanged.
pub use crate::config::oscillator::{OscillatorConfig, Waveform};

/// ~60 FPS refresh.
const REFRESH_MS: u64 = 1000 / 60;

pub struct Oscillator {
    base: ComponentBase,
    config: OscillatorConfig,
    running: bool,
    start_ms: f64,
}

impl Oscillator {
    #[must_use]
    pub fn new(id: String, config: OscillatorConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            running: false,
            start_ms: 0.0,
        }
    }

    fn start(&mut self, ctx: &mut RuntimeContext) {
        self.running = true;
        self.start_ms = ctx.now_ms();
        ctx.schedule_wakeup("_tick", REFRESH_MS);
    }

    fn stop(&mut self, ctx: &mut RuntimeContext) {
        self.running = false;
        ctx.cancel_wakeup("_tick");
    }

    fn reset(&mut self, ctx: &mut RuntimeContext) {
        let was_running = self.running;
        self.stop(ctx);
        if was_running {
            self.start(ctx);
        }
    }

    fn tick(&mut self, ctx: &mut RuntimeContext) {
        if !self.running {
            return;
        }
        let elapsed = ctx.now_ms() - self.start_ms;
        let value = calculate_waveform(&self.config, elapsed);
        self.base.emit_with_value(ComponentBase::VALUE_HANDLE, Cow::Owned(ComponentValue::Number(value)));
        ctx.schedule_wakeup("_tick", REFRESH_MS);
    }
}

fn calculate_waveform(config: &OscillatorConfig, timestamp: f64) -> f64 {
    match config.waveform {
        Waveform::Sinus => sinus(config, timestamp),
        Waveform::Square => square(config, timestamp),
        Waveform::Sawtooth => sawtooth(config, timestamp),
        Waveform::Triangle => triangle(config, timestamp),
        Waveform::Random => random(config, timestamp),
    }
}

fn sinus(config: &OscillatorConfig, timestamp: f64) -> f64 {
    let t = timestamp + config.phase;
    let freq0 = 2.0 * std::f64::consts::PI / config.period;
    config.amplitude * (t * freq0).sin() + config.shift
}

fn square(config: &OscillatorConfig, timestamp: f64) -> f64 {
    let mut t = timestamp + config.phase;
    let value = if t >= 0.0 {
        if t >= config.period {
            t %= config.period;
        }
        if t * 2.0 < config.period { config.amplitude } else { -config.amplitude }
    } else {
        t = -t;
        if t >= config.period {
            t %= config.period;
        }
        if t * 2.0 < config.period { -config.amplitude } else { config.amplitude }
    };
    value + config.shift
}

fn sawtooth(config: &OscillatorConfig, timestamp: f64) -> f64 {
    let mut t = timestamp + config.phase;
    let freq2 = 2.0 / config.period;
    let value = if t >= 0.0 {
        if t >= config.period {
            t %= config.period;
        }
        config.amplitude * (-1.0 + t * freq2)
    } else {
        t = -t;
        if t >= config.period {
            t %= config.period;
        }
        config.amplitude * (1.0 - t * freq2)
    };
    value + config.shift
}

fn triangle(config: &OscillatorConfig, timestamp: f64) -> f64 {
    let mut t = timestamp + config.phase;
    if t < 0.0 {
        t = -t;
    }
    if t >= config.period {
        t %= config.period;
    }
    let freq4 = 4.0 / config.period;
    let value = if t * 2.0 < config.period {
        config.amplitude * (-1.0 + t * freq4)
    } else {
        config.amplitude * (3.0 - t * freq4)
    };
    value + config.shift
}

/// Pseudo-random in [0, shift+amplitude). Sin-hash of the timestamp instead of
/// the `rand` crate, so the core stays free of `getrandom` (wasm-clean).
fn random(config: &OscillatorConfig, timestamp: f64) -> f64 {
    let r = ((timestamp * 12.9898).sin() * 43758.5453).fract().abs();
    (config.shift + config.amplitude) * r
}

impl Component for Oscillator {
    fn ports() -> &'static [&'static str] {
        &["start", "stop", "reset"]
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
        "Oscillator"
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
            "reset" => {
                self.reset(ctx);
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
        if method == "tick" {
            self.tick(ctx);
        }
        Ok(())
    }

    fn on_start(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        if self.config.auto_start {
            self.start(ctx);
        }
        Ok(())
    }
}

impl ComponentBuilder for Oscillator {
    type Config = OscillatorConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
