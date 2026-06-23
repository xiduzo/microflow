//! Smooth Component — Transformation. Low-pass / moving-average smoothing.

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext, RuntimeError,
};
// `SmoothConfig` + `SmoothType` moved to the ungated `config::smooth` module so
// the codegen emitter shares the exact same fields + defaults (single source of
// truth — see `crate::config`). Re-exported so this module's impls/tests are
// unchanged.
pub use crate::config::smooth::{SmoothConfig, SmoothType};

pub struct Smooth {
    base: ComponentBase,
    config: SmoothConfig,
    history: Vec<f64>,
    seeded: bool,
}

impl Smooth {
    #[must_use]
    pub fn new(id: String, config: SmoothConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            history: Vec::new(),
            seeded: false,
        }
    }

    fn signal(&mut self, value: &ComponentValue) {
        let value_num = value.as_number().unwrap_or(0.0);
        match self.config.smooth_type {
            SmoothType::MovingAverage => self.moving_average(value_num),
            SmoothType::Smooth => self.smooth(value_num),
        }
    }

    fn smooth(&mut self, value: f64) {
        let attenuation = self.config.attenuation;
        // Exponential low-pass: `attenuation` is how much of the previous
        // running value is retained (the damping factor). High attenuation
        // (default 0.995) keeps almost all history and lets only a sliver of
        // the new sample through, which is what actually smooths the signal.
        //
        // Seed the running value with the first sample so the output starts at
        // the signal instead of ramping up from 0.0 ("slow to wake").
        let result = if self.seeded {
            let current = self.base.value.as_number().unwrap_or(0.0);
            (1.0 - attenuation) * value + attenuation * current
        } else {
            self.seeded = true;
            value
        };
        self.base.set_value(ComponentValue::Number(result));
    }

    fn moving_average(&mut self, value: f64) {
        self.history.push(value);
        if self.history.len() > self.config.window_size {
            self.history.remove(0);
        }
        let sum: f64 = self.history.iter().sum();
        let avg = sum / self.history.len() as f64;
        self.base.set_value(ComponentValue::Number(avg));
    }
}

impl Component for Smooth {
    fn ports() -> &'static [&'static str] {
        &["value"]
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
        "Smooth"
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "value" => {
                self.signal(&args);
                Ok(())
            }
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn destroy(&mut self) {
        self.history.clear();
        self.seeded = false;
    }
}

impl ComponentBuilder for Smooth {
    type Config = SmoothConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed `samples` through a fresh Smooth and return the final output.
    fn run(config: SmoothConfig, samples: &[f64]) -> f64 {
        let mut s = Smooth::new("s".into(), config);
        for &v in samples {
            s.signal(&ComponentValue::Number(v));
        }
        s.base.value.as_number().unwrap()
    }

    #[test]
    fn first_sample_seeds_output() {
        // No ramp-from-zero: the very first sample lands on the output as-is.
        let out = run(SmoothConfig::default(), &[42.0]);
        assert!((out - 42.0).abs() < f64::EPSILON, "first sample should seed, got {out}");
    }

    #[test]
    fn smooth_heavily_damps_after_seed() {
        // Seed at 0.0, then a 100.0 sample must barely nudge the output.
        // Pre-fix this was ~99.5 (passthrough) — guard for the inverted weights.
        let out = run(SmoothConfig::default(), &[0.0, 100.0]);
        assert!(out < 1.0, "step should be heavily damped, got {out}");
    }

    #[test]
    fn smooth_converges_toward_constant_input() {
        let out = run(SmoothConfig::default(), &[100.0; 2000]);
        assert!(out > 99.0, "should converge near the input, got {out}");
    }

    #[test]
    fn smooth_reduces_swing_of_noisy_signal() {
        // Square wave 0/100 (mean 50). A working low-pass holds the output
        // near the mean instead of swinging the full 100-wide range.
        let mut s = Smooth::new("s".into(), SmoothConfig::default());
        let (mut lo, mut hi) = (f64::MAX, f64::MIN);
        for i in 0..4000 {
            s.signal(&ComponentValue::Number(if i % 2 == 0 { 0.0 } else { 100.0 }));
            if i > 1000 {
                let o = s.base.value.as_number().unwrap();
                lo = lo.min(o);
                hi = hi.max(o);
            }
        }
        assert!(hi - lo < 5.0, "smoothed swing too large: {lo}..{hi}");
    }

    #[test]
    fn attenuation_zero_is_passthrough() {
        let cfg = SmoothConfig { attenuation: 0.0, ..SmoothConfig::default() };
        let out = run(cfg, &[0.0, 100.0]);
        assert!((out - 100.0).abs() < f64::EPSILON, "att=0 must pass through, got {out}");
    }

    #[test]
    fn moving_average_returns_window_mean() {
        let cfg = SmoothConfig {
            smooth_type: SmoothType::MovingAverage,
            window_size: 4,
            ..SmoothConfig::default()
        };
        let out = run(cfg, &[10.0, 20.0, 30.0, 40.0]);
        assert!((out - 25.0).abs() < f64::EPSILON, "got {out}");
    }
}
