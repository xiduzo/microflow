//! Component Registry
//!
//! Provides a centralized way to create components by name, eliminating
//! the massive match statement in `FlowRuntime::create_component`.

use super::base::{BoardHandle, Component, ComponentEvent};
use super::control::{Counter, CounterConfig, Delay, DelayConfig, Trigger, TriggerConfig};
use super::external::{Figma, FigmaConfig, Llm, LlmConfig, Mqtt, MqttConfig};
use super::generator::{Constant, ConstantConfig, Interval, IntervalConfig, Oscillator, OscillatorConfig};
use super::input::{Button, ButtonConfig, Hotkey, HotkeyConfig, Motion, MotionConfig, Proximity, ProximityConfig, Sensor, SensorConfig, Switch, SwitchConfig};
use super::output::{Led, LedConfig, Matrix, MatrixConfig, Monitor, MonitorConfig, Piezo, PiezoConfig, Relay, RelayConfig, Rgb, RgbConfig, Servo, ServoConfig};
use super::transformation::{Calculate, CalculateConfig, Compare, CompareConfig, Gate, GateConfig, RangeMap, RangeMapConfig, Smooth, SmoothConfig};
use crate::error::RuntimeError;
use std::sync::Arc;
use tokio::sync::mpsc;

use serde::Deserialize;

/// Deserialize a config from a `&serde_json::Value` without cloning.
/// Falls back to `Default` on parse failure.
fn parse_config<'de, T: Deserialize<'de> + Default>(data: &'de serde_json::Value) -> T {
    T::deserialize(data).unwrap_or_default()
}

/// Factory function type for creating components
type ComponentFactory = fn(id: String, data: &serde_json::Value) -> Box<dyn Component>;

/// Registry entry with factory and metadata
struct RegistryEntry {
    factory: ComponentFactory,
    requires_hardware: bool,
}

/// Component registry for creating components by instance name
pub struct ComponentRegistry {
    entries: std::collections::HashMap<&'static str, RegistryEntry>,
}

impl ComponentRegistry {
    pub fn new() -> Self {
        let mut registry = Self {
            entries: std::collections::HashMap::new(),
        };
        registry.register_all();
        registry
    }

    /// Create a component by instance name
    pub fn create(
        &self,
        id: &str,
        instance: &str,
        data: &serde_json::Value,
        event_sender: mpsc::UnboundedSender<ComponentEvent>,
        board_handle: Arc<BoardHandle>,
    ) -> Result<Box<dyn Component>, RuntimeError> {
        let entry = self.entries.get(instance)
            .ok_or_else(|| RuntimeError::ComponentNotFound(format!("Unknown component type: {instance}")))?;

        let mut component = (entry.factory)(id.to_string(), data);
        component.set_event_sender(event_sender);

        // Initialize hardware components if board is connected
        if entry.requires_hardware && board_handle.is_connected() {
            component.initialize(board_handle)?;
        }

        Ok(component)
    }

    /// Check if a component type exists
    #[allow(dead_code)]
    pub fn exists(&self, instance: &str) -> bool {
        self.entries.contains_key(instance)
    }

    /// Get list of all registered component types
    #[allow(dead_code)]
    pub fn component_types(&self) -> Vec<&'static str> {
        self.entries.keys().copied().collect()
    }

    fn register_all(&mut self) {
        // Output components (require hardware)
        self.register_hardware("Led", |id, data| {
            Box::new(Led::new(id, parse_config::<LedConfig>(data)))
        });
        self.register_hardware("Servo", |id, data| {
            Box::new(Servo::new(id, parse_config::<ServoConfig>(data)))
        });
        self.register_hardware("Rgb", |id, data| {
            Box::new(Rgb::new(id, parse_config::<RgbConfig>(data)))
        });
        self.register_hardware("Relay", |id, data| {
            Box::new(Relay::new(id, parse_config::<RelayConfig>(data)))
        });
        self.register_hardware("Piezo", |id, data| {
            let config: PiezoConfig = match PiezoConfig::deserialize(data) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("Failed to parse PiezoConfig: {e}, using defaults");
                    PiezoConfig::default()
                }
            };
            Box::new(Piezo::new(id, config))
        });
        self.register_hardware("Matrix", |id, data| {
            Box::new(Matrix::new(id, parse_config::<MatrixConfig>(data)))
        });

        // Monitor (software only - display component)
        self.register_software("Monitor", |id, data| {
            Box::new(Monitor::new(id, parse_config::<MonitorConfig>(data)))
        });

        // Input components (require hardware)
        self.register_hardware("Button", |id, data| {
            Box::new(Button::new(id, parse_config::<ButtonConfig>(data)))
        });
        self.register_hardware("Sensor", |id, data| {
            Box::new(Sensor::new(id, parse_config::<SensorConfig>(data)))
        });
        self.register_hardware("Motion", |id, data| {
            Box::new(Motion::new(id, parse_config::<MotionConfig>(data)))
        });
        self.register_hardware("Proximity", |id, data| {
            Box::new(Proximity::new(id, parse_config::<ProximityConfig>(data)))
        });
        self.register_hardware("Switch", |id, data| {
            Box::new(Switch::new(id, parse_config::<SwitchConfig>(data)))
        });

        // Hotkey (software only - keyboard input)
        self.register_software("Hotkey", |id, data| {
            Box::new(Hotkey::new(id, parse_config::<HotkeyConfig>(data)))
        });

        // Control components (software only)
        self.register_software("Counter", |id, data| {
            Box::new(Counter::new(id, parse_config::<CounterConfig>(data)))
        });
        self.register_software("Delay", |id, data| {
            Box::new(Delay::new(id, parse_config::<DelayConfig>(data)))
        });
        self.register_software("Trigger", |id, data| {
            Box::new(Trigger::new(id, parse_config::<TriggerConfig>(data)))
        });

        // Generator components (software only)
        self.register_software("Constant", |id, data| {
            Box::new(Constant::new(id, parse_config::<ConstantConfig>(data)))
        });
        self.register_software("Interval", |id, data| {
            Box::new(Interval::new(id, parse_config::<IntervalConfig>(data)))
        });
        self.register_software("Oscillator", |id, data| {
            Box::new(Oscillator::new(id, parse_config::<OscillatorConfig>(data)))
        });

        // Transformation components (software only)
        self.register_software("Calculate", |id, data| {
            Box::new(Calculate::new(id, parse_config::<CalculateConfig>(data)))
        });
        self.register_software("Compare", |id, data| {
            Box::new(Compare::new(id, parse_config::<CompareConfig>(data)))
        });
        self.register_software("Gate", |id, data| {
            Box::new(Gate::new(id, parse_config::<GateConfig>(data)))
        });
        self.register_software("RangeMap", |id, data| {
            Box::new(RangeMap::new(id, parse_config::<RangeMapConfig>(data)))
        });
        self.register_software("Smooth", |id, data| {
            Box::new(Smooth::new(id, parse_config::<SmoothConfig>(data)))
        });

        // LLM component (software only - HTTP/AI inference)
        self.register_software("Llm", |id, data| {
            Box::new(Llm::new(id, parse_config::<LlmConfig>(data)))
        });

        // External components (software only - network/IoT)
        self.register_software("Mqtt", |id, data| {
            Box::new(Mqtt::new(id, parse_config::<MqttConfig>(data)))
        });
        self.register_software("Figma", |id, data| {
            Box::new(Figma::new(id, parse_config::<FigmaConfig>(data)))
        });
    }

    fn register_hardware(&mut self, name: &'static str, factory: ComponentFactory) {
        self.entries.insert(name, RegistryEntry { factory, requires_hardware: true });
    }

    fn register_software(&mut self, name: &'static str, factory: ComponentFactory) {
        self.entries.insert(name, RegistryEntry { factory, requires_hardware: false });
    }
}

impl Default for ComponentRegistry {
    fn default() -> Self {
        Self::new()
    }
}
