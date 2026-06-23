//! Switch Component — Input. Template port for the workflow node fan-out.
//!
//! A latching on/off toggle switch (as opposed to a momentary Button).
//! Supports Normally-Open (NO) and Normally-Closed (NC) wiring.
//! Reference: <https://johnny-five.io/examples/switch/>
//!
//! Debounce mirrors [`super::button`]: digital pins report only on *change*, so
//! a level seen while the line is still bouncing is *deferred* (via a
//! `_debounce` wakeup) and accepted once the line has held quiet — never
//! dropped. The old naive lockout dropped the final edge, desyncing `is_closed`
//! from the pin forever (a flipped switch that "stops responding"). The raw pin
//! level is translated to the logical closed/open level before debouncing.

use crate::runtime::{
    pin_mode, Component, ComponentBase, ComponentBuilder, ComponentValue, HardwareComponent,
    ListenerWiring, RuntimeContext, RuntimeError,
};

pub use crate::config::switch::{SwitchConfig, SwitchType};

/// Quiet window a line must hold before a deferred level is accepted. Must
/// exceed one 50Hz mains period (20ms) — see [`super::button`] for the full
/// rationale (a window at the mains period razor-edges on a floating pin).
const DEBOUNCE_MS: f64 = 50.0;

pub struct Switch {
    base: ComponentBase,
    config: SwitchConfig,
    is_closed: bool,
    /// Host-clock timestamp (ms) of the last raw edge seen on the pin.
    last_edge_ms: Option<f64>,
    /// Latest logical level seen while the line was bouncing, awaiting a quiet line.
    pending: Option<bool>,
}

impl Switch {
    const E_EVENT: &'static str = "event";
    const E_TRUE: &'static str = "true";
    const E_FALSE: &'static str = "false";

    #[must_use]
    pub fn new(id: String, config: SwitchConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            is_closed: false,
            last_edge_ms: None,
            pending: None,
        }
    }

    /// Translate raw pin reading to logical closed/open based on wiring type.
    /// - NO (normally open): pin HIGH (pulled up) = open, pin LOW = closed
    /// - NC (normally closed): pin HIGH (pulled up) = closed, pin LOW = open
    fn is_logically_closed(&self, pin_high: bool) -> bool {
        match self.config.switch_type {
            SwitchType::NO => !pin_high,
            SwitchType::NC => pin_high,
        }
    }

    fn process_state(&mut self, pin_high: bool, ctx: &mut RuntimeContext) {
        let closed = self.is_logically_closed(pin_high);
        let now = ctx.now_ms();
        let quiet = self.last_edge_ms.map_or(true, |last| now - last >= DEBOUNCE_MS);
        self.last_edge_ms = Some(now);

        if quiet {
            // Clean edge after a quiet line: accept immediately.
            self.pending = None;
            ctx.cancel_wakeup("_debounce");
            if closed != self.is_closed {
                self.apply_state(closed);
            }
        } else {
            // Line is bouncing (or humming): remember the level and settle it once
            // the line has held quiet for DEBOUNCE_MS. The deferred accept is
            // load-bearing — digital reports only arrive on *change*, so a dropped
            // final edge would desync `is_closed` from the real pin level forever.
            self.pending = Some(closed);
            ctx.schedule_wakeup("_debounce", DEBOUNCE_MS as u64);
        }
    }

    /// Commit an accepted state change: value + edge emits.
    fn apply_state(&mut self, closed: bool) {
        self.is_closed = closed;
        self.base.set_value(ComponentValue::Bool(closed));
        self.base.emit(Self::E_EVENT);
        if closed {
            self.base.emit(Self::E_TRUE);
        } else {
            self.base.emit(Self::E_FALSE);
        }
    }
}

impl Component for Switch {
    fn ports() -> &'static [&'static str] {
        &["read"]
    }

    fn emits() -> &'static [&'static str] {
        &[Self::E_EVENT, Self::E_TRUE, Self::E_FALSE, ComponentBase::VALUE_HANDLE]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Switch"
    }

    fn listener_wiring(&self) -> Vec<ListenerWiring> {
        vec![ListenerWiring::DigitalPin { pin: self.config.pin }]
    }

    fn as_hardware_mut(&mut self) -> Option<&mut dyn HardwareComponent> {
        Some(self)
    }

    fn dispatch(
        &mut self,
        method: &str,
        _args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "read" => Ok(()),
            _ => Err(RuntimeError::ComponentError(format!("Unknown method: {method}"))),
        }
    }

    fn dispatch_internal(
        &mut self,
        method: &str,
        _value: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            // Debounce timer fired: if the line has held quiet for a full window,
            // settle on the last logical level seen; otherwise it is still
            // bouncing — try again one window later.
            "debounce" => {
                let Some(pending) = self.pending else { return Ok(()) };
                let now = ctx.now_ms();
                let quiet = self.last_edge_ms.map_or(true, |last| now - last >= DEBOUNCE_MS);
                if quiet {
                    self.pending = None;
                    if pending != self.is_closed {
                        self.apply_state(pending);
                    }
                } else {
                    ctx.schedule_wakeup("_debounce", DEBOUNCE_MS as u64);
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

impl HardwareComponent for Switch {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        ctx.board().set_pin_mode(self.config.pin, pin_mode::INPUT)?;
        Ok(())
    }

    fn on_pin_change(
        &mut self,
        value: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        if let Some(pin_high) = value.as_bool() {
            self.process_state(pin_high, ctx);
        }
        Ok(())
    }
}

impl ComponentBuilder for Switch {
    type Config = SwitchConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firmata::FirmataClient;
    use crate::runtime::{BufferBoardWriter, EventSink, ScheduleRequests};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;

    /// Deliver one raw pin reading (`pin_high`) at host-clock time `now_ms`.
    fn feed(sw: &mut Switch, pin_high: bool, now_ms: f64) {
        let mut client = FirmataClient::new();
        let mut out = Vec::new();
        let mut writer = BufferBoardWriter::new(&mut client, &mut out);
        let mut reqs = ScheduleRequests::default();
        let mut ctx = RuntimeContext::new(&mut writer, now_ms, "sw", &mut reqs);
        sw.on_pin_change(ComponentValue::Bool(pin_high), &mut ctx).unwrap();
    }

    /// Fire the `_debounce` wakeup at host-clock time `now_ms`.
    fn wake_debounce(sw: &mut Switch, now_ms: f64) {
        let mut client = FirmataClient::new();
        let mut out = Vec::new();
        let mut writer = BufferBoardWriter::new(&mut client, &mut out);
        let mut reqs = ScheduleRequests::default();
        let mut ctx = RuntimeContext::new(&mut writer, now_ms, "sw", &mut reqs);
        sw.dispatch_internal("debounce", ComponentValue::default(), &mut ctx).unwrap();
    }

    fn drained_handles(sink: &EventSink) -> Vec<String> {
        sink.borrow_mut().drain(..).map(|e| e.source_handle.to_string()).collect()
    }

    /// The regression behind "the switch flips once, then stops responding":
    /// a digital report only arrives on change, so an edge dropped inside the
    /// debounce window desyncs `is_closed` from the pin forever unless the
    /// deferred level is settled by the wakeup. (NO wiring: pin LOW = closed.)
    #[test]
    fn edge_inside_the_window_settles_instead_of_desyncing() {
        let mut sw = Switch::new("sw".into(), SwitchConfig::default());
        let sink: EventSink = Rc::new(RefCell::new(VecDeque::new()));
        sw.set_sink(sink.clone());

        feed(&mut sw, false, 0.0); // pin LOW → closed: accepted immediately
        assert!(sw.is_closed);
        assert!(drained_handles(&sink).contains(&"true".to_string()));

        feed(&mut sw, true, 5.0); // pin HIGH → open, inside the window: deferred
        assert!(sw.is_closed, "edge inside the window is deferred, not applied");

        // No further reports ever arrive. The armed wakeup must resync.
        wake_debounce(&mut sw, 60.0);
        assert!(!sw.is_closed, "deferred edge must settle once the line is quiet");
        assert!(drained_handles(&sink).contains(&"false".to_string()));
    }

    /// A clean toggle slower than the window passes straight through, emitting a
    /// fresh edge every time (no value-dedup swallowing repeats).
    #[test]
    fn clean_toggles_emit_every_edge() {
        let mut sw = Switch::new("sw".into(), SwitchConfig::default());
        let sink: EventSink = Rc::new(RefCell::new(VecDeque::new()));
        sw.set_sink(sink.clone());

        feed(&mut sw, false, 0.0); // closed
        feed(&mut sw, true, 100.0); // open
        feed(&mut sw, false, 200.0); // closed again
        let handles = drained_handles(&sink);
        assert_eq!(handles.iter().filter(|h| h.as_str() == "true").count(), 2);
        assert_eq!(handles.iter().filter(|h| h.as_str() == "false").count(), 1);
    }
}
