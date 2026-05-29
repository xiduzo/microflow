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
//! - **Analog input** — a Sensor reads `analogRead`, so its pin must be an
//!   analog-input pin on the board.
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

    by_id
        .values()
        .filter_map(|node| problem_for(node, target))
        .collect()
}

/// The single problem a Node raises against `target`, or `None` when it is
/// runnable. A Node raises at most one problem (the first constraint it fails).
fn problem_for(node: &FlowNode, target: &BoardTarget) -> Option<ValidationProblem> {
    let kind = node.node_type.as_deref();
    match kind {
        Some(k) if CLOUD_NODE_TYPES.contains(&k) => networking_problem(node, k, target),
        Some("Sensor") => sensor_pin_problem(node, target),
        Some(k @ ("Led" | "Relay" | "Servo" | "Button")) => digital_pin_problem(node, k, target),
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
    let pin = pin_or_default(node, 0);
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
}
