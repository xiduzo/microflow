//! The `Component` trait, the `ComponentBase` helper, and the hardware
//! extension trait — the sans-IO core versions.
//!
//! Differences from the desktop runtime, by design:
//! - **Emit goes to a `VecDeque`, not a channel.** `ComponentBase` holds an
//!   [`EventSink`] (`Rc<RefCell<VecDeque<…>>>`); `send` pushes onto it and the
//!   executor drains it to completion synchronously. No tokio, no thread.
//! - **Board + clock + scheduler arrive per-dispatch via [`RuntimeContext`].**
//!   `dispatch`, the internal callback, and the hardware callbacks all take
//!   `&mut RuntimeContext` instead of nodes holding an `Arc<BoardHandle>`.
//! - **No `Send + Sync` bound.** The core is single-threaded (`Rc`); the desktop
//!   host confines it to one owner thread.

use crate::runtime::context::RuntimeContext;
use crate::runtime::error::RuntimeError;
use crate::runtime::value::{ComponentEvent, ComponentValue};
use crate::runtime::wiring::{ListenerWiring, SubscriberWiring};
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;
use std::sync::Arc;

/// Shared queue every component emits into; the executor drains it to
/// completion each turn. Single-threaded, so `Rc<RefCell<…>>` not `Arc<Mutex>`.
pub type EventSink = Rc<RefCell<VecDeque<ComponentEvent>>>;

/// Trait that all flow components implement.
///
/// Lifecycle: `build` (concrete fn) → `set_sink` (wire the emit queue) →
/// `HardwareComponent::initialize` (hardware only, when the board connects) →
/// `dispatch` (edge inputs) → `destroy`.
pub trait Component {
    /// Declared **Port** names — the closed set of edge-input handles this
    /// impl's [`dispatch`](Component::dispatch) accepts. Default empty.
    #[must_use]
    fn ports() -> &'static [&'static str]
    where
        Self: Sized,
    {
        &[]
    }

    /// Reference to the shared [`ComponentBase`].
    fn base(&self) -> &ComponentBase;

    /// Mutable reference to the shared [`ComponentBase`].
    fn base_mut(&mut self) -> &mut ComponentBase;

    /// Type name for logging/debugging (e.g. "Led", "Button").
    fn component_type(&self) -> &'static str;

    /// Handle a method call from a flow edge or external command.
    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError>;

    /// Handle an **Internal Event** — a self-routed method delivered by the
    /// executor when this component emitted an event whose `source_handle`
    /// started with `_` (e.g. a timer wakeup). Never reachable from a flow edge.
    fn dispatch_internal(
        &mut self,
        _method: &str,
        _value: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        Ok(())
    }

    /// Unique identifier for this component instance.
    fn id(&self) -> &str {
        &self.base().id
    }

    /// Current value of the component.
    fn value(&self) -> ComponentValue {
        self.base().value.clone()
    }

    /// Set the component's value directly (no event emission — use
    /// `base_mut().set_value()` to emit).
    fn set_value(&mut self, value: ComponentValue) {
        self.base_mut().value = value;
    }

    /// Wire up the emit queue; called by the registry after construction.
    fn set_sink(&mut self, sink: EventSink) {
        self.base_mut().sink = Some(sink);
    }

    /// Hardware classifier. `Some(self)` for [`HardwareComponent`] impls so the
    /// runtime calls `initialize` / callbacks only on components that need a board.
    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> {
        None
    }

    /// Cleanup resources when the component is removed. Default no-op.
    fn destroy(&mut self) {}

    /// Whether this component aggregates multiple inputs on a handle. When true,
    /// the executor collects all input values and passes them as an array.
    fn aggregates_inputs(&self) -> bool {
        false
    }

    /// Called when a raw MQTT message arrives for this component (topic-aware).
    fn receive_raw_message(&mut self, _topic: &str, _payload: &[u8]) {}

    /// Static wiring this component needs once constructed: pin/I2C/key listeners.
    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        Vec::new()
    }

    /// Async subscriptions this component requests against an MQTT broker.
    fn subscriber_wiring(&self) -> Vec<SubscriberWiring> {
        Vec::new()
    }
}

/// Extension trait for components that need board access at runtime.
///
/// The runtime invokes `initialize` once when the board connects (and again on
/// reconnect). Hardware Callbacks (`on_pin_change`, `on_i2c_reply`) are
/// delivered by the runtime's inbound path, never via [`Component::dispatch`].
pub trait HardwareComponent: Component {
    /// Acquire pin modes, reporting toggles, or I/O state against the board.
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError>;

    /// Pin-change Hardware Callback for a registered `DigitalPin` / `AnalogPin`.
    /// `value` is `Bool` for digital pins, `Number` (raw u16 as f64) for analog.
    fn on_pin_change(
        &mut self,
        _value: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        Ok(())
    }

    /// I²C-reply Hardware Callback for a registered `I2cAddress`. `value` is an
    /// `Array` of byte values.
    fn on_i2c_reply(
        &mut self,
        _value: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        Ok(())
    }
}

/// Base implementation helper carried by every component.
pub struct ComponentBase {
    pub id: Arc<str>,
    pub value: ComponentValue,
    /// The shared emit queue. `None` until the registry calls `set_sink`.
    pub sink: Option<EventSink>,
    /// Last emitted value per handle, used for deduplication.
    last_emitted: HashMap<Arc<str>, ComponentValue>,
}

impl ComponentBase {
    #[must_use]
    pub fn new(id: String, initial_value: ComponentValue) -> Self {
        Self {
            id: Arc::from(id),
            value: initial_value,
            sink: None,
            last_emitted: HashMap::new(),
        }
    }

    /// Set the value and automatically emit a "value" event if it changed.
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

    /// Push the event onto the shared emit queue. The executor drains it.
    fn send(&self, handle: &str, value: Cow<'_, ComponentValue>) {
        if let Some(sink) = &self.sink {
            sink.borrow_mut().push_back(ComponentEvent {
                source: Arc::clone(&self.id),
                source_handle: Arc::from(handle),
                value: value.into_owned(),
                edge_id: None,
                sequence: 0,
            });
        }
    }
}
