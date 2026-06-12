//! Button Component — Input. Template port for the workflow node fan-out.
//!
//! Note vs. the desktop original: the vestigial `poll_handle` / `polling_active`
//! tokio polling fields are dropped (the board reader, now `feed_bytes`, drives
//! `on_pin_change`), and digital reporting is no longer enabled here — the
//! runtime's `update_flow` reconciles reporting centrally from `listener_wiring`.
//! Debounce and hold timing move off `std::time::Instant` onto the host clock
//! (`ctx.now_ms`) and the wakeup scheduler: a press arms a `_hold` wakeup at
//! `holdtime`; `dispatch_internal("hold", …)` emits "hold" if still held; a
//! release cancels it.

use crate::runtime::{
    pin_mode, serde_utils, Component, ComponentBase, ComponentBuilder, ComponentValue,
    HardwareComponent, ListenerWiring, RuntimeContext, RuntimeError,
};
use serde::{Deserialize, Serialize};

/// Quiet window a line must hold before a deferred level is accepted. Must
/// exceed one 50Hz mains period (20ms): a floating pin picks up hum as
/// dead-regular ~20ms edges, and a window at exactly that period razor-edges
/// between accepting and rejecting every edge (observed as random on/off
/// "interference" toggles). A clean edge after a quiet line is still accepted
/// immediately, so real press latency stays imperceptible.
const DEBOUNCE_MS: f64 = 50.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonConfig {
    #[serde(default = "default_pin", deserialize_with = "serde_utils::deserialize_pin_u8")]
    pub pin: u8,
    #[serde(default)]
    pub is_pullup: bool,
    #[serde(default)]
    pub is_pulldown: bool,
    #[serde(default = "default_holdtime")]
    pub holdtime: u64,
    #[serde(default)]
    pub invert: bool,
}

fn default_pin() -> u8 {
    6
}
fn default_holdtime() -> u64 {
    500
}

impl Default for ButtonConfig {
    fn default() -> Self {
        Self {
            pin: default_pin(),
            is_pullup: false,
            is_pulldown: false,
            holdtime: default_holdtime(),
            invert: false,
        }
    }
}

pub struct Button {
    base: ComponentBase,
    config: ButtonConfig,
    is_pressed: bool,
    hold_emitted: bool,
    /// Host-clock timestamp (ms) of the last raw edge seen on the pin.
    last_edge_ms: Option<f64>,
    /// Latest raw level seen while the line was bouncing, awaiting a quiet line.
    pending: Option<bool>,
}

impl Button {
    #[must_use]
    pub fn new(id: String, config: ButtonConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            is_pressed: false,
            hold_emitted: false,
            last_edge_ms: None,
            pending: None,
        }
    }

    fn process_state(&mut self, pressed: bool, ctx: &mut RuntimeContext) {
        let now = ctx.now_ms();
        let quiet = self.last_edge_ms.map_or(true, |last| now - last >= DEBOUNCE_MS);
        self.last_edge_ms = Some(now);

        if quiet {
            // Clean edge after a quiet line: accept immediately.
            self.pending = None;
            ctx.cancel_wakeup("_debounce");
            if pressed != self.is_pressed {
                self.apply_state(pressed, ctx);
            }
        } else {
            // Line is bouncing (or humming): remember the level and settle it once
            // the line has held quiet for DEBOUNCE_MS. The deferred accept is
            // load-bearing — digital port reports only arrive on *change*, so a
            // dropped final edge would desync `is_pressed` from the real pin level
            // with nothing ever arriving to correct it (observed as "the first
            // press registers, then the button stops working").
            self.pending = Some(pressed);
            ctx.schedule_wakeup("_debounce", DEBOUNCE_MS as u64);
        }
    }

    /// Commit an accepted state change: value + emits + hold timer.
    fn apply_state(&mut self, pressed: bool, ctx: &mut RuntimeContext) {
        self.is_pressed = pressed;
        self.hold_emitted = false;
        self.base.set_value(ComponentValue::Bool(pressed));
        if pressed {
            // Arm the hold wakeup; fires once after `holdtime` ms if still held.
            ctx.schedule_wakeup("_hold", self.config.holdtime);
            self.base.emit("event");
            self.base.emit("true");
        } else {
            // Released before (or after) hold — cancel any pending hold wakeup.
            ctx.cancel_wakeup("_hold");
            self.base.emit("event");
            self.base.emit("false");
        }
    }
}

impl Component for Button {
    fn ports() -> &'static [&'static str] {
        &["read"]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Button"
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
            // Hold timer fired: emit "hold" once if the button is still held.
            "hold" => {
                if self.is_pressed && !self.hold_emitted {
                    self.hold_emitted = true;
                    self.base.emit("hold");
                }
                Ok(())
            }
            // Debounce timer fired: if the line has held quiet for a full
            // window, settle on the last raw level seen; otherwise it is still
            // bouncing — try again one window later.
            "debounce" => {
                let Some(pending) = self.pending else { return Ok(()) };
                let now = ctx.now_ms();
                let quiet = self.last_edge_ms.map_or(true, |last| now - last >= DEBOUNCE_MS);
                if quiet {
                    self.pending = None;
                    if pending != self.is_pressed {
                        self.apply_state(pending, ctx);
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

impl HardwareComponent for Button {
    fn initialize(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        let mode = if self.config.is_pullup {
            pin_mode::PULLUP
        } else {
            pin_mode::INPUT
        };
        // Diagnostic: shows the exact mode sent to the board. mode=11 == INPUT_PULLUP.
        log::info!(
            "[Button {}] init pin={} mode={} (is_pullup={})",
            self.base.id, self.config.pin, mode, self.config.is_pullup
        );
        ctx.board().set_pin_mode(self.config.pin, mode)?;
        Ok(())
    }

    fn on_pin_change(
        &mut self,
        value: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        if let Some(pressed) = value.as_bool() {
            self.process_state(pressed, ctx);
        }
        Ok(())
    }
}

impl ComponentBuilder for Button {
    type Config = ButtonConfig;
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

    /// Deliver one pin reading at host-clock time `now_ms`.
    fn feed(btn: &mut Button, value: bool, now_ms: f64) {
        let mut client = FirmataClient::new();
        let mut out = Vec::new();
        let mut writer = BufferBoardWriter::new(&mut client, &mut out);
        let mut reqs = ScheduleRequests::default();
        let mut ctx = RuntimeContext::new(&mut writer, now_ms, "btn", &mut reqs);
        btn.on_pin_change(ComponentValue::Bool(value), &mut ctx).unwrap();
    }

    fn drained_handles(sink: &EventSink) -> Vec<String> {
        sink.borrow_mut()
            .drain(..)
            .map(|e| e.source_handle.to_string())
            .collect()
    }

    /// Fire the `_debounce` wakeup at host-clock time `now_ms` (what the host
    /// does when the timer armed by a deferred edge expires).
    fn wake_debounce(btn: &mut Button, now_ms: f64) {
        let mut client = FirmataClient::new();
        let mut out = Vec::new();
        let mut writer = BufferBoardWriter::new(&mut client, &mut out);
        let mut reqs = ScheduleRequests::default();
        let mut ctx = RuntimeContext::new(&mut writer, now_ms, "btn", &mut reqs);
        btn.dispatch_internal("debounce", ComponentValue::default(), &mut ctx).unwrap();
    }

    #[test]
    fn quiet_period_debounce_suppresses_a_long_release_bounce() {
        let mut btn = Button::new("btn".into(), ButtonConfig::default());
        let sink: EventSink = Rc::new(RefCell::new(VecDeque::new()));
        btn.set_sink(sink.clone());

        // Clean press at t=0.
        feed(&mut btn, true, 0.0);
        assert!(btn.is_pressed);
        assert!(drained_handles(&sink).contains(&"true".to_string()));

        // Release bounces: alternating edges 5ms apart for 40ms. A pure lockout
        // would accept a flip mid-bounce (a visible toggle); every edge inside
        // the window must instead be deferred.
        for (i, &v) in [false, true, false, true, false, true, false, true].iter().enumerate() {
            feed(&mut btn, v, 5.0 * (i as f64 + 1.0));
        }
        assert!(btn.is_pressed, "bounce within the (resetting) window must not toggle state");
        assert!(drained_handles(&sink).is_empty(), "bounce must not emit");

        // The bounce train's last edge was `true` (= still pressed); the real
        // release lands inside the window too, so it defers...
        feed(&mut btn, false, 65.0);
        assert!(btn.is_pressed);
        // ...and the debounce wakeup settles it once the line has held quiet.
        wake_debounce(&mut btn, 120.0);
        assert!(!btn.is_pressed);
        assert!(drained_handles(&sink).contains(&"false".to_string()));
    }

    /// The regression behind "the first press registers, then the button stops
    /// working": digital port reports only arrive on change, so a final edge
    /// dropped by the debounce window desyncs `is_pressed` from the pin forever
    /// unless the deferred level is settled by the wakeup.
    #[test]
    fn release_edge_inside_the_window_settles_instead_of_desyncing() {
        let mut btn = Button::new("btn".into(), ButtonConfig::default());
        let sink: EventSink = Rc::new(RefCell::new(VecDeque::new()));
        btn.set_sink(sink.clone());

        feed(&mut btn, true, 0.0); // press accepted
        feed(&mut btn, false, 5.0); // release: the pin's LAST edge, inside the window
        assert!(btn.is_pressed, "edge inside the window is deferred, not applied");

        // No further reports ever arrive. The armed wakeup must resync.
        wake_debounce(&mut btn, 60.0);
        assert!(!btn.is_pressed, "deferred release must settle once the line is quiet");
        let handles = drained_handles(&sink);
        assert!(handles.contains(&"true".to_string()) && handles.contains(&"false".to_string()));
    }

    /// 50Hz mains hum on a floating pin: dead-regular ~20ms edges. At most the
    /// first edge (after a quiet line) may toggle; the rest must stay silent —
    /// and a press that holds the line solid must still register afterwards.
    #[test]
    fn mains_hum_is_suppressed_and_a_press_still_registers_through_it() {
        let mut btn = Button::new("btn".into(), ButtonConfig::default());
        let sink: EventSink = Rc::new(RefCell::new(VecDeque::new()));
        btn.set_sink(sink.clone());

        // Hum: alternating edges every 20ms for 380ms (last edge t=380, level low).
        let mut level = true;
        for i in 0..20 {
            feed(&mut btn, level, 20.0 * f64::from(i));
            level = !level;
        }
        let handles = drained_handles(&sink);
        // One accepted toggle emits "value" + "event" + the level handle.
        assert!(
            handles.len() <= 3,
            "hum may toggle at most once (the first clean edge), got: {handles:?}"
        );

        // Hum stops; the wakeup settles the line at its resting (released) level.
        wake_debounce(&mut btn, 435.0);
        assert!(!btn.is_pressed, "line must settle at its resting level once the hum stops");

        // A solid press on the now-quiet line registers immediately. (The "true"
        // handle dedups per-value, so assert on the alternating "event" handle.)
        feed(&mut btn, true, 500.0);
        assert!(btn.is_pressed, "clean press after the hum must register");
        let handles = drained_handles(&sink);
        assert!(handles.contains(&"false".to_string()), "settle must emit released");
        assert_eq!(
            handles.iter().filter(|h| h.as_str() == "event").count(),
            2,
            "settle + press each emit one edge event, got: {handles:?}"
        );
    }
}
