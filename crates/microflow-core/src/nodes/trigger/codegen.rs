//! Trigger emitter — mirrors `nodes/trigger/runtime.rs`.
//!
//! The live Trigger holds every value that reaches its `value` port with the
//! time it arrived, compares each new one with the oldest it holds from the
//! last `within` ms, and emits `bang` (carrying the value) when it has moved
//! the configured way by `threshold` (or `threshold` percent, when
//! `relative`); it then stays triggered until a value moves the other way.
//!
//! The generated Sketch does the same in module-level state: a ring of
//! [`WINDOW_CAPACITY`] slots, each a value and the `millis()` it arrived,
//! under the live rule — a value that arrives while the ring is full takes the
//! place of the newest held one. A value arrives when the source fires (event
//! sources on their firing tick, level sources when their detector fires), as
//! it does live; values older than `within` are let go with the unsigned
//! `millis() - at > within` compare, which survives `millis()` rollover.
//!
//! The `result` flag is true exactly on the loop iteration of a bang — the
//! on-device twin of the `bang` emission — and the `value` payload holds the
//! value it carried. Trigger does not aggregate: extra sources on `value` are
//! noted and the first drives.

use super::config::{TriggerBehaviour, TriggerConfig, WINDOW_CAPACITY};
use crate::codegen::emit::{cpp_double, NodeEmission, NodeToken};
use crate::codegen::wire::{extra_sources_note, CppExpr, NodeInputs, SourceExpr};
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;

/// The C++ `bool` variable holding this Trigger Node's latest bang state —
/// true only on the loop iteration in which the threshold was crossed.
#[must_use]
pub(crate) fn state_var(node: &FlowNode) -> String {
    format!("trigger_{}_result", node.id_token())
}

/// The C++ `double` variable holding the value that produced the most recent
/// bang — the on-device twin of the bang emission's payload.
#[must_use]
pub(crate) fn value_payload_var(node: &FlowNode) -> String {
    format!("trigger_{}_value", node.id_token())
}

/// The C++ `bool` holding the runtime's stored state: triggered, and not ready
/// to bang again.
fn triggered_var(node: &FlowNode) -> String {
    format!("trigger_{}_triggered", node.id_token())
}

/// What the Trigger emits on `value`: its stored state, which the runtime
/// `set_value`s on every value that arrives — emitted when it changes.
#[must_use]
pub(crate) fn output(node: &FlowNode) -> SourceExpr {
    SourceExpr::level(CppExpr::boolean(triggered_var(node)))
}

/// Emit C++ for a Trigger Node from its `value` port. With nothing connected
/// the result stays `false` (the runtime never bangs without a signal).
pub(crate) fn emit(node: &FlowNode, inputs: &NodeInputs) -> Result<NodeEmission, UnreadableConfig> {
    let token = node.id_token();
    let var = state_var(node);
    let payload = value_payload_var(node);
    let config = resolve::<TriggerConfig>(&node.data)?;

    let triggered = triggered_var(node);
    let mut e = NodeEmission {
        declarations: vec![
            format!("bool {var} = false;"),
            format!("double {payload} = 0.0;"),
            // The runtime's stored `bool`: triggered, and not ready to bang
            // again. What the Trigger emits on `value`.
            format!("bool {triggered} = false;"),
        ],
        ..NodeEmission::default()
    };

    let sources = inputs.on("value");
    if let Some(note) = extra_sources_note("value", sources) {
        e.declarations.push(note);
    }
    let Some(source) = sources.first() else { return Ok(e) };

    let capacity = WINDOW_CAPACITY;
    // `millis()` is 32 bits on the device: a window that long never lets a
    // value go, which a longer `within` cannot do either.
    let within = config.within.min(u64::from(u32::MAX));
    let threshold = cpp_double(config.threshold);
    let count = format!("trigger_{token}_held");
    let head = format!("trigger_{token}_head");
    let at = format!("trigger_{token}_at");
    let seen = format!("trigger_{token}_seen");
    let now = format!("trigger_{token}_now");
    let ms = format!("trigger_{token}_ms");
    let slot = format!("trigger_{token}_slot");
    let diff = format!("trigger_{token}_diff");
    let direction = format!("trigger_{token}_direction");

    // A ring: `_head` is the oldest held value, `_held` how many from there on.
    e.declarations.push(format!("uint8_t {count} = 0;"));
    e.declarations.push(format!("uint8_t {head} = 0;"));
    e.declarations.push(format!("unsigned long {at}[{capacity}];"));
    e.declarations.push(format!("double {seen}[{capacity}];"));

    // The result reset must precede the detector lines `bind_port` appends.
    e.loop_body.push(format!("{var} = false;"));
    let binding = e.bind_port(&format!("trigger_{token}_in"), std::slice::from_ref(source));
    let Some(fired) = binding.fired.first() else { return Ok(e) };

    e.loop_body.push(format!("if ({fired}) {{"));
    e.loop_body.push(format!("  const double {now} = {};", source.value.as_double()));
    e.loop_body.push(format!("  const unsigned long {ms} = millis();"));
    // Let go of the values older than `within`.
    e.loop_body.push(format!(
        "  while ({count} > 0 && {ms} - {at}[{head}] > {within}UL) {{ {head} = ({head} + 1) % {capacity}; {count}--; }}"
    ));
    // Hold this one after the newest — or, with the ring full, in its place.
    e.loop_body.push(format!("  if ({count} < {capacity}) {{ {count}++; }}"));
    e.loop_body.push(format!("  const uint8_t {slot} = ({head} + {count} - 1) % {capacity};"));
    e.loop_body.push(format!("  {seen}[{slot}] = {now};"));
    e.loop_body.push(format!("  {at}[{slot}] = {ms};"));
    // The change counts from the oldest value held.
    e.loop_body.push(format!("  const double {diff} = {now} - {seen}[{head}];"));
    // Mirrors `value_changes_in_correct_direction`.
    let correct_direction = match config.behaviour {
        TriggerBehaviour::Increasing => format!("{diff} > 0.0"),
        TriggerBehaviour::Decreasing => format!("!({diff} > 0.0)"),
    };
    e.loop_body.push(format!("  const bool {direction} = {correct_direction};"));
    // Mirrors relative vs absolute threshold.
    let reached = if config.relative {
        format!("fabs({diff} / {seen}[{head}] * 100.0) >= {threshold}")
    } else {
        format!("fabs({diff}) >= {threshold}")
    };
    e.loop_body.push(format!("  if ({triggered}) {{"));
    e.loop_body.push(format!("    {triggered} = {direction};"));
    e.loop_body.push("  } else {".to_string());
    e.loop_body.push(format!("    {triggered} = {direction} && {reached};"));
    // Bang, carrying the value, like `emit_with_value`.
    e.loop_body.push(format!("    if ({triggered}) {{ {var} = true; {payload} = {now}; }}"));
    e.loop_body.push("  }".to_string());
    e.loop_body.push("}".to_string());
    Ok(e)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::wire::{CppExpr, SourceExpr};
    use crate::flow::Position;
    use serde_json::json;

    fn trigger(id: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Trigger".to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn value_input(expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::level(expr));
        inputs
    }

    // What the generated code does when it runs is pinned by
    // `tests/trigger_sketch.rs`, which compiles it; these pin its shape.

    /// A value arrives when the source fires: the old ones are let go, it is
    /// held, and the change counts from the oldest one held.
    #[test]
    fn a_trigger_holds_its_window_in_a_ring() {
        assert_eq!(WINDOW_CAPACITY, 16, "the literals below are the capacity");
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::event(CppExpr::number("src_value"), "src_fired"));
        let e = emit(&trigger("tg-1", json!({ "threshold": 5, "within": 300 })), &inputs).unwrap();

        assert_eq!(
            e.declarations,
            [
                "bool trigger_tg_1_result = false;",
                "double trigger_tg_1_value = 0.0;",
                "bool trigger_tg_1_triggered = false;",
                "uint8_t trigger_tg_1_held = 0;",
                "uint8_t trigger_tg_1_head = 0;",
                "unsigned long trigger_tg_1_at[16];",
                "double trigger_tg_1_seen[16];",
            ]
        );
        assert_eq!(
            e.loop_body,
            [
                "trigger_tg_1_result = false;",
                "if (src_fired) {",
                "  const double trigger_tg_1_now = ((double)(src_value));",
                "  const unsigned long trigger_tg_1_ms = millis();",
                "  while (trigger_tg_1_held > 0 && trigger_tg_1_ms - trigger_tg_1_at[trigger_tg_1_head] > 300UL) { trigger_tg_1_head = (trigger_tg_1_head + 1) % 16; trigger_tg_1_held--; }",
                // Full: the count stays, so the slot is the newest held one's.
                "  if (trigger_tg_1_held < 16) { trigger_tg_1_held++; }",
                "  const uint8_t trigger_tg_1_slot = (trigger_tg_1_head + trigger_tg_1_held - 1) % 16;",
                "  trigger_tg_1_seen[trigger_tg_1_slot] = trigger_tg_1_now;",
                "  trigger_tg_1_at[trigger_tg_1_slot] = trigger_tg_1_ms;",
                "  const double trigger_tg_1_diff = trigger_tg_1_now - trigger_tg_1_seen[trigger_tg_1_head];",
                "  const bool trigger_tg_1_direction = !(trigger_tg_1_diff > 0.0);",
                "  if (trigger_tg_1_triggered) {",
                "    trigger_tg_1_triggered = trigger_tg_1_direction;",
                "  } else {",
                "    trigger_tg_1_triggered = trigger_tg_1_direction && fabs(trigger_tg_1_diff) >= 5.0;",
                "    if (trigger_tg_1_triggered) { trigger_tg_1_result = true; trigger_tg_1_value = trigger_tg_1_now; }",
                "  }",
                "}",
            ]
        );
    }

    /// A level source is a value each time it changes, as the runtime twin
    /// emits it.
    #[test]
    fn a_level_source_is_a_value_when_it_changes() {
        let e = emit(&trigger("tg-1", json!({})), &value_input(CppExpr::number("v"))).unwrap();
        assert!(e.declarations.contains(&"double trigger_tg_1_in_prev0 = 0.0;".to_string()), "{:?}", e.declarations);
        assert!(
            e.loop_body.contains(&"bool trigger_tg_1_in_fired0 = (trigger_tg_1_in_now0 != trigger_tg_1_in_prev0);".to_string()),
            "{:?}",
            e.loop_body
        );
        assert!(e.loop_body.contains(&"if (trigger_tg_1_in_fired0) {".to_string()), "{:?}", e.loop_body);
    }

    #[test]
    fn the_window_is_a_quarter_second_unless_set() {
        let e = emit(&trigger("tg-1", json!({})), &value_input(CppExpr::number("v"))).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("> 250UL)")), "{:?}", e.loop_body);
    }

    #[test]
    fn bangs_on_absolute_threshold() {
        let e = emit(&trigger("tg-1", json!({ "threshold": 10.0 })), &value_input(CppExpr::number("v"))).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("bool trigger_tg_1_result")));
        assert!(
            e.loop_body.iter().any(|l| l.contains(">= 10.0")),
            "must compare against the configured threshold"
        );
    }

    #[test]
    fn captures_the_crossing_value_as_payload() {
        let e = emit(&trigger("tg-1", json!({})), &value_input(CppExpr::number("v"))).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("double trigger_tg_1_value")));
        assert!(
            e.loop_body
                .iter()
                .any(|l| l.contains("trigger_tg_1_value = trigger_tg_1_now")),
            "bang payload captured"
        );
    }

    #[test]
    fn decreasing_is_the_default_direction() {
        let e = emit(&trigger("tg-1", json!({})), &value_input(CppExpr::number("v"))).unwrap();
        assert!(
            e.loop_body.iter().any(|l| l.contains("= !(trigger_tg_1_diff > 0.0);")),
            "default behaviour is decreasing"
        );
    }

    #[test]
    fn increasing_flips_the_direction() {
        let e = emit(
            &trigger("tg-1", json!({ "behaviour": "increasing" })),
            &value_input(CppExpr::number("v")),
        ).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("diff > 0.0")));
    }

    #[test]
    fn relative_uses_percentage() {
        let e = emit(
            &trigger("tg-1", json!({ "relative": true, "threshold": 20.0 })),
            &value_input(CppExpr::number("v")),
        ).unwrap();
        assert!(e.loop_body.iter().any(|l| l.contains("* 100.0")), "relative => percent compare");
    }

    #[test]
    fn no_input_leaves_false() {
        let e = emit(&trigger("tg-1", json!({})), &NodeInputs::default()).unwrap();
        assert!(e.loop_body.is_empty(), "{:?}", e.loop_body);
        assert!(e.declarations.iter().any(|d| d.contains("= false;")));
    }

    #[test]
    fn emits_deterministically() {
        let n = trigger("tg-1", json!({ "threshold": 3.0, "behaviour": "increasing" }));
        let inputs = value_input(CppExpr::number("v"));
        assert_eq!(emit(&n, &inputs).unwrap(), emit(&n, &inputs).unwrap());
    }
}
