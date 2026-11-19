//! Trigger Component — Control. Bangs when a value has moved far enough, fast
//! enough, in one direction.
//!
//! Every value that arrives on `value` is held with the time it arrived, and
//! compared with the oldest value held from the last `within` ms: when it has
//! moved the configured way (`increasing` / `decreasing`) by at least
//! `threshold` — or by `threshold` percent of that oldest value, when
//! `relative` — the Trigger emits `bang`, carrying the value. It then stays
//! triggered, and does not bang again, until a value moves the other way from
//! the oldest one held.
//!
//! Time is the engine's clock ([`RuntimeContext::now_ms`]), read when a value
//! arrives; a held value is only ever looked at then, so the Trigger arms no
//! wakeups. It holds at most [`WINDOW_CAPACITY`] values: one that arrives while
//! it is full takes the place of the newest held one, so the oldest — where a
//! change counts from — stays put. The generated Sketch (`super::codegen`)
//! holds the same values under the same rule.

use std::borrow::Cow;
use std::collections::VecDeque;

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext, RuntimeError,
};
// `TriggerConfig` + `TriggerBehaviour` live in the ungated sibling `config`
// module so the codegen emitter shares the exact same fields + defaults (single
// source of truth — see `crate::nodes`).
use super::config::{TriggerBehaviour, TriggerConfig, WINDOW_CAPACITY};

/// A value from the window, with the engine-clock time it arrived.
struct Held {
    value: f64,
    at_ms: f64,
}

pub(crate) struct Trigger {
    base: ComponentBase,
    config: TriggerConfig,
    /// The values from the last `within` ms, oldest first.
    window: VecDeque<Held>,
}

impl Trigger {
    const E_BANG: &'static str = "bang";

    #[must_use]
    pub(crate) fn new(id: String, config: TriggerConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Bool(false)),
            config,
            window: VecDeque::with_capacity(WINDOW_CAPACITY),
        }
    }

    fn signal(&mut self, value: &ComponentValue, now_ms: f64) {
        let value = value.as_number().unwrap_or(0.0);
        self.hold(value, now_ms);
        if self.check_difference(value) {
            self.base.emit_with_value(Self::E_BANG, Cow::Owned(ComponentValue::Number(value)));
        }
    }

    /// Forget the values older than `within`, then hold this one — in place of
    /// the newest held value when the window is full.
    fn hold(&mut self, value: f64, now_ms: f64) {
        let within = self.config.within as f64;
        while self.window.front().is_some_and(|oldest| now_ms - oldest.at_ms > within) {
            self.window.pop_front();
        }
        if self.window.len() >= WINDOW_CAPACITY {
            self.window.pop_back();
        }
        self.window.push_back(Held { value, at_ms: now_ms });
    }

    fn check_difference(&mut self, value: f64) -> bool {
        // `hold` ran first, so the window holds at least this value.
        let first_value = self.window.front().map_or(value, |oldest| oldest.value);
        let difference = value - first_value;
        let correct_direction = self.value_changes_in_correct_direction(difference);

        let was_triggered = self.base.value.as_bool().unwrap_or(false);
        if was_triggered {
            self.base.set_value(ComponentValue::Bool(correct_direction));
            return false;
        }

        let reached_threshold = if self.config.relative {
            (difference / first_value * 100.0).abs() >= self.config.threshold
        } else {
            difference.abs() >= self.config.threshold
        };

        let triggered = correct_direction && reached_threshold;
        self.base.set_value(ComponentValue::Bool(triggered));
        triggered
    }

    fn value_changes_in_correct_direction(&self, difference: f64) -> bool {
        let is_positive = difference > 0.0;
        match self.config.behaviour {
            TriggerBehaviour::Increasing => is_positive,
            TriggerBehaviour::Decreasing => !is_positive,
        }
    }
}

impl Component for Trigger {
    fn ports() -> &'static [&'static str] {
        &["value"]
    }

    fn emits() -> &'static [&'static str] {
        &[Self::E_BANG, ComponentBase::VALUE_HANDLE]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Trigger"
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "value" => {
                self.signal(&args, ctx.now_ms());
                Ok(())
            }
            _ => Err(RuntimeError::ComponentError(format!(
                "Unknown method: {method}"
            ))),
        }
    }

    fn destroy(&mut self) {
        self.window.clear();
    }
}

impl ComponentBuilder for Trigger {
    type Config = TriggerConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

#[cfg(test)]
mod sim_tests {
    use super::super::config::WINDOW_CAPACITY;
    use crate::firmata::sim::rig::{edge, node, SimRig};
    use crate::firmata::sim::{BoardLayout, SimBoard};
    use crate::runtime::ComponentValue;
    use serde_json::json;

    const TRIGGER: &str = "trigger";

    fn trigger(data: serde_json::Value) -> SimRig {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(vec![node(TRIGGER, "Trigger", data)], vec![]);
        rig
    }

    /// Run the clock to `until_ms` a millisecond at a time, sending each
    /// `(at_ms, value)` of `values` to the Trigger on its millisecond: when the
    /// Trigger banged, and the value the bang carried.
    fn bangs(rig: &mut SimRig, values: &[(u64, f64)], until_ms: u64) -> Vec<(u64, f64)> {
        let mut banged = Vec::new();
        loop {
            let now = rig.now_ms();
            for &(_, value) in values.iter().filter(|(at, _)| *at == now) {
                rig.dispatch(TRIGGER, "value", value);
            }
            banged.extend(
                rig.take_events()
                    .into_iter()
                    .filter(|e| e.source.as_ref() == TRIGGER && e.source_handle.as_ref() == "bang")
                    .map(|e| (now, e.value.as_number().expect("a number"))),
            );
            if now >= until_ms {
                return banged;
            }
            rig.advance(1);
        }
    }

    // --- Direction and threshold -------------------------------------------------

    #[test]
    fn an_increasing_trigger_bangs_with_the_value_that_rose_by_the_threshold() {
        let mut rig = trigger(json!({ "behaviour": "increasing", "threshold": 5, "within": 250 }));

        let banged = bangs(&mut rig, &[(0, 10.0), (50, 12.0), (100, 15.0)], 500);

        assert_eq!(banged, vec![(100, 15.0)]);
    }

    #[test]
    fn a_trigger_watches_for_a_decrease_unless_told_otherwise() {
        let mut rig = trigger(json!({ "threshold": 5 }));

        let banged = bangs(&mut rig, &[(0, 20.0), (50, 18.0), (100, 14.0), (300, 30.0), (350, 40.0)], 500);

        assert_eq!(banged, vec![(100, 14.0)]);
    }

    #[test]
    fn a_change_smaller_than_the_threshold_does_not_bang() {
        let mut rig = trigger(json!({ "behaviour": "increasing", "threshold": 5 }));

        let banged = bangs(&mut rig, &[(0, 10.0), (50, 12.0), (100, 14.9)], 500);

        assert_eq!(banged, vec![]);
    }

    #[test]
    fn a_percentage_trigger_compares_the_change_with_the_value_it_counts_from() {
        let mut rig = trigger(json!({ "behaviour": "increasing", "threshold": 50, "relative": true }));

        // 100 → 140 is 40 %, 100 → 150 is 50 %.
        let banged = bangs(&mut rig, &[(0, 100.0), (50, 140.0), (100, 150.0)], 500);

        assert_eq!(banged, vec![(100, 150.0)]);
    }

    // --- Within ------------------------------------------------------------------

    /// The same rise, once inside `within` and once spread over a millisecond
    /// more: only the quick one bangs.
    #[test]
    fn only_a_change_that_happens_within_the_window_bangs() {
        let data = json!({ "behaviour": "increasing", "threshold": 5, "within": 250 });
        let mut quick = trigger(data.clone());
        let mut slow = trigger(data);

        let quick_bangs = bangs(&mut quick, &[(0, 10.0), (200, 13.0), (250, 15.0)], 1000);
        let slow_bangs = bangs(&mut slow, &[(0, 10.0), (200, 13.0), (251, 15.0)], 1000);

        assert_eq!(quick_bangs, vec![(250, 15.0)]);
        // At 251 the 10 is too old: the change counts from the 13.
        assert_eq!(slow_bangs, vec![]);
    }

    #[test]
    fn the_window_is_a_quarter_second_unless_set() {
        let mut rig = trigger(json!({ "behaviour": "increasing", "threshold": 5 }));

        let banged = bangs(&mut rig, &[(0, 10.0), (251, 15.0), (300, 20.0)], 1000);

        // 251: the 10 is too old, so the 15 counts from itself. 300: the 20 is
        // 5 above the 15 of 49 ms before.
        assert_eq!(banged, vec![(300, 20.0)]);
    }

    /// Time is the engine's clock: values that arrive with no time passing
    /// between them are all within the window, however short it is.
    #[test]
    fn values_of_one_millisecond_are_all_within_the_window() {
        let mut rig = trigger(json!({ "behaviour": "increasing", "threshold": 5, "within": 1 }));

        let banged = bangs(&mut rig, &[(10, 0.0), (10, 3.0), (10, 6.0)], 100);

        assert_eq!(banged, vec![(10, 6.0)]);
    }

    // --- Once per crossing -------------------------------------------------------

    /// After a bang the Trigger waits for a value that moves the other way from
    /// where the window starts before it can bang again: a rise that keeps
    /// rising bangs once.
    #[test]
    fn a_trigger_bangs_once_per_crossing_and_again_after_the_value_turns() {
        let mut rig = trigger(json!({ "behaviour": "increasing", "threshold": 5, "within": 1000 }));

        // The 1 at 40 is still above the 0 the window starts with.
        let values = [(0, 0.0), (10, 6.0), (20, 12.0), (30, 18.0), (40, 1.0), (50, 20.0)];
        assert_eq!(bangs(&mut rig, &values, 500), vec![(10, 6.0)]);

        // 1100: the window holds only the 30, which is no rise, so the Trigger
        // is ready again. 1300: the 40 is 10 above that 30.
        let values = [(1100, 30.0), (1200, 25.0), (1300, 40.0)];
        assert_eq!(bangs(&mut rig, &values, 2000), vec![(1300, 40.0)]);
    }

    // --- The bound ---------------------------------------------------------------

    /// More values inside one window than the Trigger holds: a new value takes
    /// the place of the newest held one, so the oldest — where a change counts
    /// from — stays put.
    #[test]
    fn a_full_window_keeps_the_value_a_change_counts_from() {
        let mut rig = trigger(json!({ "behaviour": "increasing", "threshold": 50, "within": 10_000 }));
        let burst = WINDOW_CAPACITY as u64 * 4;
        // One a millisecond, each 1 above the one before.
        let values: Vec<(u64, f64)> = (0..burst).map(|at| (at, at as f64)).collect();

        assert_eq!(bangs(&mut rig, &values, burst), vec![(50, 50.0)]);
    }

    /// Once the held values are too old, a change counts from the newest held
    /// one: the last value of the burst, not the first that did not fit.
    #[test]
    fn past_a_full_window_a_change_counts_from_the_latest_value_held() {
        let mut rig = trigger(json!({ "threshold": 5, "within": 100 }));
        let burst = WINDOW_CAPACITY as u64 + 4;
        // A rise, so the decreasing Trigger never bangs during it.
        let mut values: Vec<(u64, f64)> = (0..burst).map(|at| (at, at as f64)).collect();
        // Every value of the burst is too old but the last.
        values.push((WINDOW_CAPACITY as u64 + 100, 13.0));

        let banged = bangs(&mut rig, &values, 500);

        // 13 is 6 below the 19 the burst ended on.
        assert_eq!(banged, vec![(WINDOW_CAPACITY as u64 + 100, 13.0)]);
    }

    // --- Templates ---------------------------------------------------------------

    /// The "Edge Trigger Alarm" template (`apps/web/src/flows/templates`): each
    /// sharp rise of the reading counts once.
    #[test]
    fn the_edge_trigger_alarm_template_counts_each_sharp_rise_once() {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(
            vec![
                node("trigger-1", "Trigger", json!({ "behaviour": "increasing", "threshold": 50 })),
                node("counter-1", "Counter", json!({})),
            ],
            vec![edge("trigger-1", "bang", "counter-1", "increment")],
        );

        for (gap, reading) in [(0, 100.0), (100, 120.0), (100, 180.0), (100, 240.0), (1000, 200.0), (100, 400.0)] {
            rig.advance(gap);
            rig.dispatch("trigger-1", "value", reading);
        }

        let counted: Vec<_> = rig
            .events()
            .iter()
            .filter(|e| e.source.as_ref() == "counter-1" && e.source_handle.as_ref() == "value")
            .map(|e| e.value.clone())
            .collect();
        assert_eq!(counted, vec![ComponentValue::Number(1.0), ComponentValue::Number(2.0)]);
    }
}
