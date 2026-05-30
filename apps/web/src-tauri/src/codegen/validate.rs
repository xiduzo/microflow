//! Validate a Flow against a selected [`BoardTarget`] before emission.
//!
//! Generation must **never emit unrunnable code**: this module is the single
//! place that decides whether a Flow can run on the selected board. It consumes
//! the Task #28 board-target model (pin map + capabilities) and reports a list
//! of [`ValidationProblem`]s; an empty list means the Flow is runnable on that
//! target and emission may proceed.
//!
//! The checks are intentionally board-fact-driven — every decision is resolved
//! against the target's pin map and capability set rather than a hardcoded
//! default board:
//!
//! - **Pin exists** — a hardware-IO Node (Led, Relay, Servo, Button, Sensor)
//!   may only use a pin number the board actually has.
//! - **PWM output** — a Servo drives its pin with `analogWrite` (mirroring
//!   `runtime/output/servo.rs`), so its pin must be a PWM-capable pin on the
//!   board.
//! - **Analog input** — a Sensor reads `analogRead`, so its pin must be an
//!   analog-input pin on the board.
//! - **Analog over-subscription** — even when every Sensor's pin is individually
//!   valid, a Flow that uses more *distinct* analog-input pins than the board
//!   offers cannot run; the surplus Sensors are flagged so the Author sees the
//!   aggregate constraint, not just a per-Node one.
//! - **Networking capability** — a Cloud Node (Mqtt/Figma/Llm/Monitor) requires
//!   the board to offer [`BoardCapability::Networking`]; a bare board cannot run
//!   it.
//!
//! Each problem names the offending Node and the constraint it violates, so the
//! viewer can surface an actionable message (Feature #26 acceptance criteria).
//!
//! Like the rest of codegen this is a pure function of `(flow, target)`: no
//! clock, no IO, deterministic ordering (Nodes in `id` order).

use crate::codegen::board::{BoardCapability, BoardTarget};
use crate::codegen::emit::pin_or_default;
use crate::runtime::types::{FlowNode, FlowUpdate};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// The Cloud Node types — those that cross the hardware boundary and require a
/// networked board target. Kept in sync with `placeholder::CLOUD_NODE_TYPES`.
const CLOUD_NODE_TYPES: [&str; 4] = ["Mqtt", "Figma", "Llm", "Monitor"];

/// The default pin an emitter assigns to a pinned Node when its `data` omits
/// `pin`. Validation must resolve pins exactly as emission does, or the two
/// drift: a Node validated against pin 0 could then be emitted on its real
/// default pin. These mirror the `DEFAULT_PIN` constants in each emitter
/// (`codegen/output/*`, `codegen/input/*`), which in turn mirror the live
/// runtime defaults.
fn default_pin_for(node_type: &str) -> u8 {
    match node_type {
        "Led" => 13,
        "Relay" => 10,
        "Servo" => 3,
        "Button" => 6,
        // Sensor and anything else default to A0 / pin 0.
        _ => 0,
    }
}

/// One reason a Flow cannot be generated for the selected board target.
///
/// Carries the offending Node's id and type plus a human-readable `message`
/// naming the Node and the constraint, so the frontend can present an
/// actionable validation error instead of unrunnable code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ValidationProblem {
    /// The Flow id of the Node that violates a constraint.
    pub node_id: String,
    /// The Node's type (e.g. `Led`, `Mqtt`), or `unknown` when typeless.
    pub node_type: String,
    /// Human-readable description naming the Node and the constraint.
    pub message: String,
}

/// Validate `flow` against `target`, returning every problem that would make
/// generation emit code the board cannot run. An empty vector means the Flow is
/// runnable on `target`.
///
/// Problems are returned in deterministic Node-`id` order.
#[must_use]
pub fn validate(flow: &FlowUpdate, target: &BoardTarget) -> Vec<ValidationProblem> {
    // Visit Nodes in id order so the problem list is deterministic.
    let by_id: BTreeMap<&str, &FlowNode> =
        flow.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    // Per-Node feasibility (pin exists, PWM, analog index, networking).
    let mut problems: Vec<ValidationProblem> = by_id
        .values()
        .filter_map(|node| problem_for(node, target))
        .collect();

    // Aggregate analog over-subscription: a Flow may use only valid analog
    // indices yet still demand more *distinct* analog inputs than the board has.
    // The per-Node pass above cannot see this; this pass does.
    problems.extend(analog_oversubscription_problems(&by_id, target));
    problems
}

/// The single problem a Node raises against `target`, or `None` when it is
/// runnable. A Node raises at most one problem (the first constraint it fails).
fn problem_for(node: &FlowNode, target: &BoardTarget) -> Option<ValidationProblem> {
    let kind = node.node_type.as_deref();
    match kind {
        Some(k) if CLOUD_NODE_TYPES.contains(&k) => networking_problem(node, k, target),
        Some("Sensor") => sensor_pin_problem(node, target),
        // A Servo drives its pin with `analogWrite`, so the pin must both exist
        // and be PWM-capable; check existence first for the clearer message.
        Some("Servo") => {
            digital_pin_problem(node, "Servo", target).or_else(|| pwm_pin_problem(node, target))
        }
        Some(k @ ("Led" | "Relay" | "Button")) => digital_pin_problem(node, k, target),
        // Unknown / typeless Nodes emit only a placeholder comment, never
        // runnable code, so they cannot make a Sketch unrunnable.
        _ => None,
    }
}

/// A Cloud Node needs the board to offer networking.
fn networking_problem(
    node: &FlowNode,
    kind: &str,
    target: &BoardTarget,
) -> Option<ValidationProblem> {
    if target.offers(BoardCapability::Networking) {
        return None;
    }
    Some(problem(
        node,
        kind,
        format!(
            "Node {} ({kind}) requires networking, which board target '{}' does not offer",
            node.id, target.name
        ),
    ))
}

/// A hardware-IO Node's pin must exist in the board's pin map.
fn digital_pin_problem(
    node: &FlowNode,
    kind: &str,
    target: &BoardTarget,
) -> Option<ValidationProblem> {
    let pin = pin_or_default(node, default_pin_for(kind));
    if has_pin(target, pin) {
        return None;
    }
    Some(problem(
        node,
        kind,
        format!(
            "Node {} ({kind}) uses pin {pin}, which board target '{}' does not have",
            node.id, target.name
        ),
    ))
}

/// A Servo drives its pin with `analogWrite`, so the pin must be PWM-capable on
/// the board. Called only after [`digital_pin_problem`] has confirmed the pin
/// exists, so a `None` here means "exists but not PWM".
fn pwm_pin_problem(node: &FlowNode, target: &BoardTarget) -> Option<ValidationProblem> {
    let pin = pin_or_default(node, default_pin_for("Servo"));
    if target.pwm_pins().contains(&pin) {
        return None;
    }
    Some(problem(
        node,
        "Servo",
        format!(
            "Node {} (Servo) needs PWM on pin {pin}, but pin {pin} on board target '{}' does not support PWM",
            node.id, target.name
        ),
    ))
}

/// Aggregate analog-input demand across the whole Flow. Each Sensor consumes one
/// of the board's analog inputs; a Flow whose Sensors *together* demand more
/// analog inputs than the board offers cannot run, even when every Sensor's own
/// index is individually in range. The per-Node [`sensor_pin_problem`] check
/// cannot see this whole-Flow constraint — this pass does.
///
/// Sensors whose index is already out of range are reported by the per-Node
/// check and excluded here (so they are not double-counted). The first
/// `analog_count` in-range Sensors (in deterministic Node-`id` order) fit; every
/// Sensor beyond that capacity is flagged as surplus, naming the Node and the
/// analog-input constraint.
fn analog_oversubscription_problems(
    by_id: &BTreeMap<&str, &FlowNode>,
    target: &BoardTarget,
) -> Vec<ValidationProblem> {
    let analog_count = target.analog_input_pins().len();

    let mut used = 0usize;
    let mut surplus = Vec::new();
    for node in by_id.values() {
        if node.node_type.as_deref() != Some("Sensor") {
            continue;
        }
        let index = pin_or_default(node, 0);
        // Out-of-range indices are reported by the per-Node analog check; skip
        // them here so a Sensor never raises two problems.
        if (index as usize) >= analog_count {
            continue;
        }
        used += 1;
        if used > analog_count {
            surplus.push(problem(
                node,
                "Sensor",
                format!(
                    "Node {} (Sensor) needs an analog input, but board target '{}' offers only {analog_count} and the Flow already uses them all",
                    node.id, target.name
                ),
            ));
        }
    }
    surplus
}

/// A Sensor reads `analogRead`, so its analog index must map to an analog-input
/// pin the board offers. The Sensor stores an analog index (`A0` => 0); the
/// board exposes analog inputs by pin number, so the requirement is that the
/// board has at least `index + 1` analog inputs.
fn sensor_pin_problem(node: &FlowNode, target: &BoardTarget) -> Option<ValidationProblem> {
    let index = pin_or_default(node, 0);
    let analog_count = target.analog_input_pins().len();
    if (index as usize) < analog_count {
        return None;
    }
    Some(problem(
        node,
        "Sensor",
        format!(
            "Node {} (Sensor) reads analog input A{index}, but board target '{}' has only {analog_count} analog input(s)",
            node.id, target.name
        ),
    ))
}

/// True when `target`'s pin map contains a pin with `number`.
fn has_pin(target: &BoardTarget, number: u8) -> bool {
    target.pins.iter().any(|p| p.number == number)
}

/// Construct a [`ValidationProblem`] for `node`.
fn problem(node: &FlowNode, kind: &str, message: String) -> ValidationProblem {
    ValidationProblem {
        node_id: node.id.clone(),
        node_type: kind.to_string(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::board::target_by_id;
    use crate::runtime::types::Position;
    use serde_json::json;

    fn node(id: &str, kind: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some(kind.to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn flow(nodes: Vec<FlowNode>) -> FlowUpdate {
        FlowUpdate { nodes, edges: vec![] }
    }

    /// A Flow that fits the board reports no problems.
    #[test]
    fn runnable_flow_has_no_problems() {
        let uno = target_by_id("uno").unwrap();
        let f = flow(vec![
            node("led-1", "Led", json!({ "pin": 13 })),
            node("btn-1", "Button", json!({ "pin": 6 })),
            node("sensor-1", "Sensor", json!({ "pin": "A0" })),
        ]);
        assert!(validate(&f, &uno).is_empty());
    }

    /// A Cloud Node on a non-networking board is flagged, naming Node and
    /// constraint.
    #[test]
    fn cloud_node_on_bare_board_is_flagged() {
        let uno = target_by_id("uno").unwrap();
        let f = flow(vec![node("mqtt-1", "Mqtt", json!({}))]);
        let problems = validate(&f, &uno);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].node_id, "mqtt-1");
        assert!(problems[0].message.contains("mqtt-1"));
        assert!(problems[0].message.contains("networking"));
    }

    /// The same Cloud Node on a networking board (ESP32) is runnable.
    #[test]
    fn cloud_node_on_networking_board_is_runnable() {
        let esp32 = target_by_id("esp32").unwrap();
        let f = flow(vec![node("mqtt-1", "Mqtt", json!({}))]);
        assert!(validate(&f, &esp32).is_empty());
    }

    /// A pin the board lacks is flagged for a digital Node.
    #[test]
    fn pin_absent_from_board_is_flagged() {
        let uno = target_by_id("uno").unwrap();
        // Uno has no pin 40.
        let f = flow(vec![node("led-1", "Led", json!({ "pin": 40 }))]);
        let problems = validate(&f, &uno);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].message.contains("pin 40"));
        assert!(problems[0].message.contains("led-1"));
    }

    /// A Sensor analog index beyond the board's analog inputs is flagged.
    #[test]
    fn sensor_beyond_analog_inputs_is_flagged() {
        let uno = target_by_id("uno").unwrap();
        // Uno has six analog inputs A0-A5; A6 is out of range.
        let f = flow(vec![node("s-1", "Sensor", json!({ "pin": "A6" }))]);
        let problems = validate(&f, &uno);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].message.contains("A6"));
    }

    /// Scenario: A Flow needing more analog inputs than the board has is
    /// flagged. Seven Sensors (each in range A0-A5) on the Uno's six analog
    /// inputs over-subscribe; the surplus Sensor is flagged naming the Node and
    /// the analog-input constraint.
    #[test]
    fn flow_over_subscribing_analog_inputs_is_flagged() {
        let uno = target_by_id("uno").unwrap();
        // Uno has six analog inputs. Seven Sensors all on A0 (in range) demand
        // seven analog inputs together — one more than the board offers.
        let nodes: Vec<FlowNode> = (0..7)
            .map(|i| node(&format!("sensor-{i}"), "Sensor", json!({ "pin": "A0" })))
            .collect();
        let problems = validate(&flow(nodes), &uno);
        assert_eq!(problems.len(), 1, "exactly the surplus Sensor is flagged");
        // The seventh Sensor in id order (sensor-6) is the surplus one.
        assert_eq!(problems[0].node_id, "sensor-6");
        assert_eq!(problems[0].node_type, "Sensor");
        assert!(problems[0].message.contains("sensor-6"), "names the Node");
        assert!(problems[0].message.contains("analog input"), "names the constraint");
    }

    /// A Flow using exactly as many analog inputs as the board offers fits.
    #[test]
    fn flow_using_all_analog_inputs_exactly_is_runnable() {
        let uno = target_by_id("uno").unwrap();
        // Six Sensors on the Uno's six analog inputs — exactly at capacity.
        let nodes: Vec<FlowNode> = (0..6)
            .map(|i| node(&format!("sensor-{i}"), "Sensor", json!({ "pin": format!("A{i}") })))
            .collect();
        assert!(validate(&flow(nodes), &uno).is_empty());
    }

    /// An out-of-range Sensor raises only the per-Node problem, never also a
    /// duplicate over-subscription problem.
    #[test]
    fn out_of_range_sensor_is_not_double_counted() {
        let uno = target_by_id("uno").unwrap();
        let f = flow(vec![node("s-1", "Sensor", json!({ "pin": "A9" }))]);
        let problems = validate(&f, &uno);
        assert_eq!(problems.len(), 1, "single problem for the out-of-range Sensor");
        assert!(problems[0].message.contains("A9"));
    }

    /// A Servo on a non-PWM pin (that the board nonetheless has) is flagged for
    /// the PWM constraint, naming the Node and the pin.
    #[test]
    fn servo_on_non_pwm_pin_is_flagged() {
        let uno = target_by_id("uno").unwrap();
        // Uno pin 7 exists but is not a PWM pin (PWM: 3,5,6,9,10,11).
        let f = flow(vec![node("srv-1", "Servo", json!({ "pin": 7 }))]);
        let problems = validate(&f, &uno);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].node_id, "srv-1");
        assert!(problems[0].message.contains("PWM"), "names the PWM constraint");
        assert!(problems[0].message.contains("pin 7"), "names the pin");
    }

    /// A Servo on a PWM-capable pin is runnable.
    #[test]
    fn servo_on_pwm_pin_is_runnable() {
        let uno = target_by_id("uno").unwrap();
        // Uno pin 9 is PWM-capable.
        let f = flow(vec![node("srv-1", "Servo", json!({ "pin": 9 }))]);
        assert!(validate(&f, &uno).is_empty());
    }

    /// A Servo on a pin the board lacks is flagged for the missing pin, not PWM
    /// (existence is checked first for the clearer message).
    #[test]
    fn servo_on_absent_pin_reports_missing_pin() {
        let uno = target_by_id("uno").unwrap();
        let f = flow(vec![node("srv-1", "Servo", json!({ "pin": 40 }))]);
        let problems = validate(&f, &uno);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].message.contains("pin 40"));
        assert!(problems[0].message.contains("does not have"), "missing-pin message");
    }

    /// Scenario: Switching the board target re-validates the Flow. A Flow that
    /// validates cleanly on a networking board reports the networking problem
    /// once re-validated against a non-networking board. `validate` is pure, so
    /// re-running it with the new target is the re-validation.
    #[test]
    fn switching_target_revalidates_flow() {
        let esp32 = target_by_id("esp32").unwrap();
        let uno = target_by_id("uno").unwrap();
        let f = flow(vec![node("mqtt-1", "Mqtt", json!({}))]);

        // Clean on the networking board.
        assert!(validate(&f, &esp32).is_empty());

        // Re-validated against a board lacking networking, the new constraint
        // problem is reported — and no stale clean result persists.
        let problems = validate(&f, &uno);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].message.contains("networking"));
    }

    /// Problems are returned in deterministic Node-id order.
    #[test]
    fn problems_are_ordered_by_node_id() {
        let uno = target_by_id("uno").unwrap();
        let f = flow(vec![
            node("z-mqtt", "Mqtt", json!({})),
            node("a-mqtt", "Figma", json!({})),
        ]);
        let problems = validate(&f, &uno);
        assert_eq!(problems.len(), 2);
        assert_eq!(problems[0].node_id, "a-mqtt");
        assert_eq!(problems[1].node_id, "z-mqtt");
    }

    /// Unknown / typeless Nodes never make a Flow unrunnable.
    #[test]
    fn unknown_and_typeless_nodes_are_not_problems() {
        let uno = target_by_id("uno").unwrap();
        let mut typeless = node("t-1", "Gizmo", json!({}));
        typeless.node_type = None;
        let f = flow(vec![node("g-1", "Gizmo", json!({})), typeless]);
        assert!(validate(&f, &uno).is_empty());
    }

    /// Scenario: Cloud Node on a non-networked target is blocked — for **every**
    /// Cloud Node type, not just Mqtt. Each type, placed alone on the Uno (no
    /// networking), raises exactly one problem naming the Node and the missing
    /// networking capability.
    #[test]
    fn every_cloud_node_type_is_gated_on_non_networked_target() {
        let uno = target_by_id("uno").unwrap();
        for kind in CLOUD_NODE_TYPES {
            let id = format!("{}-1", kind.to_lowercase());
            let f = flow(vec![node(&id, kind, json!({}))]);
            let problems = validate(&f, &uno);
            assert_eq!(problems.len(), 1, "{kind} should raise one problem on the Uno");
            assert_eq!(problems[0].node_id, id, "{kind} problem names the Node id");
            assert_eq!(problems[0].node_type, kind, "{kind} problem carries the type");
            assert!(
                problems[0].message.contains(&id),
                "{kind} message names the Node: {}",
                problems[0].message
            );
            assert!(
                problems[0].message.contains("networking"),
                "{kind} message names the missing capability: {}",
                problems[0].message
            );
            assert!(
                problems[0].message.contains(&uno.name),
                "{kind} message names the offending target: {}",
                problems[0].message
            );
        }
    }

    /// Scenario: Cloud Node on a WiFi-capable target is allowed — for **every**
    /// Cloud Node type. Each type, placed alone on the ESP32 (networking), is
    /// runnable: no problem is raised.
    #[test]
    fn every_cloud_node_type_is_allowed_on_networking_target() {
        let esp32 = target_by_id("esp32").unwrap();
        for kind in CLOUD_NODE_TYPES {
            let id = format!("{}-1", kind.to_lowercase());
            let f = flow(vec![node(&id, kind, json!({}))]);
            assert!(
                validate(&f, &esp32).is_empty(),
                "{kind} should be runnable on the networking ESP32"
            );
        }
    }

    /// Edge case: multiple Cloud Nodes (of mixed types) on a non-networked
    /// target are **all** flagged — the Author sees every offending Node, not
    /// just the first. One problem per Cloud Node, each naming its own Node, in
    /// deterministic id order.
    #[test]
    fn multiple_cloud_nodes_all_flagged_on_non_networked_target() {
        let uno = target_by_id("uno").unwrap();
        let f = flow(vec![
            node("a-mqtt", "Mqtt", json!({})),
            node("b-figma", "Figma", json!({})),
            node("c-llm", "Llm", json!({})),
            node("d-monitor", "Monitor", json!({})),
        ]);
        let problems = validate(&f, &uno);
        assert_eq!(problems.len(), 4, "every Cloud Node is flagged");
        let ids: Vec<&str> = problems.iter().map(|p| p.node_id.as_str()).collect();
        assert_eq!(ids, ["a-mqtt", "b-figma", "c-llm", "d-monitor"], "ordered by id");
        for p in &problems {
            assert!(p.message.contains("networking"), "each names the capability");
        }
    }

    /// Scenario: A non-Cloud Flow is unaffected by the gate. A Flow with no
    /// Cloud Nodes that otherwise fits the Uno reports no problems — the
    /// networking gate never fires for core-only Flows.
    #[test]
    fn non_cloud_flow_is_unaffected_by_the_gate() {
        let uno = target_by_id("uno").unwrap();
        let f = flow(vec![
            node("led-1", "Led", json!({ "pin": 13 })),
            node("btn-1", "Button", json!({ "pin": 6 })),
        ]);
        assert!(validate(&f, &uno).is_empty());
    }
}
