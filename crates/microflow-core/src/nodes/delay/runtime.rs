//! Delay Component — Control. Passes a trigger on after a set time.
//!
//! A `trigger` is held with the value it arrived with and fires `delay` ms
//! after it arrived, on the `event` handle, carrying that value. How many
//! triggers can be held at once is the Node's one choice
//! ([`DelayConfig::capacity`]):
//!
//! - **queue** (`forgetPrevious` off): every trigger fires, in arrival order,
//!   each `delay` ms after it arrived. Up to [`QUEUE_CAPACITY`] are held.
//! - **debounce** (`forgetPrevious` on): one is held. A new trigger takes the
//!   place of the pending one, so only the latest fires, `delay` ms after it
//!   arrived.
//!
//! Both follow from one rule: a trigger that arrives while the Delay is full
//! takes the place of the newest pending one. The older ones still fire on
//! time, and the latest trigger is never the one lost. The generated Sketch
//! (`super::codegen`) holds the same number of triggers under the same rule.
//!
//! The pending triggers are the Node's own state, oldest first, each with the
//! host-clock time it is due. The Node keeps a single `_tick` wakeup armed,
//! for the oldest one: when it elapses that trigger fires, and the wakeup is
//! armed again for what is left of the next one's delay. A Delay built again
//! by a flow update starts with nothing pending, like every timed Node.

use std::collections::VecDeque;

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, DiagnosticLevel, RuntimeContext,
    RuntimeError,
};
// `DelayConfig` lives in the ungated sibling `config` module so the codegen
// emitter shares the exact same fields + defaults (single source of truth — see
// `crate::nodes`).
use super::config::{DelayConfig, QUEUE_CAPACITY};

/// A trigger waiting out its delay.
struct Pending {
    /// Host-clock time ([`RuntimeContext::now_ms`]) at which it fires.
    due_ms: f64,
    /// The value it arrived with, emitted when it fires.
    value: ComponentValue,
}

pub(crate) struct Delay {
    base: ComponentBase,
    config: DelayConfig,
    /// The triggers waiting out their delay, oldest first. Every trigger waits
    /// the same `delay`, so arrival order is also the order they fall due.
    pending: VecDeque<Pending>,
    /// A queue lost a trigger and has not drained since: the Node carries a
    /// warning. Raised and cleared on the transition only.
    overflowed: bool,
}

impl Delay {
    const E_EVENT: &'static str = "event";
    /// The wakeup armed for the oldest pending trigger.
    const TICK: &'static str = "_tick";

    #[must_use]
    pub(crate) fn new(id: String, config: DelayConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            pending: VecDeque::new(),
            overflowed: false,
        }
    }

    /// Hold a trigger until its delay has passed. Nothing is emitted now.
    fn signal(&mut self, value: ComponentValue, ctx: &mut RuntimeContext) {
        let capacity = self.config.capacity();
        if self.pending.len() >= capacity {
            // Full: the newest pending trigger gives way to this one.
            self.pending.pop_back();
            // With one slot that is debounce, which loses a trigger by design.
            if capacity > 1 && !self.overflowed {
                self.overflowed = true;
                ctx.report_diagnostic(
                    DiagnosticLevel::Warning,
                    format!(
                        "More than {QUEUE_CAPACITY} triggers are waiting, so some are dropped. Shorten the delay, slow the source down, or turn on debounce."
                    ),
                );
            }
        }
        self.pending.push_back(Pending {
            due_ms: ctx.now_ms() + self.config.delay as f64,
            value,
        });
        if self.pending.len() == 1 {
            // This trigger is now the oldest: the wakeup is (re)armed for it,
            // in place of the one of the trigger it replaced, if any.
            ctx.schedule_wakeup(Self::TICK, self.config.delay);
        }
    }

    /// The wakeup elapsed: fire the oldest pending trigger, and any other the
    /// host was late enough for, then arm the wakeup for the next one.
    fn tick(&mut self, ctx: &mut RuntimeContext) {
        // Nothing pending: the wakeup was armed for a Delay this one replaced.
        let Some(oldest) = self.pending.pop_front() else { return };
        self.fire(oldest);
        let now = ctx.now_ms();
        while self.pending.front().is_some_and(|next| next.due_ms <= now) {
            if let Some(due) = self.pending.pop_front() {
                self.fire(due);
            }
        }
        match self.pending.front() {
            Some(next) => ctx.schedule_wakeup(Self::TICK, (next.due_ms - now).ceil() as u64),
            None if self.overflowed => {
                self.overflowed = false;
                ctx.clear_diagnostic();
            }
            None => {}
        }
    }

    /// Emit a trigger's value on `event`; it stays the Node's value until the
    /// next one fires.
    fn fire(&mut self, trigger: Pending) {
        self.base.value = trigger.value;
        self.base.emit(Self::E_EVENT);
    }
}

impl Component for Delay {
    fn ports() -> &'static [&'static str] {
        &["trigger"]
    }

    fn emits() -> &'static [&'static str] {
        // Delay stores a fired value with a raw `base.value =` write (no
        // set_value), so it never emits the implicit "value" — only "event".
        &[Self::E_EVENT]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Delay"
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "trigger" => {
                self.signal(args, ctx);
                Ok(())
            }
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
            "tick" => {
                self.tick(ctx);
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn on_start(&mut self, ctx: &mut RuntimeContext) -> Result<(), RuntimeError> {
        // Nothing is pending, so nothing is being dropped: take down the
        // warning the Delay this one replaces may have left on the Node (the
        // way out of it is a settings change, which builds the Node again).
        ctx.clear_diagnostic();
        Ok(())
    }
}

impl ComponentBuilder for Delay {
    type Config = DelayConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}

#[cfg(test)]
mod sim_tests {
    use super::super::config::QUEUE_CAPACITY;
    use crate::firmata::sim::rig::{edge, node, SimRig};
    use crate::firmata::sim::{BoardLayout, SimBoard};
    use crate::flow::{FlowNode, FlowUpdate};
    use crate::runtime::{ComponentValue, DiagnosticLevel, FlowRuntime};
    use serde_json::json;

    const DELAY: &str = "delay";

    fn delay_node(data: serde_json::Value) -> FlowNode {
        node(DELAY, "Delay", data)
    }

    fn delay(data: serde_json::Value) -> SimRig {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(vec![delay_node(data)], vec![]);
        rig
    }

    /// What the Delay emitted on `event` since the last look, oldest first.
    fn emitted(rig: &mut SimRig) -> Vec<ComponentValue> {
        rig.take_events()
            .into_iter()
            .filter(|e| e.source.as_ref() == DELAY && e.source_handle.as_ref() == "event")
            .map(|e| e.value)
            .collect()
    }

    /// Run the clock to `until_ms` a millisecond at a time, sending each
    /// `(at_ms, value)` of `triggers` on its millisecond: when the Delay
    /// emitted `event`, and the number it carried.
    fn fires(rig: &mut SimRig, triggers: &[(u64, f64)], until_ms: u64) -> Vec<(u64, f64)> {
        let mut fired = Vec::new();
        loop {
            let now = rig.now_ms();
            for &(_, value) in triggers.iter().filter(|(at, _)| *at == now) {
                rig.dispatch(DELAY, "trigger", value);
            }
            fired.extend(emitted(rig).iter().map(|v| (now, v.as_number().expect("a number"))));
            if now >= until_ms {
                return fired;
            }
            rig.advance(1);
        }
    }

    // --- Queue: every trigger fires --------------------------------------------

    #[test]
    fn every_trigger_fires_after_the_delay_in_arrival_order_with_its_own_value() {
        let mut rig = delay(json!({ "delay": 500, "forgetPrevious": false }));

        let fired = fires(&mut rig, &[(0, 1.0), (100, 2.0), (250, 3.0)], 2000);

        assert_eq!(fired, vec![(500, 1.0), (600, 2.0), (750, 3.0)]);
    }

    #[test]
    fn a_delay_keeps_every_trigger_unless_told_to_forget() {
        let mut rig = delay(json!({ "delay": 500 }));

        let fired = fires(&mut rig, &[(0, 1.0), (100, 2.0)], 2000);

        assert_eq!(fired, vec![(500, 1.0), (600, 2.0)]);
    }

    #[test]
    fn a_trigger_carries_whatever_value_arrived() {
        let mut rig = delay(json!({ "delay": 200 }));
        rig.dispatch(DELAY, "trigger", ComponentValue::String("first".into()));
        rig.advance(50);
        rig.dispatch(DELAY, "trigger", true);

        rig.advance(200);

        assert_eq!(
            emitted(&mut rig),
            vec![ComponentValue::String("first".into()), ComponentValue::Bool(true)]
        );
    }

    #[test]
    fn triggers_of_one_millisecond_all_fire_in_order() {
        let mut rig = delay(json!({ "delay": 300 }));

        let fired = fires(&mut rig, &[(10, 1.0), (10, 2.0), (10, 3.0)], 1000);

        assert_eq!(fired, vec![(310, 1.0), (310, 2.0), (310, 3.0)]);
    }

    #[test]
    fn one_wakeup_is_armed_however_many_triggers_are_pending() {
        let mut rig = delay(json!({ "delay": 500 }));
        rig.dispatch(DELAY, "trigger", 1.0);
        rig.advance(100);
        rig.dispatch(DELAY, "trigger", 2.0);

        assert_eq!(rig.pending_wakeups(), vec![(DELAY, "_tick", 500)]);
        rig.advance(400);
        assert_eq!(rig.pending_wakeups(), vec![(DELAY, "_tick", 600)]);
        rig.advance(100);
        assert!(rig.pending_wakeups().is_empty(), "{:?}", rig.pending_wakeups());
    }

    /// A host that wakes the Delay late finds more than one trigger due: they
    /// all fire in that turn, oldest first, and the next one is armed for what
    /// is left of its delay.
    #[test]
    fn triggers_already_due_when_the_delay_wakes_fire_together_in_order() {
        let mut rt = FlowRuntime::new();
        rt.update_flow(FlowUpdate { nodes: vec![delay_node(json!({ "delay": 500 }))], edges: vec![] });
        rt.dispatch(DELAY, "trigger", ComponentValue::Number(1.0));
        rt.set_now(10.0);
        rt.dispatch(DELAY, "trigger", ComponentValue::Number(2.0));
        rt.set_now(400.0);
        rt.dispatch(DELAY, "trigger", ComponentValue::Number(3.0));

        rt.set_now(700.0);
        let woke = rt.wake(DELAY, "_tick");

        let values: Vec<_> = woke.component_events.iter().map(|e| e.value.clone()).collect();
        assert_eq!(values, vec![ComponentValue::Number(1.0), ComponentValue::Number(2.0)]);
        // The third trigger is due at 900: 200 ms from now.
        assert_eq!(woke.wakeups.len(), 1, "{woke:?}");
        assert_eq!(woke.wakeups[0].delay_ms, 200);
    }

    // --- Debounce: only the latest trigger fires --------------------------------

    #[test]
    fn forgetting_the_previous_trigger_fires_only_the_latest_with_its_value() {
        let mut rig = delay(json!({ "delay": 500, "forgetPrevious": true }));

        let fired = fires(&mut rig, &[(0, 1.0), (100, 2.0), (250, 3.0)], 2000);

        assert_eq!(fired, vec![(750, 3.0)]);
    }

    #[test]
    fn a_debounced_delay_fires_again_for_a_trigger_after_it_fired() {
        let mut rig = delay(json!({ "delay": 500, "forgetPrevious": true }));

        let fired = fires(&mut rig, &[(0, 1.0), (100, 2.0), (700, 3.0)], 2000);

        assert_eq!(fired, vec![(600, 2.0), (1200, 3.0)]);
    }

    /// The "Debounced Button" template (`apps/web/src/flows/templates`): a
    /// bouncing press reaches the Counter once.
    #[test]
    fn the_debounced_button_template_counts_a_bouncing_press_once() {
        let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
        rig.apply_flow(
            vec![
                node("delay-1", "Delay", json!({ "delay": 30, "forgetPrevious": true })),
                node("counter-1", "Counter", json!({})),
            ],
            vec![edge("delay-1", "event", "counter-1", "increment")],
        );

        for bounce in [0u64, 4, 9, 9, 15] {
            rig.advance(bounce);
            rig.dispatch("delay-1", "trigger", true);
        }
        rig.advance(1000);

        let counted: Vec<_> = rig
            .events()
            .iter()
            .filter(|e| e.source.as_ref() == "counter-1" && e.source_handle.as_ref() == "value")
            .map(|e| e.value.clone())
            .collect();
        assert_eq!(counted, vec![ComponentValue::Number(1.0)]);
    }

    // --- The bound ---------------------------------------------------------------

    /// With the queue full, a new trigger takes the place of the newest pending
    /// one: the older ones still fire on time, and the latest is never lost.
    #[test]
    fn a_trigger_into_a_full_queue_replaces_the_newest_pending_one() {
        let mut rig = delay(json!({ "delay": 1000 }));
        let capacity = QUEUE_CAPACITY as u64;
        let triggers: Vec<(u64, f64)> = (0..capacity + 4).map(|at| (at, (at + 1) as f64)).collect();

        let fired = fires(&mut rig, &triggers, 5000);

        let mut expected: Vec<(u64, f64)> =
            (0..capacity - 1).map(|at| (1000 + at, (at + 1) as f64)).collect();
        let (last_at, last_value) = triggers[triggers.len() - 1];
        expected.push((1000 + last_at, last_value));
        assert_eq!(fired, expected);
    }

    #[test]
    fn a_queue_that_overflowed_holds_new_triggers_again_once_it_has_room() {
        let mut rig = delay(json!({ "delay": 1000 }));
        let overflow: Vec<(u64, f64)> = (0..=QUEUE_CAPACITY as u64).map(|at| (at, 0.0)).collect();
        fires(&mut rig, &overflow, 3000);

        let fired = fires(&mut rig, &[(3000, 1.0), (3100, 2.0)], 5000);

        assert_eq!(fired, vec![(4000, 1.0), (4100, 2.0)]);
    }

    /// What the Delay's badge went through, oldest first: `true` for a warning
    /// going up, `false` for it coming down.
    fn warnings(rig: &SimRig) -> Vec<bool> {
        rig.diagnostics()
            .iter()
            .inspect(|d| assert_eq!(d.node, DELAY))
            .map(|d| {
                assert!(d.message.is_none() || matches!(d.level, DiagnosticLevel::Warning), "{d:?}");
                d.message.is_some()
            })
            // Nothing is on the badge until the first warning: skip the clears
            // of a Delay that starts.
            .skip_while(|raised| !raised)
            .collect()
    }

    #[test]
    fn an_overflowing_queue_warns_on_the_node_until_it_has_drained() {
        let mut rig = delay(json!({ "delay": 1000 }));
        for _ in 0..QUEUE_CAPACITY {
            rig.dispatch(DELAY, "trigger", 0.0);
        }
        assert_eq!(warnings(&rig), Vec::<bool>::new(), "a full queue has lost nothing");

        rig.dispatch(DELAY, "trigger", 0.0);
        rig.dispatch(DELAY, "trigger", 0.0);
        assert_eq!(warnings(&rig), vec![true], "once, not per lost trigger");

        rig.advance(1000);
        assert_eq!(warnings(&rig), vec![true, false]);
    }

    /// Turning debounce on is the way out of an overflowing queue, and it
    /// builds the Delay again: the warning must not outlive the queue.
    #[test]
    fn the_overflow_warning_comes_down_when_the_delay_is_built_again() {
        let mut rig = delay(json!({ "delay": 1000 }));
        for _ in 0..=QUEUE_CAPACITY {
            rig.dispatch(DELAY, "trigger", 0.0);
        }
        assert_eq!(warnings(&rig), vec![true]);

        rig.apply_flow(vec![delay_node(json!({ "delay": 1000, "forgetPrevious": true }))], vec![]);

        assert_eq!(warnings(&rig), vec![true, false]);
    }

    #[test]
    fn a_debounced_delay_never_warns() {
        let mut rig = delay(json!({ "delay": 1000, "forgetPrevious": true }));
        for _ in 0..QUEUE_CAPACITY * 2 {
            rig.dispatch(DELAY, "trigger", 0.0);
        }
        rig.advance(2000);

        assert_eq!(warnings(&rig), Vec::<bool>::new());
    }

    // --- Flow updates ------------------------------------------------------------

    #[test]
    fn pending_triggers_survive_an_update_that_leaves_the_delay_alone() {
        let data = json!({ "delay": 500 });
        let mut rig = delay(data.clone());
        rig.dispatch(DELAY, "trigger", 1.0);
        rig.advance(100);
        rig.dispatch(DELAY, "trigger", 2.0);

        rig.apply_flow(vec![delay_node(data), node("counter", "Counter", json!({}))], vec![]);

        assert_eq!(fires(&mut rig, &[], 2000), vec![(500, 1.0), (600, 2.0)]);
    }

    /// A Delay whose settings change is built again and starts with nothing
    /// pending; the wakeup armed for the one it replaces must not fire it.
    #[test]
    fn a_delay_whose_settings_change_drops_its_pending_triggers() {
        for forget_previous in [false, true] {
            let mut rig = delay(json!({ "delay": 500, "forgetPrevious": forget_previous }));
            rig.dispatch(DELAY, "trigger", 1.0);
            rig.advance(100);

            rig.apply_flow(vec![delay_node(json!({ "delay": 300, "forgetPrevious": forget_previous }))], vec![]);

            assert_eq!(fires(&mut rig, &[], 2000), vec![], "forgetPrevious: {forget_previous}");
        }
    }

    #[test]
    fn a_rebuilt_delay_times_its_own_triggers_from_their_arrival() {
        let mut rig = delay(json!({ "delay": 500 }));
        rig.dispatch(DELAY, "trigger", 1.0);
        rig.advance(100);
        rig.apply_flow(vec![delay_node(json!({ "delay": 300 }))], vec![]);

        let fired = fires(&mut rig, &[(350, 2.0), (450, 3.0)], 2000);

        assert_eq!(fired, vec![(650, 2.0), (750, 3.0)]);
    }
}
