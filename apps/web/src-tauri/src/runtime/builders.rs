//! Catalog [`ComponentBuilder`] impls for every entry in `node-components.json`.
//!
//! Each impl plugs a Component into the registry by declaring its `Config`
//! type and a `build` constructor. Almost all impls reduce to
//! `Ok(Self::new(id, config))`; the `Llm` entry pulls the shared
//! [`super::services::LlmRegistry`] out of [`RuntimeContext`] so it can
//! resolve a provider by id at dispatch time (per ADR-0002).
//!
//! Keeping these impls in one module avoids editing 30+ component files when
//! the registry contract evolves. The catalog flag `usesRuntimeContext` is no
//! longer load-bearing: every builder takes a `RuntimeContext` and the ones
//! that don't need it simply ignore the argument.

use std::sync::Arc;

use crate::error::RuntimeError;

use super::component::ComponentBuilder;
use super::context::RuntimeContext;

// --- input --------------------------------------------------------------

impl ComponentBuilder for super::input::Button {
    type Config = super::input::ButtonConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::input::Hotkey {
    type Config = super::input::HotkeyConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::input::I2cDevice {
    type Config = super::input::I2cDeviceConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::input::Motion {
    type Config = super::input::MotionConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::input::Proximity {
    type Config = super::input::ProximityConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::input::Sensor {
    type Config = super::input::SensorConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::input::Switch {
    type Config = super::input::SwitchConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

// --- output -------------------------------------------------------------

impl ComponentBuilder for super::output::Led {
    type Config = super::output::LedConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Matrix {
    type Config = super::output::MatrixConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Monitor {
    type Config = super::output::MonitorConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Piezo {
    type Config = super::output::PiezoConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Pixel {
    type Config = super::output::PixelConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Relay {
    type Config = super::output::RelayConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Rgb {
    type Config = super::output::RgbConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Servo {
    type Config = super::output::ServoConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Stepper {
    type Config = super::output::StepperConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

// --- transformation -----------------------------------------------------

impl ComponentBuilder for super::transformation::Calculate {
    type Config = super::transformation::CalculateConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::transformation::Compare {
    type Config = super::transformation::CompareConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::transformation::Function {
    type Config = super::transformation::FunctionConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::transformation::Gate {
    type Config = super::transformation::GateConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::transformation::RangeMap {
    type Config = super::transformation::RangeMapConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::transformation::Smooth {
    type Config = super::transformation::SmoothConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

// --- control ------------------------------------------------------------

impl ComponentBuilder for super::control::Counter {
    type Config = super::control::CounterConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::control::Delay {
    type Config = super::control::DelayConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::control::Trigger {
    type Config = super::control::TriggerConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

// --- generator ----------------------------------------------------------

impl ComponentBuilder for super::generator::Constant {
    type Config = super::generator::ConstantConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::generator::Interval {
    type Config = super::generator::IntervalConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::generator::Oscillator {
    type Config = super::generator::OscillatorConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

// --- external -----------------------------------------------------------

impl ComponentBuilder for super::external::Figma {
    type Config = super::external::FigmaConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::external::Mqtt {
    type Config = super::external::MqttConfig;
    fn build(id: String, config: Self::Config, _ctx: &RuntimeContext) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

/// `Llm` is the one Catalog entry that consults [`RuntimeContext`]: it pulls
/// the shared [`super::services::LlmRegistry`] handle out of the context and
/// hands it to the component, which then resolves its `provider_id` against
/// the registry at dispatch time (ADR-0002, Phase 2).
impl ComponentBuilder for super::external::Llm {
    type Config = super::external::LlmConfig;
    fn build(
        id: String,
        config: Self::Config,
        ctx: &RuntimeContext,
    ) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config, Arc::clone(&ctx.llm_registry)))
    }
}
