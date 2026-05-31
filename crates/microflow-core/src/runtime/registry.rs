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
type Factory = Box<dyn Fn(String, &serde_json::Value) -> Result<Box<dyn Component>, RuntimeError>>;

/// Maps catalog instance names to component factories.
pub struct ComponentRegistry {
    entries: HashMap<&'static str, Factory>,
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
        self.entries.insert(name, make_factory::<B>(name));
    }

    /// Register every phase-1 (non-cloud) catalog entry. Expanded as the
    /// workflow fan-out lands the remaining node ports.
    fn register_all(&mut self) {
        use crate::runtime::{input, output, transformation};

        // output
        self.register::<output::Led>("Led");
        self.register::<output::Led>("Vibration");

        // input — Sensor backs several catalog entries.
        self.register::<input::Sensor>("Sensor");
        self.register::<input::Sensor>("Force");
        self.register::<input::Sensor>("HallEffect");
        self.register::<input::Sensor>("Ldr");
        self.register::<input::Sensor>("Potentiometer");
        self.register::<input::Sensor>("Tilt");

        // transformation
        self.register::<transformation::Gate>("Gate");
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
