//! Component registry: builds a `Box<dyn Component>` from a catalog instance
//! name + its node `data` JSON.
//!
//! Phase-1 core is hand-registered (the desktop's `build.rs` codegen from
//! `node-components.json` + the port-drift assertion + the `register_hardware`
//! bound are dropped here; hardware is detected at runtime via
//! `Component::as_hardware_mut`). Catalog entry aliases that share an impl
//! (e.g. `Force`/`Ldr`/`Potentiometer` → `Sensor`, `Vibration` → `Led`) each
//! get their own `register` line.

use crate::runtime::{Component, ComponentBuilder, RuntimeError};
use serde::Deserialize;
use std::collections::HashMap;

/// Builds a component from its id + node `data`. Deserialization failure surfaces
/// as [`RuntimeError::ConfigDeserialize`] — no silent `Default` fallback.
pub type Factory = Box<dyn Fn(String, &serde_json::Value) -> Result<Box<dyn Component>, RuntimeError>>;

/// Maps catalog instance names to component factories.
///
/// The built-in (phase-1, non-cloud) nodes are registered in [`register_all`].
/// A host may inject further nodes via [`register_factory`] — the desktop uses
/// this for the cloud nodes (mqtt/llm/figma), whose async/network impls stay in
/// the desktop crate (closures capture the live services) so core pulls no
/// tokio/reqwest/mqtt dependencies.
pub struct ComponentRegistry {
    entries: HashMap<String, Factory>,
}

impl ComponentRegistry {
    #[must_use]
    pub fn new() -> Self {
        let mut registry = Self { entries: HashMap::new() };
        registry.register_all();
        registry
    }

    /// Create a component by catalog instance name.
    pub fn create(
        &self,
        id: &str,
        instance: &str,
        data: &serde_json::Value,
    ) -> Result<Box<dyn Component>, RuntimeError> {
        let factory = self
            .entries
            .get(instance)
            .ok_or_else(|| RuntimeError::ComponentNotFound(format!("Unknown component type: {instance}")))?;
        factory(id.to_string(), data)
    }

    /// Whether a catalog instance name is registered.
    #[must_use]
    pub fn exists(&self, instance: &str) -> bool {
        self.entries.contains_key(instance)
    }

    fn register<B: ComponentBuilder>(&mut self, name: &'static str) {
        self.entries.insert(name.to_string(), make_factory::<B>(name));
    }

    /// Inject an externally-built component factory under `name`. Used by a host
    /// to add nodes core doesn't ship (e.g. the desktop's cloud nodes, whose
    /// closures capture the live MQTT/LLM services). Overrides any existing
    /// entry of the same name.
    pub fn register_factory(&mut self, name: &str, factory: Factory) {
        self.entries.insert(name.to_string(), factory);
    }

    /// Register every phase-1 (non-cloud) catalog entry. Several catalog entry
    /// names share one impl (aliases). `Constant`, `Oscillator`, `RangeMap`,
    /// `Smooth`, and `Function` (js) are registered once their ports land.
    fn register_all(&mut self) {
        use crate::runtime::{control, input, output, transformation};

        // input
        self.register::<input::button::Button>("Button");
        self.register::<input::hotkey::Hotkey>("Hotkey");
        self.register::<input::i2c_device::I2cDevice>("I2cDevice");
        self.register::<input::motion::Motion>("Motion");
        self.register::<input::proximity::Proximity>("Proximity");
        self.register::<input::switch::Switch>("Switch");
        // Sensor backs several catalog entries.
        self.register::<input::sensor::Sensor>("Sensor");
        self.register::<input::sensor::Sensor>("Force");
        self.register::<input::sensor::Sensor>("HallEffect");
        self.register::<input::sensor::Sensor>("Ldr");
        self.register::<input::sensor::Sensor>("Potentiometer");
        self.register::<input::sensor::Sensor>("Tilt");

        // output
        self.register::<output::led::Led>("Led");
        self.register::<output::led::Led>("Vibration");
        self.register::<output::matrix::Matrix>("Matrix");
        self.register::<output::monitor::Monitor>("Monitor");
        self.register::<output::piezo::Piezo>("Piezo");
        self.register::<output::pixel::Pixel>("Pixel");
        self.register::<output::relay::Relay>("Relay");
        self.register::<output::rgb::Rgb>("Rgb");
        self.register::<output::servo::Servo>("Servo");
        self.register::<output::stepper::Stepper>("Stepper");

        // control
        self.register::<control::counter::Counter>("Counter");
        self.register::<control::delay::Delay>("Delay");
        self.register::<control::trigger::Trigger>("Trigger");

        // generator
        self.register::<crate::runtime::generator::constant::Constant>("Constant");
        self.register::<crate::runtime::generator::interval::Interval>("Interval");
        self.register::<crate::runtime::generator::oscillator::Oscillator>("Oscillator");

        // transformation
        self.register::<transformation::calculate::Calculate>("Calculate");
        self.register::<transformation::compare::Compare>("Compare");
        self.register::<transformation::gate::Gate>("Gate");
        self.register::<transformation::range_map::RangeMap>("RangeMap");
        self.register::<transformation::smooth::Smooth>("Smooth");
        #[cfg(feature = "js")]
        self.register::<transformation::function::Function>("Function");
    }
}

impl Default for ComponentRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn make_factory<B: ComponentBuilder>(name: &'static str) -> Factory {
    Box::new(move |id, data| {
        let config = B::Config::deserialize(data).map_err(|e| RuntimeError::ConfigDeserialize {
            component: name.to_string(),
            source: e,
        })?;
        let component = B::build(id, config)?;
        Ok(Box::new(component) as Box<dyn Component>)
    })
}
