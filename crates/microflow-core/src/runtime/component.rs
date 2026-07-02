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
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;

/// Shared queue every component emits into; the executor drains it to
/// completion each turn. Single-threaded, so `Rc<RefCell<…>>` not `Arc<Mutex>`.
pub type EventSink = Rc<RefCell<VecDeque<ComponentEvent>>>;

/// A single I2C continuous-read the board should stream: `(address, register,
/// length)`. Every hardware component that streams over I2C reports one via
/// [`Component::i2c_continuous_read`]; the runtime arms them all centrally in
/// `update_flow` (stop-all-then-start-all) rather than per-node, because
/// `StandardFirmata`'s `I2C_STOP_READING` clears the lone remaining query
/// regardless of address — so a per-node stop+start would drop a sibling device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct I2cContinuousRead {
    pub address: u8,
    pub register: u8,
    pub length: u8,
}

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

    /// Declared **Emit** names — the closed set of edge-output handles
    /// (`source_handle`) this impl may emit on. The symmetric counterpart of
    /// [`ports`](Component::ports). Mirrored to `node-components.json
    /// impls[].emits[]` and asserted equal by the Catalog Parity Guard
    /// (ADR-0007). Includes [`ComponentBase::VALUE_HANDLE`] for any impl that
    /// emits via [`ComponentBase::set_value`]. Excludes `_`-prefixed Internal
    /// Event / wakeup names. Default empty.
    #[must_use]
    fn emits() -> &'static [&'static str]
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

    /// Called once by `update_flow` right after this component is built (after
    /// `HardwareComponent::initialize`, before edges are live but within the
    /// same turn, so emitted events drain against the new graph). The sans-IO
    /// replacement for the desktop's "auto-start on `set_event_sender`": a
    /// `Constant` emits its value here; an auto-start `Interval` schedules its
    /// first wakeup here. Default no-op.
    fn on_start(&mut self, _ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
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

    /// Desired board sampling interval in ms, if this component streams at a
    /// specific rate (I2C continuous reads). The sampling interval is a single
    /// GLOBAL Firmata setting shared by every continuous read and analog report,
    /// so the runtime reconciles it to the **MAX** of all components' hints —
    /// the slowest sensor sets the pace so a faster one can't out-run another
    /// device's conversion time and read stale/zero data. `None` = no preference.
    fn sampling_interval_hint(&self) -> Option<u32> {
        None
    }

    /// Desired I2C read-delay in **microseconds** — the gap the board waits
    /// between writing a device's register and reading it back. Like the
    /// sampling interval this is a single GLOBAL Firmata setting, so the runtime
    /// uses the MAX across all components. No-hold sensors (SHT2x/HTU21) need it
    /// so the read lands after their conversion completes (they NACK until then);
    /// most devices want `None` (0) and read immediately.
    fn i2c_read_delay_us(&self) -> Option<u32> {
        None
    }

    /// The I2C continuous read this component streams, if any — armed centrally
    /// by the runtime (see [`I2cContinuousRead`]). `None` = not an I2C streamer.
    fn i2c_continuous_read(&self) -> Option<I2cContinuousRead> {
        None
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
}

impl ComponentBase {
    /// The implicit **Emit** handle fired by [`set_value`](Self::set_value) when
    /// the value changes. Centralized here so every value-emitting node lists the
    /// same constant in its `Component::emits()` rather than a bare `"value"`
    /// literal. See CONTEXT.md § Emit and ADR-0007.
    pub const VALUE_HANDLE: &'static str = "value";

    #[must_use]
    pub fn new(id: String, initial_value: ComponentValue) -> Self {
        Self {
            id: Arc::from(id),
            value: initial_value,
            sink: None,
        }
    }

    /// Set the value and automatically emit a [`VALUE_HANDLE`](Self::VALUE_HANDLE)
    /// event if it changed.
    pub fn set_value(&mut self, value: ComponentValue) {
        if self.value != value {
            self.value = value;
            self.emit(Self::VALUE_HANDLE);
        }
    }

    /// Emit an event carrying the component's current value on `handle`.
    ///
    /// Always fires. Edge handles like `true`/`false`/`hold`/`event` are
    /// momentary triggers whose value is constant per handle, so value-deduping
    /// here would let them fire once and then silently swallow every later edge
    /// (the "button true/false stops working after the first press" bug).
    /// State-level dedup belongs to [`Self::set_value`], which only emits
    /// `"value"` when the value actually changes.
    pub fn emit(&mut self, handle: &str) {
        self.send(handle, Cow::Borrowed(&self.value));
    }

    /// Emit an event carrying a custom `value` on `handle`. Always fires; see
    /// [`Self::emit`] for why edge handles must not be value-deduped.
    pub fn emit_with_value(&mut self, handle: &str, value: Cow<'_, ComponentValue>) {
        self.send(handle, value);
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

/// Catalog factory contract used by the registry. Phase-1 core drops the
/// desktop's `Deps`/`FromServices` projection (no cloud services in the browser
/// build): a component is built from its deserialized config alone. Cloud nodes,
/// when they land behind the `cloud` feature, will carry their own service
/// handles.
pub trait ComponentBuilder: Component + Sized + 'static {
    /// The deserialized configuration shape declared by this component.
    type Config: serde::de::DeserializeOwned;

    /// Construct the component from its config.
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError>;
}
