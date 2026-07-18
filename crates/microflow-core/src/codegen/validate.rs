//! Validate a Flow against a selected [`BoardTarget`] before emission.
//!
//! This module is the single place that judges how a Flow fits the selected
//! board. It consumes the board-target model (pin map + capabilities) and
//! reports a list of [`ValidationProblem`]s, each carrying a
//! [`ProblemSeverity`]:
//!
//! - [`ProblemSeverity::Error`] — the emitted C++ itself would not compile
//!   (today: two Node ids sanitizing to the same identifier token). Errors
//!   block emission.
//! - [`ProblemSeverity::Warning`] — the Sketch compiles, but the Flow does not
//!   fit the selected board's facts (missing pin, missing PWM, missing
//!   networking, …). Warnings never block emission — the board pin maps are
//!   representative, not exhaustive, so a hard gate would refuse Flows that
//!   run fine on the Author's actual board.
//!
//! The board-fit checks are intentionally board-fact-driven — every decision is
//! resolved against the target's pin map and capability set rather than a
//! hardcoded default board:
//!
//! - **Pin exists** — a hardware-IO Node (Led, Relay, Servo, Button, Vibration)
//!   should use a pin number the board actually has.
//! - **PWM output** — a Servo drives its pin with PWM, so its pin should be
//!   PWM-capable on the board; likewise a Led/Vibration whose `value` port is
//!   wired drives brightness via `analogWrite`, which silently degrades to
//!   on/off on a non-PWM pin.
//! - **Analog input** — an analog-sensor Node reads `analogRead`, so its
//!   analog index must map to an analog input the board offers.
//! - **Analog over-subscription** — even when every analog index is
//!   individually valid, a Flow that uses more *distinct* analog inputs than
//!   the board offers cannot run; the surplus Nodes are flagged so the Author
//!   sees the aggregate constraint, not just a per-Node one.
//! - **Networking capability** — a Cloud Node (Mqtt/Figma/Llm/Monitor) needs
//!   the board to offer [`BoardCapability::Networking`]; the generated network
//!   code assumes an ESP32-class board.
//!
//! Each problem names the offending Node and the constraint it violates, so the
//! viewer can surface an actionable message.
//!
//! Like the rest of codegen this is a pure function of `(flow, target)`: no
//! clock, no IO, deterministic ordering (Nodes in `id` order).

use crate::codegen::board::{BoardCapability, BoardTarget};
use crate::codegen::emit::NodeToken;
use crate::codegen::placeholder::CLOUD_NODE_TYPES;
use crate::codegen::{input, output};
use crate::flow::{FlowNode, FlowUpdate};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// How severe a [`ValidationProblem`] is: whether it blocks emission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub enum ProblemSeverity {
    /// The emitted C++ would not compile — no Sketch is produced.
    Error,
    /// The Flow does not fit the selected board's facts, but the Sketch is
    /// still emitted — the Author decides whether the warning applies to their
    /// actual hardware.
    Warning,
}

/// One way a Flow conflicts with the selected board target (or with emission
/// itself — see [`ProblemSeverity`]).
///
/// Carries the offending Node's id and type plus a human-readable `message`
/// naming the Node and the constraint, so the frontend can present an
/// actionable message alongside (or, for errors, instead of) the Sketch.
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
    /// Whether this problem blocks emission.
    pub severity: ProblemSeverity,
}

/// Validate `flow` against `target`, returning every problem — warnings for
/// board-fit conflicts, errors for constraints that would make the emitted C++
/// itself uncompilable. An empty vector means the Flow fits `target` cleanly.
///
/// Problems are returned in deterministic Node-`id` order per pass.
#[must_use]
pub fn validate(flow: &FlowUpdate, target: &BoardTarget) -> Vec<ValidationProblem> {
    // Visit Nodes in id order so the problem list is deterministic.
    let by_id: BTreeMap<&str, &FlowNode> =
        flow.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    // Per-Node board fit (pin exists, PWM, analog index, networking).
    let mut problems: Vec<ValidationProblem> = by_id
        .values()
        .filter_map(|node| problem_for(node, target))
        .collect();

    // A Led/Vibration whose `value` port is wired drives PWM brightness; on a
    // non-PWM pin `analogWrite` silently degrades to digital on/off. The
    // per-Node pass cannot see the wiring; this pass does.
    problems.extend(led_brightness_pwm_problems(flow, &by_id, target));

    // Aggregate analog over-subscription: a Flow may use only valid analog
    // indices yet still demand more *distinct* analog inputs than the board has.
    // The per-Node pass above cannot see this; this pass does.
    problems.extend(analog_oversubscription_problems(&by_id, target));

    // Identifier collisions: emission derives every C++ symbol from the Node
    // id's sanitized token, so two ids that sanitize identically would emit
    // duplicate globals — an uncompilable Sketch. The one hard error.
    problems.extend(token_collision_problems(&by_id));
    problems
}

/// Flag every Node whose sanitized identifier token (`led-1` → `led_1`)
/// collides with another Node's. Emission namespaces all C++ symbols by that
/// token, so a collision means duplicate global definitions.
fn token_collision_problems(by_id: &BTreeMap<&str, &FlowNode>) -> Vec<ValidationProblem> {
    let mut by_token: BTreeMap<String, Vec<&FlowNode>> = BTreeMap::new();
    for node in by_id.values() {
        by_token.entry(node.id_token()).or_default().push(node);
    }

    let mut problems = Vec::new();
    for (token, nodes) in by_token {
        if nodes.len() < 2 {
            continue;
        }
        let ids: Vec<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
        for node in nodes {
            let kind = node.node_type.as_deref().unwrap_or("unknown");
            problems.push(problem(
                node,
                kind,
                ProblemSeverity::Error,
                format!(
                    "Node {} ({kind}) shares the generated identifier '{token}' with {} — rename the node ids so they differ by more than punctuation",
                    node.id,
                    ids.iter().filter(|id| **id != node.id).copied().collect::<Vec<_>>().join(", "),
                ),
            ));
        }
    }
    problems
}

/// The pin a Node will be emitted on — resolved by the Node's own emitter, so
/// validation and emission can never drift apart.
fn emitted_pin(node: &FlowNode, kind: &str) -> u8 {
    match kind {
        "Led" | "Vibration" => output::led::pin(node),
        "Relay" => output::relay::pin(node),
        "Servo" => output::servo::pin(node),
        "Button" => input::button::pin(node),
        _ => 0,
    }
}

/// The single problem a Node raises against `target`, or `None` when it fits.
/// A Node raises at most one problem here (the first constraint it fails).
fn problem_for(node: &FlowNode, target: &BoardTarget) -> Option<ValidationProblem> {
    let kind = node.node_type.as_deref();
    match kind {
        // Midi is a cloud-family node but needs NO networking on-device (serial
        // MIDI over the UART), so it is checked before the networking gate — it
        // warns instead that it claims the board's primary hardware serial.
        Some("Midi") => midi_serial_problem(node, target),
        Some(k) if CLOUD_NODE_TYPES.contains(&k) => networking_problem(node, k, target),
        Some(k) if input::sensor::ANALOG_SENSOR_TYPES.contains(&k) => {
            sensor_pin_problem(node, k, target)
        }
        // A Servo drives its pin with PWM, so the pin must both exist and be
        // PWM-capable; check existence first for the clearer message.
        Some("Servo") => {
            digital_pin_problem(node, "Servo", target).or_else(|| pwm_pin_problem(node, target))
        }
        Some(k @ ("Led" | "Relay" | "Button" | "Vibration")) => {
            digital_pin_problem(node, k, target)
        }
        // Unknown / typeless Nodes emit only a placeholder comment, never
        // runnable code, so they cannot make a Sketch unrunnable.
        _ => None,
    }
}

/// A Cloud Node needs the board to offer networking — the emitted network code
/// assumes an ESP32-class board and will not compile on a bare AVR core.
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
        ProblemSeverity::Warning,
        format!(
            "Node {} ({kind}) requires networking, which board target '{}' does not offer — the generated network code assumes an ESP32-class board",
            node.id, target.name
        ),
    ))
}

/// A Midi Node's serial-MIDI emitter claims the board's primary hardware UART
/// (`MIDI_CREATE_DEFAULT_INSTANCE()` binds `Serial` at 31250 baud), so the
/// Serial Monitor / USB serial is unavailable while flashed. A warning, never a
/// block: the Author may be using a MIDI shield or a board with a spare UART.
fn midi_serial_problem(node: &FlowNode, _target: &BoardTarget) -> Option<ValidationProblem> {
    Some(problem(
        node,
        "Midi",
        ProblemSeverity::Warning,
        format!(
            "Node {} (Midi) uses serial MIDI on the board's primary hardware serial (31250 baud) — the USB Serial Monitor is unavailable while running, and a DIN-5 MIDI jack or shield is required",
            node.id
        ),
    ))
}

/// A hardware-IO Node's pin should exist in the board's pin map.
fn digital_pin_problem(
    node: &FlowNode,
    kind: &str,
    target: &BoardTarget,
) -> Option<ValidationProblem> {
    let pin = emitted_pin(node, kind);
    if has_pin(target, pin) {
        return None;
    }
    Some(problem(
        node,
        kind,
        ProblemSeverity::Warning,
        format!(
            "Node {} ({kind}) uses pin {pin}, which is not a usable GPIO on board target '{}' (absent or reserved — e.g. ESP32 GPIO 6-11 drive the onboard flash)",
            node.id, target.name
        ),
    ))
}

/// A Servo drives its pin with PWM, so the pin should be PWM-capable on the
/// board. Called only after [`digital_pin_problem`] has confirmed the pin
/// exists, so a `None` here means "exists but not PWM".
fn pwm_pin_problem(node: &FlowNode, target: &BoardTarget) -> Option<ValidationProblem> {
    let pin = emitted_pin(node, "Servo");
    if target.pwm_pins().contains(&pin) {
        return None;
    }
    Some(problem(
        node,
        "Servo",
        ProblemSeverity::Warning,
        format!(
            "Node {} (Servo) needs PWM on pin {pin}, but pin {pin} on board target '{}' does not support PWM",
            node.id, target.name
        ),
    ))
}

/// A Led/Vibration Node whose `value` port is wired drives PWM brightness via
/// `analogWrite`; on a non-PWM pin the Arduino core silently degrades that to
/// digital on/off at the 128 threshold. Flag it so the Author moves the Node to
/// a PWM pin (or wires the digital `true`/`false` ports instead).
fn led_brightness_pwm_problems(
    flow: &FlowUpdate,
    by_id: &BTreeMap<&str, &FlowNode>,
    target: &BoardTarget,
) -> Vec<ValidationProblem> {
    by_id
        .values()
        .filter_map(|node| {
            let kind = node.node_type.as_deref()?;
            if !matches!(kind, "Led" | "Vibration") {
                return None;
            }
            let brightness_wired = flow
                .edges
                .iter()
                .any(|e| e.target == node.id && e.target_handle == "value");
            if !brightness_wired {
                return None;
            }
            let pin = emitted_pin(node, kind);
            // Only meaningful for pins the board has; a missing pin is already
            // flagged by the per-Node pass.
            if !has_pin(target, pin) || target.pwm_pins().contains(&pin) {
                return None;
            }
            Some(problem(
                node,
                kind,
                ProblemSeverity::Warning,
                format!(
                    "Node {} ({kind}) drives brightness on pin {pin}, which is not PWM-capable on board target '{}' — the output degrades to on/off",
                    node.id, target.name
                ),
            ))
        })
        .collect()
}

/// Aggregate analog-input demand across the whole Flow. Each analog-sensor Node
/// consumes one of the board's analog inputs; a Flow whose sensors *together*
/// demand more analog inputs than the board offers cannot run, even when every
/// sensor's own index is individually in range. The per-Node
/// [`sensor_pin_problem`] check cannot see this whole-Flow constraint — this
/// pass does.
///
/// Sensors whose index is already out of range are reported by the per-Node
/// check and excluded here (so they are not double-counted). The first
/// `analog_count` in-range sensors (in deterministic Node-`id` order) fit; every
/// sensor beyond that capacity is flagged as surplus, naming the Node and the
/// analog-input constraint.
fn analog_oversubscription_problems(
    by_id: &BTreeMap<&str, &FlowNode>,
    target: &BoardTarget,
) -> Vec<ValidationProblem> {
    let analog_count = target.analog_input_pins().len();

    let mut used = 0usize;
    let mut surplus = Vec::new();
    for node in by_id.values() {
        let Some(kind) = node.node_type.as_deref() else {
            continue;
        };
        if !input::sensor::ANALOG_SENSOR_TYPES.contains(&kind) {
            continue;
        }
        let index = input::sensor::analog_index(node);
        // Out-of-range indices are reported by the per-Node analog check; skip
        // them here so a sensor never raises two problems.
        if (index as usize) >= analog_count {
            continue;
        }
        used += 1;
        if used > analog_count {
            surplus.push(problem(
                node,
                kind,
                ProblemSeverity::Warning,
                format!(
                    "Node {} ({kind}) needs an analog input, but board target '{}' offers only {analog_count} and the Flow already uses them all",
                    node.id, target.name
                ),
            ));
        }
    }
    surplus
}

/// An analog-sensor Node reads `analogRead`, so its analog index must map to an
/// analog-input pin the board offers. The Node stores an analog index
/// (`A0` => 0); the board exposes analog inputs by pin number, so the
/// requirement is that the board has at least `index + 1` analog inputs.
fn sensor_pin_problem(
    node: &FlowNode,
    kind: &str,
    target: &BoardTarget,
) -> Option<ValidationProblem> {
    let index = input::sensor::analog_index(node);
    let analog_count = target.analog_input_pins().len();
    if (index as usize) < analog_count {
        return None;
    }
    Some(problem(
        node,
        kind,
        ProblemSeverity::Warning,
        format!(
            "Node {} ({kind}) reads analog input A{index}, but board target '{}' has only {analog_count} analog input(s)",
            node.id, target.name
        ),
    ))
}

/// True when `target`'s pin map contains a pin with `number`.
fn has_pin(target: &BoardTarget, number: u8) -> bool {
    target.pins.iter().any(|p| p.number == number)
}

/// Construct a [`ValidationProblem`] for `node`.
fn problem(
    node: &FlowNode,
    kind: &str,
    severity: ProblemSeverity,
    message: String,
) -> ValidationProblem {
    ValidationProblem {
        node_id: node.id.clone(),
        node_type: kind.to_string(),
        message,
        severity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::board::target_by_id;
    use crate::flow::Position;
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
        assert!(problems[0].message.contains("not a usable GPIO"), "missing-pin message");
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

    /// Board-fit problems are warnings; only identifier collisions (which make
    /// the C++ itself uncompilable) are errors.
    #[test]
    fn board_fit_problems_are_warnings_and_collisions_are_errors() {
        let uno = target_by_id("uno").unwrap();
        let f = flow(vec![
            // Board-fit conflicts: missing networking, absent pin.
            node("mqtt-1", "Mqtt", json!({})),
            node("led-1", "Led", json!({ "pin": 40 })),
            // Identifier collision: uncompilable C++.
            node("x-1", "Led", json!({ "pin": 13 })),
            node("x_1", "Led", json!({ "pin": 12 })),
        ]);
        let problems = validate(&f, &uno);
        for p in &problems {
            let expected = if p.message.contains("identifier") {
                ProblemSeverity::Error
            } else {
                ProblemSeverity::Warning
            };
            assert_eq!(p.severity, expected, "wrong severity for: {}", p.message);
        }
        assert!(problems.iter().any(|p| p.severity == ProblemSeverity::Error));
        assert!(problems.iter().any(|p| p.severity == ProblemSeverity::Warning));
    }

    /// A Led whose `value` port is wired drives PWM brightness; on a non-PWM
    /// pin that degrades to on/off, which is flagged as a warning.
    #[test]
    fn led_brightness_on_non_pwm_pin_is_flagged() {
        let uno = target_by_id("uno").unwrap();
        // Uno pin 13 exists but is not PWM-capable.
        let f = FlowUpdate {
            nodes: vec![
                node("led-1", "Led", json!({ "pin": 13 })),
                node("pot-1", "Potentiometer", json!({ "pin": "A0" })),
            ],
            edges: vec![crate::flow::FlowEdge {
                id: None,
                source: "pot-1".to_string(),
                target: "led-1".to_string(),
                source_handle: "value".to_string(),
                target_handle: "value".to_string(),
            }],
        };
        let problems = validate(&f, &uno);
        assert_eq!(problems.len(), 1, "exactly the brightness warning: {problems:?}");
        assert_eq!(problems[0].node_id, "led-1");
        assert_eq!(problems[0].severity, ProblemSeverity::Warning);
        assert!(problems[0].message.contains("brightness"), "names the constraint");
    }

    /// The same Led with only digital ports wired (or nothing wired) raises no
    /// brightness warning — digital writes work on every pin.
    #[test]
    fn unwired_led_on_non_pwm_pin_is_not_flagged() {
        let uno = target_by_id("uno").unwrap();
        let f = flow(vec![node("led-1", "Led", json!({ "pin": 13 }))]);
        assert!(validate(&f, &uno).is_empty());
    }

    /// The analog checks cover the whole analog-sensor family, not just the
    /// generic Sensor — the family shares the Sensor emitter.
    #[test]
    fn analog_family_members_are_checked_like_sensors() {
        let uno = target_by_id("uno").unwrap();
        let f = flow(vec![node("pot-1", "Potentiometer", json!({ "pin": "A9" }))]);
        let problems = validate(&f, &uno);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].node_type, "Potentiometer");
        assert!(problems[0].message.contains("A9"));
    }

    /// Two Node ids that sanitize to the same C++ token are refused — the
    /// emitted globals would collide and the Sketch would not compile.
    #[test]
    fn colliding_identifier_tokens_are_flagged() {
        let uno = target_by_id("uno").unwrap();
        let f = flow(vec![
            node("led-1", "Led", json!({ "pin": 13 })),
            node("led_1", "Led", json!({ "pin": 12 })),
        ]);
        let problems = validate(&f, &uno);
        assert_eq!(problems.len(), 2, "both colliding Nodes are flagged");
        for p in &problems {
            assert!(p.message.contains("led_1"), "names the shared token: {}", p.message);
        }
    }

    /// Distinct tokens raise no collision problem.
    #[test]
    fn distinct_identifier_tokens_are_not_flagged() {
        let uno = target_by_id("uno").unwrap();
        let f = flow(vec![
            node("led-1", "Led", json!({ "pin": 13 })),
            node("led-2", "Led", json!({ "pin": 12 })),
        ]);
        assert!(validate(&f, &uno).is_empty());
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
