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
use super::context::RuntimeContext;

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
/// 4. `dispatch()` — handle incoming events from flow edges
/// 5. `destroy()` — cleanup when component is removed (default no-op)
///
/// Implementors must provide `base()` / `base_mut()` returning their
/// `ComponentBase` field. The trait then defaults `id`/`value`/`set_value` and the
/// event-sender accessors. Software components only need to define `base/base_mut`,
/// `component_type`, and `dispatch`. Hardware components additionally implement
/// [`HardwareComponent`] and override `as_hardware_mut` to expose themselves to the
/// runtime's board-init pass. The `requiresHardware` flag in `node-components.json`
/// is the single source of truth for hardware vs. software classification.
pub trait Component: Send + Sync {
    /// Declared **Port** names — the closed set of edge-input handles this
    /// impl's [`dispatch`](Component::dispatch) accepts.
    ///
    /// Mirrored by `impls[].ports[]` in `node-components.json`. The two are
    /// asserted equal at registry construction by
    /// `ComponentRegistry::register` / `register_hardware`; a drift fails
    /// the assertion at startup (debug builds) and forms the build-time
    /// validation seam between the frontend's typed handle IDs and the
    /// Rust dispatch surface. Default empty for components with no edge
    /// inputs (e.g. `Constant`). See `CONTEXT.md` § Port.
    ///
    /// `where Self: Sized` keeps the trait object-safe; access via concrete
    /// type at the registry call site (`B::ports()`).
    fn ports() -> &'static [&'static str] where Self: Sized { &[] }

    /// Reference to the shared `ComponentBase`. The trait reads `id`/`value`/`event_sender` from here.
    fn base(&self) -> &ComponentBase;

    /// Mutable reference to the shared `ComponentBase`.
    fn base_mut(&mut self) -> &mut ComponentBase;

    /// Type name for logging/debugging (e.g., "Led", "Button").
    fn component_type(&self) -> &'static str;

    /// Handle a method call from a flow edge or external command.
    fn dispatch(&mut self, method: &str, args: ComponentValue) -> Result<(), RuntimeError>;

    /// Handle an **Internal Event** — a self-routed method delivered by the
    /// executor when this component emitted an event whose `source_handle`
    /// started with `_`. Never reachable from a flow edge.
    ///
    /// Implementors override this to handle internally scheduled state
    /// transitions (e.g. `Piezo` `auto_stop` after a song finishes) without
    /// polluting `dispatch`'s Port namespace. Default no-op.
    ///
    /// See `CONTEXT.md` § Internal Event.
    fn dispatch_internal(&mut self, _method: &str, _value: ComponentValue) -> Result<(), RuntimeError> {
        Ok(())
    }

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
///
/// **Hardware Callbacks** (see `CONTEXT.md`) are delivered through the typed
/// methods on this trait — `on_pin_change`, `on_i2c_reply` — not through
/// [`Component::dispatch`]. The board-reader-driven event flow is therefore
/// separated from the edge-input flow at the trait level: an impl that
/// doesn't override a callback is silently a no-op for that hardware event
/// kind, and no flow edge can ever target a callback because Ports live on
/// `dispatch` (current) / `dispatch` (Phase 3).
pub trait HardwareComponent: Component {
    /// Acquire any pin modes, reporting toggles, or I/O state the component
    /// needs against the connected board.
    fn initialize(&mut self, board: Arc<BoardHandle>) -> Result<(), RuntimeError>;

    /// Pin-change Hardware Callback. Delivered by the runtime when the
    /// **Board IO Loop**'s `PinChangeCallback` fires for a pin this component
    /// has registered as a `ListenerWiring::DigitalPin` or `AnalogPin`.
    ///
    /// `value` is `ComponentValue::Bool` for digital pins, `ComponentValue::Number`
    /// (raw u16 cast to f64) for analog pins. Default no-op for hardware
    /// impls that don't listen to pins.
    fn on_pin_change(&mut self, _value: ComponentValue) -> Result<(), RuntimeError> {
        Ok(())
    }

    /// I²C-reply Hardware Callback. Delivered by the runtime when the
    /// **Board IO Loop**'s `I2cReplyCallback` fires for an address this
    /// component has registered as a `ListenerWiring::I2cAddress`.
    ///
    /// `value` is `ComponentValue::Array` of byte values. Default no-op for
    /// hardware impls that don't listen to I²C.
    fn on_i2c_reply(&mut self, _value: ComponentValue) -> Result<(), RuntimeError> {
        Ok(())
    }
}

/// Catalog factory contract used by [`ComponentRegistry`].
///
/// Every entry in the Component Catalog (`node-components.json`) implements
/// this trait. `build` consumes the deserialized `Config` plus the active
/// [`RuntimeContext`] and produces the concrete component. Deserialization
/// errors surface as [`RuntimeError::ConfigDeserialize`] inside the registry —
/// no silent `Default` fallback.
///
/// Hardware components are bound by `register_hardware::<B>(name)` in the
/// registry, which adds a `HardwareComponent` bound so a catalog
/// `requiresHardware: true` entry that forgets to implement
/// [`HardwareComponent`] fails to compile.
pub trait ComponentBuilder: Component + Sized + 'static {
    /// The deserialized configuration shape declared by this component.
    type Config: serde::de::DeserializeOwned;

    /// Construct the component from a config plus the active runtime context.
    /// Most impls ignore `ctx`; the `Llm` node uses it to resolve a provider
    /// referenced by `provider_id`.
    fn build(
        id: String,
        config: Self::Config,
        ctx: &RuntimeContext,
    ) -> Result<Self, RuntimeError>;
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
