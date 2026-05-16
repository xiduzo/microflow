//! Catalog [`ComponentBuilder`] impls for every entry in `node-components.json`.
//!
//! Each impl plugs a Component into the registry by declaring its
//! [`Config`](ComponentBuilder::Config) type, its
//! [`Deps`](ComponentBuilder::Deps) — the typed slice of
//! [`super::services::RuntimeServices`] it needs — and a `build`
//! constructor. Almost all impls reduce to `Ok(Self::new(id, config))`
//! with `type Deps = ();` the three `external/` impls declare what they
//! actually pull from the services bundle:
//!
//! - `Llm` declares `Deps = Arc<LlmRegistry>` so it can resolve providers
//!   at dispatch time (ADR-0002 Phase 2).
//! - `Mqtt` / `Figma` declare `Deps = Arc<dyn MqttPublisher>` so they can
//!   publish directly through the capability trait (ADR-0002 Phase 3).
//!
//! Keeping these impls in one module avoids editing 30+ component files
//! when the registry contract evolves.

use std::sync::Arc;

use crate::error::RuntimeError;

use super::component::ComponentBuilder;
use super::services::{LlmRegistry, MqttPublisher};

// --- input --------------------------------------------------------------

impl ComponentBuilder for super::input::Button {
    type Config = super::input::ButtonConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::input::Hotkey {
    type Config = super::input::HotkeyConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::input::I2cDevice {
    type Config = super::input::I2cDeviceConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::input::Motion {
    type Config = super::input::MotionConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::input::Proximity {
    type Config = super::input::ProximityConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::input::Sensor {
    type Config = super::input::SensorConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::input::Switch {
    type Config = super::input::SwitchConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

// --- output -------------------------------------------------------------

impl ComponentBuilder for super::output::Led {
    type Config = super::output::LedConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Matrix {
    type Config = super::output::MatrixConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Monitor {
    type Config = super::output::MonitorConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Piezo {
    type Config = super::output::PiezoConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Pixel {
    type Config = super::output::PixelConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Relay {
    type Config = super::output::RelayConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Rgb {
    type Config = super::output::RgbConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Servo {
    type Config = super::output::ServoConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::output::Stepper {
    type Config = super::output::StepperConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

// --- transformation -----------------------------------------------------

impl ComponentBuilder for super::transformation::Calculate {
    type Config = super::transformation::CalculateConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::transformation::Compare {
    type Config = super::transformation::CompareConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::transformation::Function {
    type Config = super::transformation::FunctionConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::transformation::Gate {
    type Config = super::transformation::GateConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::transformation::RangeMap {
    type Config = super::transformation::RangeMapConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::transformation::Smooth {
    type Config = super::transformation::SmoothConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

// --- control ------------------------------------------------------------

impl ComponentBuilder for super::control::Counter {
    type Config = super::control::CounterConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::control::Delay {
    type Config = super::control::DelayConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::control::Trigger {
    type Config = super::control::TriggerConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

// --- generator ----------------------------------------------------------

impl ComponentBuilder for super::generator::Constant {
    type Config = super::generator::ConstantConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::generator::Interval {
    type Config = super::generator::IntervalConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

impl ComponentBuilder for super::generator::Oscillator {
    type Config = super::generator::OscillatorConfig;
    type Deps = ();
    fn build(id: String, config: Self::Config, _deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

// --- external -----------------------------------------------------------

impl ComponentBuilder for super::external::Figma {
    type Config = super::external::FigmaConfig;
    type Deps = Arc<dyn MqttPublisher>;
    fn build(id: String, config: Self::Config, deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config, deps))
    }
}

impl ComponentBuilder for super::external::Mqtt {
    type Config = super::external::MqttConfig;
    type Deps = Arc<dyn MqttPublisher>;
    fn build(id: String, config: Self::Config, deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config, deps))
    }
}

/// `Llm` is the one Catalog entry that needs the LLM registry: it pulls the
/// shared [`LlmRegistry`] handle and hands it to the component, which then
/// resolves its `provider_id` against the registry at dispatch time
/// (ADR-0002 Phase 2).
impl ComponentBuilder for super::external::Llm {
    type Config = super::external::LlmConfig;
    type Deps = Arc<LlmRegistry>;
    fn build(id: String, config: Self::Config, deps: Self::Deps) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config, deps))
    }
}
