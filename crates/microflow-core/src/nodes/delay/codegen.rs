//! Delay emitter — mirrors `nodes/delay/runtime.rs`.
//!
//! The live Delay holds each trigger with the value it arrived with and fires
//! it on `event` `delay` ms after it arrived (default `1000`). On device the
//! wait must be non-blocking, so the generated Sketch keeps each pending
//! trigger's value and arrival time in module-level state and fires the oldest
//! one once `millis() - armed_at >= delay`. The loop never blocks while a
//! trigger is pending — the rest of the Flow keeps running — and the unsigned
//! elapsed-time subtraction survives `millis()` rollover.
//!
//! How many triggers are held is [`DelayConfig::capacity`], the same number
//! the live Delay holds, under the same rule — a trigger that arrives while
//! the Delay is full takes the place of the newest pending one:
//!
//! - **queue** (`forgetPrevious` off, the default): a ring of
//!   [`QUEUE_CAPACITY`](super::config::QUEUE_CAPACITY) slots, written at the
//!   tail and fired from the head, so every trigger fires in arrival order
//!   with its own value.
//! - **debounce** (`forgetPrevious` on): one slot, so each new trigger
//!   overwrites the pending one and only the latest fires.
//!
//! The Sketch carries a number: a trigger's value is stored as a `double`
//! (text reads as `0.0`, as it does on every numeric port).
//!
//! Holding is pulse-driven: event sources hold on their firing tick, level
//! sources when their detector fires, so one signal holds one trigger. A
//! `fired` flag is true exactly on the firing loop iteration — the on-device
//! twin of the `event` emission — so pulse-consuming downstream ports see one
//! event per fire even when consecutive delayed values are equal. One trigger
//! fires per loop iteration: triggers due together fire on consecutive
//! iterations, in order.

use super::config::DelayConfig;
use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::codegen::wire::NodeInputs;
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;

/// The C++ `double` variable holding this Delay Node's most recently emitted
/// (delayed) value, read by downstream Nodes.
#[must_use]
pub(crate) fn value_var(node: &FlowNode) -> String {
    format!("delay_{}_value", node.id_token())
}

/// The C++ `bool` variable that is true only on the loop iteration in which
/// the delayed `event` fires.
#[must_use]
pub(crate) fn fired_var(node: &FlowNode) -> String {
    format!("delay_{}_fired", node.id_token())
}

/// Emit C++ for a Delay Node from its `trigger` port. With nothing connected
/// the Delay never holds a trigger (the runtime never fires without a signal).
pub(crate) fn emit(node: &FlowNode, inputs: &NodeInputs) -> Result<NodeEmission, UnreadableConfig> {
    let token = node.id_token();
    let var = value_var(node);
    let fired = fired_var(node);
    let pending = format!("delay_{token}_pending");
    let armed = format!("delay_{token}_armed_at");
    let stored = format!("delay_{token}_stored");
    let head = format!("delay_{token}_head");
    let slot = format!("delay_{token}_slot");
    let config = resolve::<DelayConfig>(&node.data)?;
    let delay_ms = config.delay;
    let capacity = config.capacity();

    let mut e = NodeEmission {
        declarations: vec![
            format!("double {var} = 0.0;"),
            format!("bool {fired} = false;"),
        ],
        ..NodeEmission::default()
    };

    let sources = inputs.on("trigger");
    if sources.is_empty() {
        return Ok(e);
    }

    if capacity == 1 {
        e.declarations.push(format!("bool {pending} = false;"));
        e.declarations.push(format!("unsigned long {armed} = 0;"));
        e.declarations.push(format!("double {stored} = 0.0;"));
    } else {
        // A ring: `head` is the oldest pending trigger, `pending` how many
        // are held from there on.
        e.declarations.push(format!("uint8_t {pending} = 0;"));
        e.declarations.push(format!("uint8_t {head} = 0;"));
        e.declarations.push(format!("unsigned long {armed}[{capacity}];"));
        e.declarations.push(format!("double {stored}[{capacity}];"));
    }

    // The fired-flag reset must precede the detector lines `bind_port` appends.
    e.loop_body.push(format!("{fired} = false;"));
    let binding = e.bind_port(&format!("delay_{token}_trigger"), sources);

    // Hold per fired source: capture the value and the arrival time.
    for (fired_expr, source) in binding.fired.iter().zip(sources) {
        let value = source.value.as_double();
        e.loop_body.push(format!("if ({fired_expr}) {{"));
        if capacity == 1 {
            e.loop_body.push(format!("  {stored} = {value};"));
            e.loop_body.push(format!("  {armed} = millis();"));
            e.loop_body.push(format!("  {pending} = true;"));
        } else {
            // The slot after the newest pending trigger — or, with the ring
            // full, the newest one's own slot.
            e.loop_body.push(format!("  if ({pending} < {capacity}) {{ {pending}++; }}"));
            e.loop_body
                .push(format!("  const uint8_t {slot} = ({head} + {pending} - 1) % {capacity};"));
            e.loop_body.push(format!("  {stored}[{slot}] = {value};"));
            e.loop_body.push(format!("  {armed}[{slot}] = millis();"));
        }
        e.loop_body.push("}".to_string());
    }

    // Fire the oldest trigger once its delay has elapsed — non-blocking
    // elapsed-time compare.
    if capacity == 1 {
        e.loop_body
            .push(format!("if ({pending} && millis() - {armed} >= {delay_ms}UL) {{"));
        e.loop_body.push(format!("  {var} = {stored};"));
        e.loop_body.push(format!("  {fired} = true;"));
        e.loop_body.push(format!("  {pending} = false;"));
    } else {
        e.loop_body.push(format!(
            "if ({pending} > 0 && millis() - {armed}[{head}] >= {delay_ms}UL) {{"
        ));
        e.loop_body.push(format!("  {var} = {stored}[{head}];"));
        e.loop_body.push(format!("  {fired} = true;"));
        e.loop_body.push(format!("  {head} = ({head} + 1) % {capacity};"));
        e.loop_body.push(format!("  {pending}--;"));
    }
    e.loop_body.push("}".to_string());
    Ok(e)
}

#[cfg(test)]
mod tests {
    use super::super::config::QUEUE_CAPACITY;
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
    use crate::flow::Position;
    use serde_json::json;

    fn delay(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Delay".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    /// One event source on `trigger`: it fires when `src_fired` is true and
    /// carries `src_value`.
    fn event_input() -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add("trigger", SourceExpr::event(CppExpr::number("src_value"), "src_fired"));
        inputs
    }

    fn trigger_input(expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add("trigger", SourceExpr::level(expr));
        inputs
    }

    // What the generated code does when it runs is pinned by
    // `tests/delay_sketch.rs`, which compiles it; these pin its shape.

    /// Queue: each trigger is written behind the newest pending one and the
    /// oldest is the one that fires, so all of them do, in arrival order.
    #[test]
    fn a_delay_that_keeps_every_trigger_holds_them_in_a_ring() {
        assert_eq!(QUEUE_CAPACITY, 16, "the literals below are the capacity");
        let e = emit(&delay("d-1", json!({ "delay": 750, "forgetPrevious": false })), &event_input()).unwrap();

        assert_eq!(
            e.declarations,
            [
                "double delay_d_1_value = 0.0;",
                "bool delay_d_1_fired = false;",
                "uint8_t delay_d_1_pending = 0;",
                "uint8_t delay_d_1_head = 0;",
                "unsigned long delay_d_1_armed_at[16];",
                "double delay_d_1_stored[16];",
            ]
        );
        assert_eq!(
            e.loop_body,
            [
                "delay_d_1_fired = false;",
                "if (src_fired) {",
                // Full: the count stays, so the slot is the newest pending one's.
                "  if (delay_d_1_pending < 16) { delay_d_1_pending++; }",
                "  const uint8_t delay_d_1_slot = (delay_d_1_head + delay_d_1_pending - 1) % 16;",
                "  delay_d_1_stored[delay_d_1_slot] = ((double)(src_value));",
                "  delay_d_1_armed_at[delay_d_1_slot] = millis();",
                "}",
                "if (delay_d_1_pending > 0 && millis() - delay_d_1_armed_at[delay_d_1_head] >= 750UL) {",
                "  delay_d_1_value = delay_d_1_stored[delay_d_1_head];",
                "  delay_d_1_fired = true;",
                "  delay_d_1_head = (delay_d_1_head + 1) % 16;",
                "  delay_d_1_pending--;",
                "}",
            ]
        );
    }

    /// Debounce: one slot, overwritten by every trigger, so the latest value
    /// fires `delay` after the latest arrival.
    #[test]
    fn a_delay_that_forgets_the_previous_trigger_holds_one() {
        let e = emit(&delay("d-1", json!({ "delay": 750, "forgetPrevious": true })), &event_input()).unwrap();

        assert_eq!(
            e.declarations,
            [
                "double delay_d_1_value = 0.0;",
                "bool delay_d_1_fired = false;",
                "bool delay_d_1_pending = false;",
                "unsigned long delay_d_1_armed_at = 0;",
                "double delay_d_1_stored = 0.0;",
            ]
        );
        assert_eq!(
            e.loop_body,
            [
                "delay_d_1_fired = false;",
                "if (src_fired) {",
                "  delay_d_1_stored = ((double)(src_value));",
                "  delay_d_1_armed_at = millis();",
                "  delay_d_1_pending = true;",
                "}",
                "if (delay_d_1_pending && millis() - delay_d_1_armed_at >= 750UL) {",
                "  delay_d_1_value = delay_d_1_stored;",
                "  delay_d_1_fired = true;",
                "  delay_d_1_pending = false;",
                "}",
            ]
        );
    }

    #[test]
    fn a_delay_keeps_every_trigger_unless_told_to_forget() {
        let unset = emit(&delay("d-1", json!({ "delay": 750 })), &event_input()).unwrap();
        let off = emit(&delay("d-1", json!({ "delay": 750, "forgetPrevious": false })), &event_input()).unwrap();
        assert_eq!(unset, off);
    }

    /// The "Debounced Button" template's Delay (`apps/web/src/flows/templates`).
    #[test]
    fn the_debounced_button_template_holds_one_trigger() {
        let e = emit(&delay("delay-1", json!({ "delay": 30, "forgetPrevious": true })), &event_input()).unwrap();
        assert!(e.declarations.contains(&"double delay_delay_1_stored = 0.0;".to_string()), "{:?}", e.declarations);
        assert!(
            e.loop_body.contains(&"if (delay_delay_1_pending && millis() - delay_delay_1_armed_at >= 30UL) {".to_string()),
            "{:?}",
            e.loop_body
        );
    }

    /// Every source wired into `trigger` holds its own trigger, with its own
    /// value, in both modes.
    #[test]
    fn every_source_on_trigger_holds_its_own_value() {
        let mut inputs = event_input();
        inputs.add("trigger", SourceExpr::event(CppExpr::boolean("other_value"), "other_fired"));
        for (forget_previous, slot) in [(false, "delay_d_1_stored[delay_d_1_slot]"), (true, "delay_d_1_stored")] {
            let e = emit(&delay("d-1", json!({ "forgetPrevious": forget_previous })), &inputs).unwrap();
            let body = e.loop_body.join("\n");
            for hold in [
                format!("if (src_fired) {{\n  {slot} = ((double)(src_value));"),
                format!("if (other_fired) {{\n  {slot} = ((other_value) ? 1.0 : 0.0);"),
            ] {
                // The queue claims its slot first; the value is written next.
                let hold = if forget_previous {
                    hold
                } else {
                    hold.replacen(
                        "{\n",
                        "{\n  if (delay_d_1_pending < 16) { delay_d_1_pending++; }\n  const uint8_t delay_d_1_slot = (delay_d_1_head + delay_d_1_pending - 1) % 16;\n",
                        1,
                    )
                };
                assert!(body.contains(&hold), "missing:\n{hold}\nin:\n{body}");
            }
        }
    }

    #[test]
    fn fires_after_configured_delay_without_blocking() {
        for forget_previous in [false, true] {
            let e = emit(
                &delay("d-1", json!({ "delay": 750, "forgetPrevious": forget_previous })),
                &trigger_input(CppExpr::boolean("v")),
            )
            .unwrap();
            assert!(
                e.loop_body.iter().any(|l| l.contains("millis() - delay_d_1_armed_at") && l.contains(">= 750UL")),
                "delay must fire on an elapsed-time comparison: {:?}",
                e.loop_body
            );
            assert!(!e.loop_body.iter().any(|l| l.contains("delay(")), "must not block");
        }
    }

    #[test]
    fn exposes_a_one_tick_fired_flag() {
        for forget_previous in [false, true] {
            let e = emit(
                &delay("d-1", json!({ "forgetPrevious": forget_previous })),
                &trigger_input(CppExpr::boolean("v")),
            )
            .unwrap();
            assert!(e.declarations.iter().any(|d| d.contains("bool delay_d_1_fired = false")));
            assert_eq!(e.loop_body.first().unwrap(), "delay_d_1_fired = false;");
            assert!(e.loop_body.iter().any(|l| l.contains("delay_d_1_fired = true")));
        }
    }

    #[test]
    fn defaults_to_one_second() {
        let e = emit(&delay("d-1", json!({})), &trigger_input(CppExpr::boolean("v"))).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains(">= 1000UL")));
    }

    #[test]
    fn no_input_declares_but_never_holds() {
        let e = emit(&delay("d-1", json!({})), &NodeInputs::default()).unwrap();
        assert!(e.loop_body.is_empty(), "{:?}", e.loop_body);
        assert_eq!(e.declarations, ["double delay_d_1_value = 0.0;", "bool delay_d_1_fired = false;"]);
    }

    #[test]
    fn emits_deterministically() {
        let n = delay("d-1", json!({ "delay": 200 }));
        let inputs = trigger_input(CppExpr::boolean("v"));
        assert_eq!(emit(&n, &inputs).unwrap(), emit(&n, &inputs).unwrap());
    }
}
