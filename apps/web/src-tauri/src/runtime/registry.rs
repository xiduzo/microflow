//! Component Registry
//!
//! Provides a centralized way to create components by name, eliminating
//! the massive match statement in `FlowRuntime::create_component`.

use super::base::{BoardHandle, Component, ComponentEvent};
use super::control::{Counter, CounterConfig, Delay, DelayConfig, Trigger, TriggerConfig};
use super::external::{Figma, FigmaConfig, Llm, LlmConfig, Mqtt, MqttConfig};
use super::generator::{Constant, ConstantConfig, Interval, IntervalConfig, Oscillator, OscillatorConfig};
use super::input::{Button, ButtonConfig, Motion, MotionConfig, Proximity, ProximityConfig, Sensor, SensorConfig};
use super::output::{Led, LedConfig, Monitor, MonitorConfig, Piezo, PiezoConfig, Relay, RelayConfig, Rgb, RgbConfig, Servo, ServoConfig};
use super::transformation::{Calculate, CalculateConfig, Compare, CompareConfig, Gate, GateConfig, RangeMap, RangeMapConfig, Smooth, SmoothConfig};
use std::sync::Arc;
use tokio::sync::mpsc;

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
    ) -> Result<Box<dyn Component>, String> {
        let entry = self.entries.get(instance)
            .ok_or_else(|| format!("Unknown component type: {instance}"))?;

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
            let config: LedConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Led::new(id, config))
        });
        self.register_hardware("Servo", |id, data| {
            let config: ServoConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Servo::new(id, config))
        });
        self.register_hardware("Rgb", |id, data| {
            let config: RgbConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Rgb::new(id, config))
        });
        self.register_hardware("Relay", |id, data| {
            let config: RelayConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Relay::new(id, config))
        });
        self.register_hardware("Piezo", |id, data| {
            let config: PiezoConfig = match serde_json::from_value(data.clone()) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("Failed to parse PiezoConfig: {e}, using defaults");
                    PiezoConfig::default()
                }
            };
            log::info!("Piezo config parsed: type={:?}, song_len={}, tempo={}", 
                config.r#type, config.song.len(), config.tempo);
            Box::new(Piezo::new(id, config))
        });

        // Monitor (software only - display component)
        self.register_software("Monitor", |id, data| {
            let config: MonitorConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Monitor::new(id, config))
        });

        // Input components (require hardware)
        self.register_hardware("Button", |id, data| {
            let config: ButtonConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Button::new(id, config))
        });
        self.register_hardware("Sensor", |id, data| {
            let config: SensorConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Sensor::new(id, config))
        });
        self.register_hardware("Motion", |id, data| {
            let config: MotionConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Motion::new(id, config))
        });
        self.register_hardware("Proximity", |id, data| {
            let config: ProximityConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Proximity::new(id, config))
        });

        // Control components (software only)
        self.register_software("Counter", |id, data| {
            let config: CounterConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Counter::new(id, config))
        });
        self.register_software("Delay", |id, data| {
            let config: DelayConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Delay::new(id, config))
        });
        self.register_software("Trigger", |id, data| {
            let config: TriggerConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Trigger::new(id, config))
        });

        // Generator components (software only)
        self.register_software("Constant", |id, data| {
            let config: ConstantConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Constant::new(id, config))
        });
        self.register_software("Interval", |id, data| {
            let config: IntervalConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Interval::new(id, config))
        });
        self.register_software("Oscillator", |id, data| {
            let config: OscillatorConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Oscillator::new(id, config))
        });

        // Transformation components (software only)
        self.register_software("Calculate", |id, data| {
            let config: CalculateConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Calculate::new(id, config))
        });
        self.register_software("Compare", |id, data| {
            let config: CompareConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Compare::new(id, config))
        });
        self.register_software("Gate", |id, data| {
            let config: GateConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Gate::new(id, config))
        });
        self.register_software("RangeMap", |id, data| {
            let config: RangeMapConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(RangeMap::new(id, config))
        });
        self.register_software("Smooth", |id, data| {
            let config: SmoothConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Smooth::new(id, config))
        });

        // LLM component (software only - HTTP/AI inference)
        self.register_software("Llm", |id, data| {
            let config: LlmConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Llm::new(id, config))
        });

        // External components (software only - network/IoT)
        self.register_software("Mqtt", |id, data| {
            let config: MqttConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Mqtt::new(id, config))
        });
        self.register_software("Figma", |id, data| {
            let config: FigmaConfig = serde_json::from_value(data.clone()).unwrap_or_default();
            Box::new(Figma::new(id, config))
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
