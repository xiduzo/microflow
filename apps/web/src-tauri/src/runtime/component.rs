//! Component trait, value/event types, and the `ComponentBase` helper.
//!
//! The Component side of the runtime: everything a flow component needs to
//! satisfy the `Component` trait without knowing about Firmata, the serial
//! port, or the reader thread. Hardware glue lives in `super::board`.
//!
//! Re-exported via `super::base` for backwards compatibility.

use crate::error::RuntimeError;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;

use super::board::BoardHandle;

/// Value that a component can hold
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ComponentValue {
    Bool(bool),
    Number(f64),
    String(String),
    Rgba { r: u8, g: u8, b: u8, a: f64 },
    Array(Vec<ComponentValue>),
}

impl Default for ComponentValue {
    fn default() -> Self {
        ComponentValue::Number(0.0)
    }
}

impl From<bool> for ComponentValue {
    fn from(v: bool) -> Self {
        ComponentValue::Bool(v)
    }
}

impl From<f64> for ComponentValue {
    fn from(v: f64) -> Self {
        ComponentValue::Number(v)
    }
}

impl From<i32> for ComponentValue {
    fn from(v: i32) -> Self {
        ComponentValue::Number(f64::from(v))
    }
}

impl From<u8> for ComponentValue {
    fn from(v: u8) -> Self {
        ComponentValue::Number(f64::from(v))
    }
}

impl ComponentValue {
    /// Convert any `ComponentValue` to a boolean (truthy/falsy check)
    /// - Bool: direct value
    /// - Number: true if non-zero
    /// - String: true if non-empty
    /// - Rgba: always true (color exists)
    /// - Array: true if non-empty
    #[must_use]
    pub fn as_bool(&self) -> Option<bool> {
        Some(match self {
            ComponentValue::Bool(v) => *v,
            ComponentValue::Number(v) => *v != 0.0,
            ComponentValue::String(v) => !v.is_empty(),
            ComponentValue::Rgba { .. } => true,
            ComponentValue::Array(v) => !v.is_empty(),
        })
    }

    /// Check if the value is truthy (convenience method that never returns None)
    #[must_use]
    pub fn is_truthy(&self) -> bool {
        self.as_bool().unwrap_or(false)
    }

    #[must_use]
    pub fn as_number(&self) -> Option<f64> {
        match self {
            ComponentValue::Number(v) => Some(*v),
            ComponentValue::Bool(v) => Some(if *v { 1.0 } else { 0.0 }),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_u8(&self) -> Option<u8> {
        self.as_number().map(|v| v.clamp(0.0, 255.0) as u8)
    }
}

/// Event emitted by a component
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentEvent {
    #[serde(deserialize_with = "deserialize_arc_str")]
    pub source: Arc<str>,
    #[serde(deserialize_with = "deserialize_arc_str")]
    pub source_handle: Arc<str>,
    pub value: ComponentValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<String>,
    #[serde(default)]
    pub sequence: u64, // Flow version when event was created
}

/// Custom deserializer to convert String -> Arc<str>
fn deserialize_arc_str<'de, D>(deserializer: D) -> Result<Arc<str>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    Ok(Arc::from(s))
}

/// Pin configuration for components
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
#[allow(dead_code)]
pub enum PinConfig {
    Single(u8),
    Named(String),
    Multiple(Vec<u8>),
    Rgb { red: u8, green: u8, blue: u8 },
    Matrix { data: u8, clock: u8, cs: u8 },
}

impl PinConfig {
    #[allow(dead_code)]
    #[must_use]
    pub fn as_single(&self) -> Option<u8> {
        match self {
            PinConfig::Single(p) => Some(*p),
            _ => None,
        }
    }
}

impl Default for PinConfig {
    fn default() -> Self {
        PinConfig::Single(13)
    }
}

/// Trait that all flow components implement.
///
/// # Lifecycle
/// 1. `new()` — create component with config (concrete fn on each impl)
/// 2. `set_event_sender()` — wire up event channel
/// 3. `HardwareComponent::initialize()` — called when board connects (hardware components only)
/// 4. `call_method()` — handle incoming events from flow edges
/// 5. `destroy()` — cleanup when component is removed (default no-op)
///
/// Implementors must provide `base()` / `base_mut()` returning their
/// `ComponentBase` field. The trait then defaults `id`/`value`/`set_value` and the
/// event-sender accessors. Software components only need to define `base/base_mut`,
/// `component_type`, and `call_method`. Hardware components additionally implement
/// [`HardwareComponent`] and override `as_hardware_mut` to expose themselves to the
/// runtime's board-init pass. The `requiresHardware` flag in `node-components.json`
/// is the single source of truth for hardware vs. software classification.
pub trait Component: Send + Sync {
    /// Reference to the shared `ComponentBase`. The trait reads `id`/`value`/`event_sender` from here.
    fn base(&self) -> &ComponentBase;

    /// Mutable reference to the shared `ComponentBase`.
    fn base_mut(&mut self) -> &mut ComponentBase;

    /// Type name for logging/debugging (e.g., "Led", "Button").
    fn component_type(&self) -> &'static str;

    /// Handle a method call from a flow edge or external command.
    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), RuntimeError>;

    /// Unique identifier for this component instance.
    fn id(&self) -> &str { &self.base().id }

    /// Current value of the component.
    fn value(&self) -> ComponentValue { self.base().value.clone() }

    /// Set the component's value directly (no event emission — use `base_mut().set_value()` to emit).
    fn set_value(&mut self, value: ComponentValue) { self.base_mut().value = value; }

    /// Event sender for emitting events.
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> {
        self.base().event_sender.clone()
    }

    /// Wire up the event sender; called by the registry after construction.
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) {
        self.base_mut().event_sender = Some(sender);
    }

    /// Hardware classifier. Returns `Some(self)` for `HardwareComponent` impls so the
    /// runtime can call `initialize` only on components that need a `BoardHandle`.
    /// Default `None` keeps software components free of dead-weight hardware concerns.
    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> { None }

    /// Cleanup resources when component is removed. Default no-op.
    fn destroy(&mut self) {}

    /// Whether this component aggregates multiple inputs on a handle.
    /// When true, the executor collects all input values and passes them as an array.
    fn aggregates_inputs(&self) -> bool { false }

    /// Called when a raw MQTT message arrives for this component (topic-aware).
    /// Override in components that need topic context (e.g. Figma).
    fn receive_raw_message(&mut self, _topic: &str, _payload: &[u8]) {}

    /// Static wiring this component needs once constructed: pin/I2C/key listeners.
    /// Default empty for software-only components with no external event sources.
    /// See `CONTEXT.md` § Wiring.
    fn listener_wiring(&self) -> Vec<crate::runtime::wiring::ListenerWiring> { Vec::new() }

    /// Async subscriptions this component requests against an MQTT broker.
    /// Default empty for components that don't talk to brokers. See `CONTEXT.md` § Wiring.
    fn subscriber_wiring(&self) -> Vec<crate::runtime::wiring::SubscriberWiring> { Vec::new() }
}

/// Extension trait for components that need a [`BoardHandle`] at runtime.
///
/// Implemented by the 14 hardware components in the Component Catalog
/// (`requiresHardware: true`). The runtime invokes `initialize` once when the
/// board connects, via `Component::as_hardware_mut`, and may invoke it again on
/// reconnect.
pub trait HardwareComponent: Component {
    /// Acquire any pin modes, reporting toggles, or I/O state the component
    /// needs against the connected board.
    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), RuntimeError>;
}

/// Base implementation helper for components
pub struct ComponentBase {
    pub id: Arc<str>,
    pub value: ComponentValue,
    pub event_sender: Option<mpsc::UnboundedSender<ComponentEvent>>,
    /// Last emitted value per handle, used for deduplication
    last_emitted: HashMap<Arc<str>, ComponentValue>,
}

impl ComponentBase {
    #[must_use]
    pub fn new(id: String, initial_value: ComponentValue) -> Self {
        Self {
            id: Arc::from(id),
            value: initial_value,
            event_sender: None,
            last_emitted: HashMap::new(),
        }
    }

    /// Set the value and automatically emit a "value" event if the value changed
    pub fn set_value(&mut self, value: ComponentValue) {
        if self.value != value {
            self.value = value;
            self.emit("value");
        }
    }

    /// Emit an event with the current value, only if it differs from the last
    /// emitted value on this handle.
    pub fn emit(&mut self, handle: &str) {
        if self.is_duplicate(handle, &self.value.clone()) {
            return;
        }
        self.send(handle, Cow::Borrowed(&self.value));
    }

    /// Emit an event with a custom value, only if it differs from the last
    /// emitted value on this handle.
    pub fn emit_with_value(&mut self, handle: &str, value: Cow<'_, ComponentValue>) {
        if self.is_duplicate(handle, value.as_ref()) {
            return;
        }
        self.send(handle, value);
    }

    /// Check if the value for this handle is the same as the last emitted value.
    /// Updates the stored value if different.
    fn is_duplicate(&mut self, handle: &str, value: &ComponentValue) -> bool {
        if let Some(last) = self.last_emitted.get(handle) {
            if last == value {
                return true;
            }
        }
        self.last_emitted.insert(Arc::from(handle), value.clone());
        false
    }

    /// Send the event through the channel.
    fn send(&self, handle: &str, value: Cow<'_, ComponentValue>) {
        if let Some(sender) = &self.event_sender {
            let _ = sender.send(ComponentEvent {
                source: Arc::clone(&self.id),
                source_handle: Arc::from(handle),
                value: value.into_owned(),
                edge_id: None,
                sequence: 0,
            });
        }
    }
}
