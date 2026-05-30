//! Sketch Generation context — translate a Flow graph ahead-of-time into an
//! Arduino sketch (`.ino` source).
//!
//! This module is the entry point of the Sketch Generation context. It sits as
//! a sibling to [`crate::runtime`] and reuses the same Flow read-model
//! (`FlowUpdate`, `FlowNode`, `FlowEdge`) rather than redefining it. Unlike the
//! runtime, codegen never touches `BoardHandle`/Firmata — it is a pure function
//! of the input Flow.
//!
//! For this task the produced sketch is a *skeleton*: a declarations region, an
//! empty-but-valid `setup()`, and a `millis()`-based, non-blocking scheduler in
//! `loop()` (no blocking `delay()`). Per-Node C++ bodies are emitted by a later
//! task; the skeleton merely provides the slots they fill.
//!
//! ## Invariants
//!
//! - **Determinism:** identical Flow → byte-identical Sketch text. Traversal is
//!   ordered by Node `id`, never by an unordered map.
//! - **Termination:** generation always terminates, even for graphs containing
//!   cycles or disconnected Nodes — a `visited` set guards the walk.
//! - **Validity:** the output is always syntactically valid Arduino C++ and
//!   compiles even when the Flow is empty.

pub mod board;
pub mod cloud;
pub mod control;
pub mod credentials;
pub mod emit;
pub mod generator;
pub mod input;
pub mod output;
pub mod placeholder;
pub mod transformation;
pub mod validate;

use crate::runtime::types::{FlowNode, FlowUpdate};
use board::BoardTarget;
use credentials::Credentials;
use emit::NodeEmission;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::TS;
use validate::ValidationProblem;

/// The outcome of generating a Sketch for a selected board target.
///
/// Generation either emits a runnable `.ino` source, or — when the Flow cannot
/// run on the selected target — surfaces the validation problems that prevented
/// emission. This enforces the invariant that **no unrunnable code is ever
/// emitted**: when problems exist, no `sketch` is produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub enum GenerationOutcome {
    /// The Flow is runnable on the target; carries the generated `.ino` source.
    Sketch(String),
    /// The Flow cannot run on the target; carries the validation problems
    /// (each naming a Node and the constraint it violates).
    Problems(Vec<ValidationProblem>),
}

/// Generate the Arduino sketch for `flow` targeting `target`.
///
/// First validates the Flow against the selected board target (Task #35
/// result): if any problem exists, returns [`GenerationOutcome::Problems`] and
/// emits **no** Sketch. Otherwise emits the Sketch, whose pin numbers and
/// capability usage reflect `target`'s facts.
///
/// The traversal is deterministic (Nodes visited in `id` order) and always
/// terminates, so the same `(flow, target)` always yields byte-identical
/// output.
///
/// # Errors
///
/// Never returns `Err` today — the signature is `Result` so later tasks (which
/// may fail to emit a particular Node) can surface a human-readable message to
/// the frontend without changing the contract. A Flow that cannot run on the
/// target is **not** an error: it returns `Ok(GenerationOutcome::Problems(..))`.
pub fn generate(flow: &FlowUpdate, target: &BoardTarget) -> Result<GenerationOutcome, String> {
    generate_with_credentials(flow, target, None)
}

/// Generate the Arduino sketch for `flow` targeting `target`, threading the
/// Author-supplied network `credentials` into a Cloud-capable Sketch.
///
/// Identical to [`generate`] except that, when the Flow has Cloud Nodes on a
/// networking-capable target, the `WiFi` connect preamble embeds these
/// credentials so the device connects on boot. `None` is equivalent to empty
/// credentials — the preamble is still emitted (so the structure is stable),
/// with empty SSID/password slots the Author can fill. Non-networked Sketches
/// are unaffected.
///
/// Secrets in `credentials` are never logged (the [`Credentials`] `Debug` impl
/// masks them); the password is embedded only in the emitted Sketch, its
/// intended destination.
///
/// # Errors
///
/// Mirrors [`generate`]: never returns `Err` today; a Flow that cannot run on
/// the target is `Ok(GenerationOutcome::Problems(..))`, not an error.
pub fn generate_with_credentials(
    flow: &FlowUpdate,
    target: &BoardTarget,
    credentials: Option<&Credentials>,
) -> Result<GenerationOutcome, String> {
    // Gate emission on validation: never emit unrunnable code.
    let problems = validate::validate(flow, target);
    if !problems.is_empty() {
        log::debug!(
            "codegen: {} validation problem(s) for target '{}' — emitting no sketch",
            problems.len(),
            target.id
        );
        return Ok(GenerationOutcome::Problems(problems));
    }

    Ok(GenerationOutcome::Sketch(emit_sketch(flow, target, credentials)))
}

/// Assemble the Arduino sketch text for an already-validated Flow.
///
/// Pin numbers and capability usage reflect `target`'s facts. Separated from
/// [`generate`] so the validation gate is the single entry point.
fn emit_sketch(
    flow: &FlowUpdate,
    target: &BoardTarget,
    credentials: Option<&Credentials>,
) -> String {
    let order = traversal_order(flow);
    let drivers = driver_expressions(flow);

    // Emit each Node in deterministic traversal order, collecting fragments.
    // The target supplies the board's pin facts so emission is board-correct.
    let emissions: Vec<NodeEmission> =
        order.iter().map(|node| emit_node(node, &drivers, target)).collect();

    // Cloud-capable Sketches (Cloud Nodes on a networking target) connect to
    // WiFi on boot. The preamble is gated on Networking capability + cloud-node
    // presence, so non-networked Sketches are byte-for-byte unchanged. The
    // dispatch match is untouched — the preamble is a separate region concern.
    let preamble = credentials::wifi_preamble(flow, target, credentials);

    let emitted_count = emissions.iter().filter(|e| !e.is_empty()).count();
    log::debug!(
        "codegen: emitted {emitted_count} of {} node(s) for target '{}'",
        order.len(),
        target.id
    );

    let mut sketch = String::new();
    sketch.push_str(&header(&order, target));
    sketch.push_str(&includes_region(&emissions, preamble.as_ref()));
    sketch.push_str(&declarations(&order, &emissions, preamble.as_ref()));
    sketch.push_str(&setup_region(&emissions, preamble.as_ref()));
    sketch.push_str(&loop_region(&emissions));

    sketch
}

/// Deterministic traversal of the Flow.
///
/// Nodes are visited in stable `id` order; adjacency is followed depth-first
/// guarded by a `visited` set so cycles terminate. Disconnected Nodes are still
/// reached because the outer loop seeds the walk from every Node in id order.
/// The returned vector lists every Node exactly once.
fn traversal_order(flow: &FlowUpdate) -> Vec<&FlowNode> {
    let by_id: BTreeMap<&str, &FlowNode> =
        flow.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    // Adjacency keyed by source id, targets kept sorted + deduped for determinism.
    let mut adjacency: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for edge in &flow.edges {
        adjacency
            .entry(edge.source.as_str())
            .or_default()
            .insert(edge.target.as_str());
    }

    let mut visited: BTreeSet<&str> = BTreeSet::new();
    let mut order: Vec<&FlowNode> = Vec::with_capacity(by_id.len());

    // Seed from every Node in id order so disconnected Nodes are included and
    // the result is independent of edge declaration order.
    for &id in by_id.keys() {
        visit(id, &by_id, &adjacency, &mut visited, &mut order);
    }

    order
}

/// Depth-first visit guarded by `visited`; the guard is what makes cycles
/// terminate. Children are followed in sorted id order for determinism.
fn visit<'a>(
    id: &'a str,
    by_id: &BTreeMap<&'a str, &'a FlowNode>,
    adjacency: &BTreeMap<&'a str, BTreeSet<&'a str>>,
    visited: &mut BTreeSet<&'a str>,
    order: &mut Vec<&'a FlowNode>,
) {
    if !visited.insert(id) {
        return;
    }
    if let Some(node) = by_id.get(id) {
        order.push(node);
    }
    if let Some(targets) = adjacency.get(id) {
        for &target in targets {
            visit(target, by_id, adjacency, visited, order);
        }
    }
}

/// File header comment naming the board target and the Node count the skeleton
/// was built from. Naming the target makes the Sketch self-describing about
/// which board it was generated for.
fn header(order: &[&FlowNode], target: &BoardTarget) -> String {
    format!(
        "// Generated by microflow — do not edit by hand.\n// Target board: {} ({}).\n// Sketch skeleton for {} node(s).\n\n",
        target.name,
        target.id,
        order.len()
    )
}

/// Dispatch a single Node to its per-type C++ emitter, mirroring the live
/// `ComponentRegistry`. Node types outside the supported core hardware-IO set
/// (Cloud Nodes like Mqtt/Figma/Llm/Monitor, unknown types, and typeless
/// Nodes) fall through to [`placeholder::emit`], which returns a graceful
/// comment fragment so generation never crashes or blanks the sketch.
/// `drivers` maps a target Node id to the C++ expression that drives it (from
/// its wired source), so output Nodes write what their input reads. `_target`
/// is the validated board target; pin numbers written by the emitters are the
/// Node's own pin, which validation has already confirmed exists on the target.
fn emit_node(
    node: &FlowNode,
    drivers: &BTreeMap<&str, String>,
    _target: &BoardTarget,
) -> NodeEmission {
    let driver = drivers.get(node.id.as_str()).map(String::as_str);
    match node.node_type.as_deref() {
        Some("Led") => output::led::emit(node, driver),
        Some("Relay") => output::relay::emit(node, driver),
        Some("Servo") => output::servo::emit(node, driver),
        Some("Rgb") => output::rgb::emit(node, driver),
        Some("Piezo") => output::piezo::emit(node, driver),
        Some("Pixel") => output::pixel::emit(node, driver),
        Some("Matrix") => output::matrix::emit(node, driver),
        Some("Stepper") => output::stepper::emit(node, driver),
        // Vibration shares the live Led implementation (digital on/off output).
        Some("Vibration") => output::led::emit(node, driver),
        Some("Button") => input::button::emit(node),
        // Force, HallEffect, Ldr, Potentiometer, and Tilt are all analog inputs
        // backed by the live Sensor implementation, so they share its emitter.
        Some("Sensor" | "Force" | "HallEffect" | "Ldr" | "Potentiometer" | "Tilt") => {
            input::sensor::emit(node)
        }
        Some("Switch") => input::switch::emit(node),
        Some("Motion") => input::motion::emit(node),
        Some("Proximity") => input::proximity::emit(node),
        Some("Hotkey") => input::hotkey::emit(node),
        Some("I2cDevice") => input::i2c_device::emit(node),
        Some("Oscillator") => generator::oscillator::emit(node),
        Some("Calculate") => transformation::calculate::emit(node, driver),
        Some("Compare") => transformation::compare::emit(node, driver),
        Some("Gate") => transformation::gate::emit(node, driver),
        Some("RangeMap") => transformation::range_map::emit(node, driver),
        Some("Smooth") => transformation::smooth::emit(node, driver),
        Some("Function") => transformation::function::emit(node, driver),
        Some("Delay") => control::delay::emit(node, driver),
        Some("Interval") => control::interval::emit(node),
        Some("Trigger") => control::trigger::emit(node, driver),
        Some("Counter") => control::counter::emit(node, driver),
        Some("Constant") => control::constant::emit(node),
        // Mqtt is the one Cloud Node with an on-device emitter (Task #38). It
        // only reaches here on a networking target — validation refuses it
        // otherwise. The other Cloud Nodes (Figma/Llm/Monitor) still fall
        // through to the placeholder below.
        Some("Mqtt") => cloud::mqtt::emit(node, driver),
        _ => placeholder::emit(node),
    }
}

/// Build the map from a target Node id to the C++ expression that drives it.
///
/// An output Node (Led/Relay/Servo) wired from an input Node (Button/Sensor)
/// reads that input's state/value variable. When a target has multiple incoming
/// edges, the source with the smallest id wins, keeping the result
/// deterministic. Edges from sources that expose no readable expression are
/// ignored.
fn driver_expressions(flow: &FlowUpdate) -> BTreeMap<&str, String> {
    let by_id: BTreeMap<&str, &FlowNode> =
        flow.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    // For determinism, choose the smallest source id per target.
    let mut chosen: BTreeMap<&str, &str> = BTreeMap::new();
    for edge in &flow.edges {
        let target = edge.target.as_str();
        let source = edge.source.as_str();
        chosen
            .entry(target)
            .and_modify(|s| {
                if source < *s {
                    *s = source;
                }
            })
            .or_insert(source);
    }

    chosen
        .into_iter()
        .filter_map(|(target, source)| {
            let src_node = by_id.get(source)?;
            source_expression(src_node).map(|expr| (target, expr))
        })
        .collect()
}

/// The C++ expression a source Node exposes for downstream Nodes to read, or
/// `None` if the Node type produces no readable value.
fn source_expression(node: &FlowNode) -> Option<String> {
    match node.node_type.as_deref() {
        Some("Button") => Some(input::button::state_var(node)),
        Some("Sensor" | "Force" | "HallEffect" | "Ldr" | "Potentiometer" | "Tilt") => {
            Some(input::sensor::value_var(node))
        }
        Some("Switch") => Some(input::switch::state_var(node)),
        Some("Motion") => Some(input::motion::state_var(node)),
        Some("Proximity") => Some(input::proximity::value_var(node)),
        Some("Hotkey") => Some(input::hotkey::state_var(node)),
        Some("I2cDevice") => Some(input::i2c_device::value_var(node)),
        Some("Oscillator") => Some(generator::oscillator::value_var(node)),
        Some("Calculate") => Some(transformation::calculate::value_var(node)),
        Some("Compare") => Some(transformation::compare::state_var(node)),
        Some("Gate") => Some(transformation::gate::state_var(node)),
        Some("RangeMap") => Some(transformation::range_map::value_var(node)),
        Some("Smooth") => Some(transformation::smooth::value_var(node)),
        Some("Function") => Some(transformation::function::value_var(node)),
        Some("Delay") => Some(control::delay::value_var(node)),
        Some("Interval") => Some(control::interval::value_var(node)),
        Some("Trigger") => Some(control::trigger::state_var(node)),
        Some("Counter") => Some(control::counter::value_var(node)),
        Some("Constant") => Some(control::constant::value_var(node)),
        // A subscribe Mqtt Node surfaces its latest inbound message as a value;
        // a publish Mqtt Node exposes none (returns `None`).
        Some("Mqtt") => cloud::mqtt::value_var(node),
        _ => None,
    }
}

/// Deduplicated `#include` block, sorted for determinism. The optional `WiFi`
/// preamble (Cloud-capable Sketch) contributes its client-library include.
fn includes_region(
    emissions: &[NodeEmission],
    preamble: Option<&credentials::WifiPreamble>,
) -> String {
    let mut includes: BTreeSet<&str> = emissions
        .iter()
        .flat_map(|e| e.includes.iter().map(String::as_str))
        .collect();
    if let Some(p) = preamble {
        includes.insert(p.include.as_str());
    }
    if includes.is_empty() {
        return String::new();
    }
    let mut out = String::from("// --- Includes ---\n");
    for inc in includes {
        out.push_str(inc);
        out.push('\n');
    }
    out.push('\n');
    out
}

/// Declarations region. Each Node gets a labelled comment slot followed by its
/// real declarations (in traversal order) so output is stable and readable.
fn declarations(
    order: &[&FlowNode],
    emissions: &[NodeEmission],
    preamble: Option<&credentials::WifiPreamble>,
) -> String {
    let mut out = String::from("// --- Declarations ---\n");
    // WiFi credential declarations lead the region for a Cloud-capable Sketch.
    if let Some(p) = preamble {
        out.push_str("// WiFi credentials (Cloud Nodes)\n");
        for line in &p.declarations {
            out.push_str(line);
            out.push('\n');
        }
    }
    for (node, emission) in order.iter().zip(emissions) {
        let kind = node.node_type.as_deref().unwrap_or("unknown");
        out.push_str(&format!("// node {} ({})\n", node.id, kind));
        for line in &emission.declarations {
            out.push_str(line);
            out.push('\n');
        }
    }
    out.push('\n');
    out
}

/// `setup()` with each Node's init statements stitched in (traversal order).
/// The optional `WiFi` preamble runs first so the device is online before any
/// Cloud Node's own `setup()` work.
fn setup_region(
    emissions: &[NodeEmission],
    preamble: Option<&credentials::WifiPreamble>,
) -> String {
    let mut out = String::from("void setup() {\n  // --- Setup ---\n");
    if let Some(p) = preamble {
        for line in &p.setup {
            out.push_str("  ");
            out.push_str(line);
            out.push('\n');
        }
    }
    for line in emissions.iter().flat_map(|e| &e.setup) {
        out.push_str("  ");
        out.push_str(line);
        out.push('\n');
    }
    out.push_str("}\n\n");
    out
}

/// Non-blocking, `millis()`-based scheduler `loop()`. It compares `millis()`
/// against a per-tick deadline instead of calling blocking `delay()`, giving a
/// deterministic, host-free model. Per-Node read/write logic runs inside the
/// scheduled-task block in traversal order.
fn loop_region(emissions: &[NodeEmission]) -> String {
    let mut out = String::from(
        "void loop() {\n  \
static unsigned long previousMillis = 0;\n  \
const unsigned long interval = 1; // ms; non-blocking scheduler tick\n  \
unsigned long currentMillis = millis();\n  \
if (currentMillis - previousMillis >= interval) {\n    \
previousMillis = currentMillis;\n    \
// --- Scheduled tasks ---\n",
    );
    for line in emissions.iter().flat_map(|e| &e.loop_body) {
        out.push_str("    ");
        out.push_str(line);
        out.push('\n');
    }
    out.push_str("  }\n}\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::board::target_by_id;
    use crate::runtime::types::{FlowEdge, Position};
    use serde_json::json;

    /// The default board target used by the existing skeleton tests (Uno).
    fn default_target() -> BoardTarget {
        target_by_id("uno").expect("uno is supported")
    }

    /// Generate a Sketch for the default target, unwrapping the
    /// [`GenerationOutcome::Sketch`] variant. Panics if validation produced
    /// problems — these tests use Flows that fit the Uno.
    fn generate_sketch_text(flow: &FlowUpdate) -> String {
        sketch_for(flow, &default_target())
    }

    /// Generate a Sketch for an explicit target, unwrapping the
    /// [`GenerationOutcome::Sketch`] variant.
    fn sketch_for(flow: &FlowUpdate, target: &BoardTarget) -> String {
        match generate(flow, target).expect("generation should succeed") {
            GenerationOutcome::Sketch(s) => s,
            GenerationOutcome::Problems(p) => {
                panic!("expected a sketch, got validation problems: {p:?}")
            }
        }
    }

    /// A networking-capable target (ESP32) — used by placeholder tests that
    /// include Cloud Nodes, which only validate on a networking board.
    fn networking_target() -> BoardTarget {
        target_by_id("esp32").expect("esp32 is supported")
    }

    fn node(id: &str, kind: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some(kind.to_string()),
            data: json!({}),
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn node_data(id: &str, kind: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some(kind.to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn edge(source: &str, target: &str) -> FlowEdge {
        FlowEdge {
            id: None,
            source: source.to_string(),
            target: target.to_string(),
            source_handle: "out".to_string(),
            target_handle: "in".to_string(),
        }
    }

    /// Generate a Sketch for an explicit target with credentials, unwrapping
    /// the [`GenerationOutcome::Sketch`] variant.
    fn sketch_with_creds(
        flow: &FlowUpdate,
        target: &BoardTarget,
        creds: &credentials::Credentials,
    ) -> String {
        match generate_with_credentials(flow, target, Some(creds))
            .expect("generation should succeed")
        {
            GenerationOutcome::Sketch(s) => s,
            GenerationOutcome::Problems(p) => {
                panic!("expected a sketch, got validation problems: {p:?}")
            }
        }
    }

    /// Scenario: Author provides credentials used by the generated sketch.
    /// Given a Cloud Node on the `WiFi`-capable ESP32 and supplied credentials,
    /// the generated Sketch joins `WiFi` on boot using those exact credentials.
    #[test]
    fn cloud_sketch_connects_to_wifi_on_boot_with_supplied_credentials() {
        let flow = FlowUpdate { nodes: vec![node("mqtt-1", "Mqtt")], edges: vec![] };
        let creds = credentials::Credentials {
            wifi_ssid: "studio-net".to_string(),
            wifi_password: "s3cret-pass".to_string(),
            broker_host: "broker.example.com".to_string(),
            broker_port: 1883,
            ..credentials::Credentials::default()
        };

        let sketch = sketch_with_creds(&flow, &networking_target(), &creds);

        assert!(sketch.contains("#include <WiFi.h>"), "WiFi include missing:\n{sketch}");
        assert!(sketch.contains("\"studio-net\""), "SSID not embedded:\n{sketch}");
        assert!(sketch.contains("\"s3cret-pass\""), "password not embedded in sketch");
        assert!(
            sketch.contains("WiFi.begin(wifi_ssid, wifi_password);"),
            "no WiFi.begin in setup:\n{sketch}"
        );
        assert!(sketch.contains("WL_CONNECTED"), "no connect-wait:\n{sketch}");
        // The connect-wait runs inside setup(), before loop().
        let setup_idx = sketch.find("void setup()").expect("setup present");
        let loop_idx = sketch.find("void loop()").expect("loop present");
        let begin_idx = sketch.find("WiFi.begin").expect("begin present");
        assert!(setup_idx < begin_idx && begin_idx < loop_idx, "WiFi.begin must be in setup()");
    }

    /// A core-only Flow on a networking target emits no `WiFi` preamble — the
    /// credential surface is additive and never touches non-Cloud Sketches.
    #[test]
    fn core_only_sketch_has_no_wifi_preamble() {
        let flow = FlowUpdate { nodes: vec![node_data("led-1", "Led", json!({"pin": 13}))], edges: vec![] };
        let creds = credentials::Credentials {
            wifi_ssid: "net".to_string(),
            wifi_password: "pw".to_string(),
            ..credentials::Credentials::default()
        };
        let sketch = sketch_with_creds(&flow, &networking_target(), &creds);
        assert!(!sketch.contains("WiFi.begin"), "core-only sketch must not connect WiFi");
        assert!(!sketch.contains("<WiFi.h>"), "no WiFi include for core-only sketch");
    }

    /// `generate` (no credentials) on a Cloud Flow still emits a stable `WiFi`
    /// preamble with empty credential slots — the structure is present for the
    /// Author to fill, and no secret is fabricated.
    #[test]
    fn cloud_sketch_without_credentials_emits_empty_slots() {
        let flow = FlowUpdate { nodes: vec![node("mqtt-1", "Mqtt")], edges: vec![] };
        let sketch = sketch_for(&flow, &networking_target());
        assert!(sketch.contains("#include <WiFi.h>"));
        assert!(sketch.contains("const char* wifi_ssid = \"\";"), "empty ssid slot:\n{sketch}");
        assert!(sketch.contains("WiFi.begin(wifi_ssid, wifi_password);"));
    }

    /// Scenario: Empty Flow yields a valid empty sketch.
    #[test]
    fn empty_flow_yields_valid_empty_sketch() {
        let flow = FlowUpdate { nodes: vec![], edges: vec![] };

        let sketch = generate_sketch_text(&flow);

        // Valid empty sketch: both required sections present.
        assert!(sketch.contains("void setup()"), "missing setup section");
        assert!(sketch.contains("void loop()"), "missing loop section");
        // No blocking delay in the scheduler.
        assert!(!sketch.contains("delay("), "skeleton must be non-blocking");
        assert!(sketch.contains("0 node(s)"), "empty flow should report zero nodes");
    }

    /// Scenario: Same Flow always produces the same sketch.
    #[test]
    fn same_flow_always_produces_the_same_sketch() {
        let flow = FlowUpdate {
            nodes: vec![node("led-1", "Led"), node("btn-1", "Button"), node("srv-1", "Servo")],
            edges: vec![edge("btn-1", "led-1"), edge("led-1", "srv-1")],
        };

        let first = generate_sketch_text(&flow);
        let second = generate_sketch_text(&flow);

        assert_eq!(first, second, "identical flow must yield byte-identical sketch");
    }

    /// Scenario: Same Flow always produces the same sketch — independent of the
    /// declaration order of nodes and edges (the determinism invariant).
    #[test]
    fn ordering_of_input_does_not_change_output() {
        let forward = FlowUpdate {
            nodes: vec![node("a", "Led"), node("b", "Button"), node("c", "Sensor")],
            edges: vec![edge("a", "b"), edge("b", "c")],
        };
        let shuffled = FlowUpdate {
            nodes: vec![node("c", "Sensor"), node("a", "Led"), node("b", "Button")],
            edges: vec![edge("b", "c"), edge("a", "b")],
        };

        assert_eq!(
            generate_sketch_text(&forward),
            generate_sketch_text(&shuffled),
            "output must depend on graph content, not declaration order"
        );
    }

    /// Scenario: A graph with a cycle terminates deterministically.
    #[test]
    fn graph_with_cycle_terminates_deterministically() {
        let flow = FlowUpdate {
            nodes: vec![node("a", "Led"), node("b", "Button"), node("c", "Relay")],
            // a -> b -> c -> a forms a cycle.
            edges: vec![edge("a", "b"), edge("b", "c"), edge("c", "a")],
        };

        // If traversal did not guard with a visited set this would loop forever;
        // the test completing at all proves termination.
        let first = generate_sketch_text(&flow);
        let second = generate_sketch_text(&flow);

        assert_eq!(first, second, "cyclic flow must still be deterministic");
        // Every node appears exactly once despite the cycle.
        assert_eq!(first.matches("// node ").count(), 3, "each node emitted once");
    }

    /// Scenario: Disconnected Nodes do not break generation.
    #[test]
    fn disconnected_nodes_do_not_break_generation() {
        let flow = FlowUpdate {
            nodes: vec![node("a", "Led"), node("b", "Button"), node("lonely", "Sensor")],
            // "lonely" is connected to nothing.
            edges: vec![edge("a", "b")],
        };

        let sketch = generate_sketch_text(&flow);

        assert!(sketch.contains("void setup()"));
        assert!(sketch.contains("void loop()"));
        // The disconnected node is still handled (deterministically reached via
        // the id-ordered seed loop).
        assert!(sketch.contains("// node lonely (Sensor)"), "disconnected node missing");
        assert_eq!(sketch.matches("// node ").count(), 3, "all nodes emitted once");
    }

    /// Scenario: A core hardware-IO Flow produces a compilable sketch.
    ///
    /// A Flow using all five supported Node types must emit pin setup and
    /// read/write logic for each, inside a structurally valid sketch.
    #[test]
    fn core_hardware_io_flow_emits_setup_and_io_for_each_node() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("led-1", "Led", json!({ "pin": 13 })),
                node_data("btn-1", "Button", json!({ "pin": 6 })),
                node_data("sensor-1", "Sensor", json!({ "pin": "A0" })),
                node_data("servo-1", "Servo", json!({ "pin": 9 })),
                node_data("relay-1", "Relay", json!({ "pin": 10 })),
            ],
            edges: vec![edge("btn-1", "led-1"), edge("sensor-1", "servo-1")],
        };

        let sketch = generate_sketch_text(&flow);

        // Structurally valid sketch.
        assert!(sketch.contains("void setup()"));
        assert!(sketch.contains("void loop()"));
        assert!(!sketch.contains("delay("), "must stay non-blocking");

        // Pin setup for each Node.
        assert!(sketch.contains("pinMode") && sketch.contains("OUTPUT"), "led/relay OUTPUT setup");
        assert!(sketch.contains("INPUT"), "button INPUT setup");
        // Read/write logic present.
        assert!(sketch.contains("digitalWrite"), "led/relay write");
        assert!(sketch.contains("digitalRead"), "button read");
        assert!(sketch.contains("analogRead"), "sensor read");
        assert!(sketch.contains(".attach("), "servo attach");
        assert!(sketch.contains("#include <Servo.h>"), "servo include");
    }

    /// Scenario: A Button drives a Led through an edge.
    #[test]
    fn button_drives_led_through_an_edge() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("led-1", "Led", json!({ "pin": 13 })),
                node_data("btn-1", "Button", json!({ "pin": 6 })),
            ],
            edges: vec![edge("btn-1", "led-1")],
        };

        let sketch = generate_sketch_text(&flow);

        // The Button reads its input into a state var.
        assert!(sketch.contains("button_btn_1_state = "), "button read into state var");
        assert!(sketch.contains("digitalRead"), "button digitalRead");
        // The Led writes that state.
        assert!(
            sketch.contains("digitalWrite(led_led_1_pin, (button_btn_1_state)"),
            "led must be driven by the button state, got:\n{sketch}"
        );
    }

    /// Scenario: A Servo Node pulls in its supporting library.
    #[test]
    fn servo_node_pulls_in_its_library() {
        let flow = FlowUpdate {
            nodes: vec![node_data("servo-1", "Servo", json!({ "pin": 9 }))],
            edges: vec![],
        };

        let sketch = generate_sketch_text(&flow);

        assert!(sketch.contains("#include <Servo.h>"), "missing Servo include");
        assert!(sketch.contains("Servo servo_servo_1"), "missing Servo object decl");
        assert!(sketch.contains(".attach(servo_servo_1_pin)"), "missing attach to pin");
    }

    /// The Servo include appears only when a Servo Node is present.
    #[test]
    fn no_servo_include_without_a_servo_node() {
        let flow = FlowUpdate {
            nodes: vec![node_data("led-1", "Led", json!({ "pin": 13 }))],
            edges: vec![],
        };
        let sketch = generate_sketch_text(&flow);
        assert!(!sketch.contains("Servo.h"), "no servo include without a servo node");
    }

    /// Scenario: Each supported Node type emits deterministic code — full Flow.
    #[test]
    fn full_flow_emits_deterministically() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("led-1", "Led", json!({ "pin": 13 })),
                node_data("btn-1", "Button", json!({ "pin": 6, "isPullup": true })),
                node_data("servo-1", "Servo", json!({ "pin": 9 })),
            ],
            edges: vec![edge("btn-1", "led-1")],
        };
        assert_eq!(generate_sketch_text(&flow), generate_sketch_text(&flow));
    }

    /// Scenario: An unsupported Node becomes a placeholder comment.
    ///
    /// A Cloud Node (Figma — still without an on-device emitter) alongside a
    /// core Led: the Cloud Node gets a clear placeholder comment, the Led still
    /// emits real code, and generation does not crash or blank the sketch.
    #[test]
    fn cloud_node_becomes_placeholder_while_core_node_still_emits() {
        let flow = FlowUpdate {
            nodes: vec![
                node("figma-1", "Figma"),
                node_data("led-1", "Led", json!({ "pin": 13 })),
            ],
            edges: vec![],
        };

        // Cloud Nodes only validate on a networking board (ESP32); on a bare
        // board they are surfaced as validation problems instead.
        let sketch = sketch_for(&flow, &networking_target());

        // Placeholder for the Cloud Node, identifying it and the networked need.
        assert!(
            sketch.contains("// unsupported Node figma_1 (Figma)"),
            "missing Figma placeholder, got:\n{sketch}"
        );
        assert!(sketch.contains("networked target"), "Cloud message missing");
        // The Led still produces real code.
        assert!(sketch.contains("pinMode"), "led pin setup missing");
        assert!(sketch.contains("digitalWrite"), "led write missing");
        // Sketch is not blanked.
        assert!(sketch.contains("void setup()") && sketch.contains("void loop()"));
    }

    /// Scenario: An unknown Node type does not break generation.
    #[test]
    fn unknown_node_type_does_not_break_generation() {
        let flow = FlowUpdate {
            nodes: vec![
                node("gizmo-1", "Gizmo"),
                node_data("led-1", "Led", json!({ "pin": 13 })),
            ],
            edges: vec![],
        };

        let sketch = generate_sketch_text(&flow);

        assert!(
            sketch.contains("// unsupported Node gizmo_1 (Gizmo)"),
            "missing unknown-type placeholder, got:\n{sketch}"
        );
        // The rest of the sketch is still produced.
        assert!(sketch.contains("digitalWrite"), "led code still produced");
        assert!(sketch.contains("void loop()"));
    }

    /// Scenario: A Flow of only unsupported Nodes still yields a valid sketch.
    ///
    /// Mqtt now has an on-device emitter (Task #38), so the remaining
    /// still-unsupported Cloud Nodes are Figma/Llm/Monitor.
    #[test]
    fn all_unsupported_flow_yields_valid_sketch() {
        let flow = FlowUpdate {
            nodes: vec![
                node("figma-1", "Figma"),
                node("llm-1", "Llm"),
                node("monitor-1", "Monitor"),
            ],
            edges: vec![],
        };

        // All Cloud Nodes — runnable only on a networking board (ESP32).
        let sketch = sketch_for(&flow, &networking_target());

        // A structurally valid sketch is still produced.
        assert!(sketch.contains("void setup()"), "missing setup section");
        assert!(sketch.contains("void loop()"), "missing loop section");
        // A placeholder for every unsupported Node.
        assert_eq!(
            sketch.matches("// unsupported Node ").count(),
            3,
            "expected one placeholder per unsupported node, got:\n{sketch}"
        );
    }

    /// Scenario: Placeholder comments are deterministic.
    #[test]
    fn placeholder_comments_are_deterministic_at_sketch_level() {
        let flow = FlowUpdate {
            nodes: vec![node("figma-1", "Figma"), node("gizmo-1", "Gizmo")],
            edges: vec![],
        };

        let esp32 = networking_target();
        let first = sketch_for(&flow, &esp32);
        let second = sketch_for(&flow, &esp32);

        assert_eq!(
            first, second,
            "repeated generation must yield identical placeholder comments"
        );
    }

    // --- Task #38: emit the Mqtt Node for a networked target ---

    /// Scenario: Mqtt Node emits working code on a WiFi-capable target.
    ///
    /// A Flow with an Mqtt Cloud Node generated for the ESP32 connects to the
    /// network and broker on boot and publishes/subscribes on its topic — not a
    /// placeholder.
    #[test]
    fn mqtt_node_emits_working_code_on_a_wifi_capable_target() {
        let flow = FlowUpdate {
            nodes: vec![node_data(
                "mqtt-1",
                "Mqtt",
                json!({ "broker": "broker.example.com", "port": 1883, "topic": "microflow/sensor", "direction": "subscribe", "wifiSsid": "net" }),
            )],
            edges: vec![],
        };

        let sketch = sketch_for(&flow, &networking_target());

        // Not a placeholder.
        assert!(!sketch.contains("// unsupported Node mqtt_1"), "Mqtt must emit real code, got:\n{sketch}");
        // WiFi + MQTT client libraries pulled in.
        assert!(sketch.contains("#include <WiFi.h>"), "missing WiFi include");
        assert!(sketch.contains("#include <PubSubClient.h>"), "missing MQTT client include");
        // Connects to network and broker on boot.
        assert!(sketch.contains("WiFi.mode(WIFI_STA)"), "boots WiFi in setup");
        assert!(sketch.contains("mqtt_mqtt_1_ensure_connected()"), "connects on boot + loop");
        assert!(sketch.contains("setServer(mqtt_mqtt_1_broker"), "points at the broker");
        // Subscribes on the configured topic.
        assert!(sketch.contains("subscribe(mqtt_mqtt_1_topic)"), "subscribes to its topic");
        // Maintains the connection in loop() without a host event loop.
        assert!(sketch.contains("mqtt_mqtt_1_client.loop()"), "pumps client in loop");
        // Stays non-blocking (no blocking delay).
        assert!(!sketch.contains("delay("), "stays non-blocking");
    }

    /// Scenario: a publish Mqtt Node publishes its wired input on its topic.
    #[test]
    fn mqtt_publish_node_publishes_its_wired_input() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("sensor-1", "Sensor", json!({ "pin": "A0" })),
                node_data(
                    "mqtt-1",
                    "Mqtt",
                    json!({ "broker": "b", "topic": "microflow/out", "direction": "publish", "wifiSsid": "net" }),
                ),
            ],
            edges: vec![edge("sensor-1", "mqtt-1")],
        };

        let sketch = sketch_for(&flow, &networking_target());

        assert!(sketch.contains("publish(mqtt_mqtt_1_topic"), "publishes on its topic");
        assert!(sketch.contains("sensor_sensor_1_value"), "publishes the wired sensor value");
    }

    /// Scenario: Generated Mqtt sketch reflects supplied credentials.
    #[test]
    fn generated_mqtt_sketch_reflects_supplied_credentials() {
        let flow = FlowUpdate {
            nodes: vec![node_data(
                "mqtt-1",
                "Mqtt",
                json!({
                    "broker": "broker.example.com",
                    "port": 8883,
                    "topic": "microflow/sensor",
                    "wifiSsid": "home-net",
                    "wifiPassword": "s3cret",
                    "brokerUsername": "user",
                    "brokerPassword": "pass",
                    "direction": "publish"
                }),
            )],
            edges: vec![],
        };

        let sketch = sketch_for(&flow, &networking_target());

        assert!(sketch.contains("\"home-net\""), "uses the supplied SSID");
        assert!(sketch.contains("\"s3cret\""), "uses the supplied WiFi password");
        assert!(sketch.contains("\"broker.example.com\""), "uses the supplied broker host");
        assert!(sketch.contains("8883"), "uses the supplied port");
        assert!(sketch.contains("\"user\", \"pass\""), "uses the broker auth credentials");
        assert!(!sketch.contains("REPLACE_ME"), "no placeholder when creds supplied");
    }

    /// Scenario: Missing credentials produce a safe placeholder + warning.
    #[test]
    fn missing_mqtt_credentials_produce_a_safe_placeholder() {
        let flow = FlowUpdate {
            // No wifiSsid and no broker host supplied.
            nodes: vec![node_data("mqtt-1", "Mqtt", json!({ "topic": "microflow/sensor", "direction": "publish" }))],
            edges: vec![],
        };

        let sketch = sketch_for(&flow, &networking_target());

        // A loud, compile-time warning rather than silent failure.
        assert!(sketch.contains("#warning"), "warns the Author");
        // A clearly-marked placeholder rather than an empty connection value.
        assert!(sketch.contains("REPLACE_ME"), "emits a credential placeholder");
        // It still emits connecting code (does not silently fail to connect).
        assert!(sketch.contains("WiFi.mode(WIFI_STA)"), "still attempts to connect");
    }

    /// Mqtt emission is deterministic at the sketch level.
    #[test]
    fn mqtt_sketch_is_deterministic() {
        let flow = FlowUpdate {
            nodes: vec![node_data(
                "mqtt-1",
                "Mqtt",
                json!({ "broker": "b", "topic": "t", "wifiSsid": "net", "direction": "publish" }),
            )],
            edges: vec![],
        };
        let esp32 = networking_target();
        assert_eq!(sketch_for(&flow, &esp32), sketch_for(&flow, &esp32));
    }

    // --- Task #43: wire the selected target into generation ---

    /// Scenario: Generated Sketch targets the selected board.
    ///
    /// The emitted Sketch names the selected board target and uses pin numbers
    /// from the Flow that the target supports.
    #[test]
    fn generated_sketch_reflects_the_selected_board_target() {
        let flow = FlowUpdate {
            nodes: vec![node_data("led-1", "Led", json!({ "pin": 13 }))],
            edges: vec![],
        };

        let esp32 = networking_target();
        let sketch = sketch_for(&flow, &esp32);

        // The Sketch is self-describing about the selected board.
        assert!(sketch.contains("Target board: ESP32 (esp32)"), "names the target, got:\n{sketch}");
        // Pin 13 (which the ESP32 has) is emitted.
        assert!(sketch.contains("= 13;"), "emits the selected pin");
    }

    /// Scenario: Switching target re-generates for the new board.
    ///
    /// The same Flow generated for two different targets yields two different
    /// Sketches, each naming its own board.
    #[test]
    fn switching_target_regenerates_for_the_new_board() {
        let flow = FlowUpdate {
            nodes: vec![node_data("led-1", "Led", json!({ "pin": 13 }))],
            edges: vec![],
        };

        let uno_sketch = sketch_for(&flow, &default_target());
        let esp32_sketch = sketch_for(&flow, &networking_target());

        assert!(uno_sketch.contains("Target board: Arduino Uno (uno)"));
        assert!(esp32_sketch.contains("Target board: ESP32 (esp32)"));
        assert_ne!(
            uno_sketch, esp32_sketch,
            "switching the target must re-generate a different Sketch"
        );
    }

    /// Scenario: Generation refuses an unrunnable Flow.
    ///
    /// A Flow that requires a capability the target lacks (an Mqtt Cloud Node on
    /// the non-networking Uno) emits no Sketch; the validation problem naming the
    /// Node and the constraint is surfaced instead.
    #[test]
    fn generation_refuses_an_unrunnable_flow() {
        let flow = FlowUpdate {
            nodes: vec![node("mqtt-1", "Mqtt")],
            edges: vec![],
        };

        let outcome =
            generate(&flow, &default_target()).expect("generation should not error");

        match outcome {
            GenerationOutcome::Sketch(s) => {
                panic!("expected validation problems, got a sketch:\n{s}")
            }
            GenerationOutcome::Problems(problems) => {
                assert_eq!(problems.len(), 1, "one problem for the Cloud Node");
                let p = &problems[0];
                assert_eq!(p.node_id, "mqtt-1", "names the offending Node");
                assert!(p.message.contains("mqtt-1"), "message names the Node");
                assert!(p.message.contains("networking"), "message names the constraint");
            }
        }
    }

    /// With no explicit selection the caller resolves the default target (Uno),
    /// so an existing core-IO Flow still produces a Sketch.
    #[test]
    fn default_target_still_produces_a_sketch() {
        let flow = FlowUpdate {
            nodes: vec![node_data("led-1", "Led", json!({ "pin": 13 }))],
            edges: vec![],
        };

        let outcome = generate(&flow, &default_target()).expect("generation should succeed");
        assert!(matches!(outcome, GenerationOutcome::Sketch(_)));
    }

    // --- Transformation Nodes (Task #33) ---

    /// Scenario: Calculate Node emits matching arithmetic.
    ///
    /// A Sensor drives a Calculate Node configured for `ceil`; the Sketch must
    /// compute the Node's value from the sensor reading using the same unary
    /// math the runtime applies, and feed it onward to a wired Led.
    #[test]
    fn calculate_node_emits_matching_arithmetic() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("sensor-1", "Sensor", json!({ "pin": "A0" })),
                node_data("calc-1", "Calculate", json!({ "function": "ceil" })),
                node_data("led-1", "Led", json!({ "pin": 13 })),
            ],
            edges: vec![edge("sensor-1", "calc-1"), edge("calc-1", "led-1")],
        };

        let sketch = generate_sketch_text(&flow);

        assert!(sketch.contains("double calculate_calc_1_value"), "calc output decl");
        assert!(
            sketch.contains("calculate_calc_1_value = ceil("),
            "calc must apply ceil to its input, got:\n{sketch}"
        );
        assert!(sketch.contains("sensor_sensor_1_value"), "calc reads the sensor");
        // The Led is driven by the Calculate result, not a placeholder.
        assert!(sketch.contains("digitalWrite(led_led_1_pin, (calculate_calc_1_value)"));
        assert!(!sketch.contains("// unsupported Node calc"), "calc must not be a placeholder");
        assert!(!sketch.contains("delay("), "stays non-blocking");
    }

    /// Scenario: Compare Node emits matching comparison.
    #[test]
    fn compare_node_emits_matching_comparison() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("sensor-1", "Sensor", json!({ "pin": "A0" })),
                node_data(
                    "cmp-1",
                    "Compare",
                    json!({ "validator": "number", "subValidator": "greater than", "number": 512.0 }),
                ),
            ],
            edges: vec![edge("sensor-1", "cmp-1")],
        };

        let sketch = generate_sketch_text(&flow);

        assert!(sketch.contains("bool compare_cmp_1_result"), "compare bool decl");
        assert!(
            sketch.contains("> 512.0"),
            "compare must emit the greater-than test, got:\n{sketch}"
        );
        assert!(!sketch.contains("// unsupported Node cmp"));
    }

    /// Scenario: Gate Node emits matching pass-through logic.
    #[test]
    fn gate_node_emits_matching_pass_through_logic() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("btn-1", "Button", json!({ "pin": 6 })),
                node_data("gate-1", "Gate", json!({ "gate": "nand" })),
                node_data("led-1", "Led", json!({ "pin": 13 })),
            ],
            edges: vec![edge("btn-1", "gate-1"), edge("gate-1", "led-1")],
        };

        let sketch = generate_sketch_text(&flow);

        assert!(sketch.contains("bool gate_gate_1_result"), "gate bool decl");
        // nand on a single input inverts it.
        assert!(
            sketch.contains("gate_gate_1_result = (!((bool)(button_btn_1_state)))"),
            "nand gate must invert the button, got:\n{sketch}"
        );
        // The Led reads the gate result.
        assert!(sketch.contains("digitalWrite(led_led_1_pin, (gate_gate_1_result)"));
    }

    /// Scenario: `RangeMap` and Smooth Nodes preserve their live behavior.
    #[test]
    fn range_map_and_smooth_preserve_live_behavior() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("sensor-1", "Sensor", json!({ "pin": "A0" })),
                node_data(
                    "rm-1",
                    "RangeMap",
                    json!({ "from": { "min": 0.0, "max": 1023.0 }, "to": { "min": 0.0, "max": 255.0 } }),
                ),
                node_data(
                    "sm-1",
                    "Smooth",
                    json!({ "type": "movingAverage", "windowSize": 4 }),
                ),
            ],
            edges: vec![edge("sensor-1", "rm-1"), edge("rm-1", "sm-1")],
        };

        let sketch = generate_sketch_text(&flow);

        // RangeMap linear remap math with the configured bounds.
        assert!(sketch.contains("double range_map_rm_1_value"), "range map decl");
        assert!(sketch.contains("1023.0") && sketch.contains("255.0"), "range bounds present");
        assert!(sketch.contains("round("), "range map rounds like the runtime");
        // Smooth keeps a persistent rolling window (state survives loop iterations).
        assert!(sketch.contains("double smooth_sm_1_window[4]"), "moving-average ring buffer");
        assert!(sketch.contains("smooth_sm_1_value"), "smooth output decl");
        assert!(!sketch.contains("delay("), "stays non-blocking despite state");
    }

    /// Scenario: No transformation Node is left as a placeholder.
    #[test]
    fn no_transformation_node_left_as_placeholder() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("calc-1", "Calculate", json!({ "function": "add" })),
                node_data("cmp-1", "Compare", json!({ "validator": "boolean" })),
                node_data("gate-1", "Gate", json!({ "gate": "and" })),
                node_data("rm-1", "RangeMap", json!({})),
                node_data("sm-1", "Smooth", json!({})),
            ],
            edges: vec![],
        };

        let sketch = generate_sketch_text(&flow);

        // Every transformation Node declares real state; none is a placeholder.
        assert!(sketch.contains("calculate_calc_1_value"));
        assert!(sketch.contains("compare_cmp_1_result"));
        assert!(sketch.contains("gate_gate_1_result"));
        assert!(sketch.contains("range_map_rm_1_value"));
        assert!(sketch.contains("smooth_sm_1_value"));
        assert_eq!(
            sketch.matches("// unsupported Node ").count(),
            0,
            "no transformation Node may be a placeholder, got:\n{sketch}"
        );
    }

    /// Determinism holds for a transformation-heavy Flow.
    #[test]
    fn transformation_flow_is_deterministic() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("sensor-1", "Sensor", json!({ "pin": "A0" })),
                node_data("rm-1", "RangeMap", json!({ "to": { "min": 0.0, "max": 5.0 } })),
                node_data("sm-1", "Smooth", json!({ "type": "smooth", "attenuation": 0.8 })),
                node_data("led-1", "Led", json!({ "pin": 13 })),
            ],
            edges: vec![edge("sensor-1", "rm-1"), edge("rm-1", "sm-1"), edge("sm-1", "led-1")],
        };
        assert_eq!(generate(&flow, &default_target()).unwrap(), generate(&flow, &default_target()).unwrap());
    }

    // --- Function Node translated to C++ (Task #36) ---

    /// Scenario: Supported Function logic is translated.
    ///
    /// A Sensor drives a Function Node whose JS uses only the supported
    /// expression subset; the Sketch must translate it to C++ that reads the
    /// sensor value and feeds the wired Led — not a placeholder.
    #[test]
    fn supported_function_logic_is_translated() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("sensor-1", "Sensor", json!({ "pin": "A0" })),
                node_data(
                    "fn-1",
                    "Function",
                    json!({ "code": "const v = input * 2;\nreturn v + 1;" }),
                ),
                node_data("led-1", "Led", json!({ "pin": 13 })),
            ],
            edges: vec![edge("sensor-1", "fn-1"), edge("fn-1", "led-1")],
        };

        let sketch = generate_sketch_text(&flow);

        assert!(
            sketch.contains("double function_fn_1_value"),
            "function output decl, got:\n{sketch}"
        );
        assert!(
            sketch.contains("function_fn_1_value = "),
            "function assigns its translated expression, got:\n{sketch}"
        );
        assert!(
            sketch.contains("sensor_sensor_1_value"),
            "function reads the sensor input"
        );
        // The Led is driven by the Function result, not a placeholder.
        assert!(sketch.contains("digitalWrite(led_led_1_pin, (function_fn_1_value)"));
        assert!(
            !sketch.contains("unsupported Function Node fn_1"),
            "supported logic must not be marked unsupported, got:\n{sketch}"
        );
        assert!(!sketch.contains("delay("), "stays non-blocking");
    }

    /// Scenario: Unsupported Function logic is clearly marked.
    ///
    /// A Function Node using a construct outside the subset (a `for` loop) is
    /// clearly marked in the Sketch and contributes no broken or silently-wrong
    /// C++ assignment.
    #[test]
    fn unsupported_function_logic_is_clearly_marked() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("sensor-1", "Sensor", json!({ "pin": "A0" })),
                node_data(
                    "fn-1",
                    "Function",
                    json!({ "code": "let s = 0;\nfor (let i = 0; i < input; i++) { s += i; }\nreturn s;" }),
                ),
            ],
            edges: vec![edge("sensor-1", "fn-1")],
        };

        let sketch = generate_sketch_text(&flow);

        assert!(
            sketch.contains("unsupported Function Node fn_1"),
            "unsupported construct must be clearly marked, got:\n{sketch}"
        );
        // The output variable still exists at its safe default; no guessed C++.
        assert!(sketch.contains("double function_fn_1_value = 0.0;"));
        assert!(
            !sketch.contains("function_fn_1_value = (double)"),
            "no broken/silently-wrong assignment is emitted, got:\n{sketch}"
        );
        // Generation is not blanked.
        assert!(sketch.contains("void setup()") && sketch.contains("void loop()"));
    }

    /// Scenario: Function Node is no longer a placeholder.
    ///
    /// A Flow containing a Function Node emits translated logic (its own value
    /// variable), never the generic unsupported-Node placeholder reserved for
    /// Nodes with no emitter.
    #[test]
    fn function_node_is_no_longer_a_placeholder() {
        let flow = FlowUpdate {
            nodes: vec![node_data(
                "fn-1",
                "Function",
                json!({ "code": "return input;" }),
            )],
            edges: vec![],
        };

        let sketch = generate_sketch_text(&flow);

        assert!(sketch.contains("function_fn_1_value"), "emits real state");
        assert_eq!(
            sketch.matches("// unsupported Node ").count(),
            0,
            "Function must not fall through to the no-emitter placeholder, got:\n{sketch}"
        );
    }

    /// Determinism holds for a Function-bearing Flow.
    #[test]
    fn function_flow_is_deterministic() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("sensor-1", "Sensor", json!({ "pin": "A0" })),
                node_data(
                    "fn-1",
                    "Function",
                    json!({ "code": "return input > 500 ? 1 : 0;" }),
                ),
            ],
            edges: vec![edge("sensor-1", "fn-1")],
        };
        assert_eq!(generate(&flow, &default_target()).unwrap(), generate(&flow, &default_target()).unwrap());
    }

    // --- Control Nodes as non-blocking timers (Task #34) ---

    /// Scenario: Delay Node emits non-blocking timing.
    ///
    /// A Button arms a Delay that drives a Led. The Delay must be driven by the
    /// loop scheduler with no blocking wait, and the rest of the Flow (the Led
    /// write) keeps running while the Delay is pending.
    #[test]
    fn delay_node_emits_non_blocking_timing() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("btn-1", "Button", json!({ "pin": 6 })),
                node_data("delay-1", "Delay", json!({ "delay": 1000 })),
                node_data("led-1", "Led", json!({ "pin": 13 })),
            ],
            edges: vec![edge("btn-1", "delay-1"), edge("delay-1", "led-1")],
        };

        let sketch = generate_sketch_text(&flow);

        // Driven by the loop scheduler via an elapsed-millis comparison.
        assert!(
            sketch.contains("millis() - delay_delay_1_armed_at >= 1000UL"),
            "delay must fire on the loop scheduler, got:\n{sketch}"
        );
        // No blocking wait anywhere.
        assert!(!sketch.contains("delay("), "delay must be non-blocking");
        // The rest of the Flow keeps running: the Led is driven by the Delay output.
        assert!(
            sketch.contains("digitalWrite(led_led_1_pin, (delay_delay_1_value)"),
            "led must read the delayed value, got:\n{sketch}"
        );
        assert!(!sketch.contains("// unsupported Node delay"), "delay must not be a placeholder");
    }

    /// Scenario: Interval Node fires repeatedly without blocking.
    #[test]
    fn interval_node_fires_repeatedly_without_blocking() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("iv-1", "Interval", json!({ "interval": 500 })),
                node_data("led-1", "Led", json!({ "pin": 13 })),
            ],
            edges: vec![edge("iv-1", "led-1")],
        };

        let sketch = generate_sketch_text(&flow);

        // Fires on schedule via the loop scheduler's millis() clock.
        assert!(
            sketch.contains("millis() - interval_iv_1_previous >= 500UL"),
            "interval must fire on schedule, got:\n{sketch}"
        );
        // Without halting other Nodes — no blocking delay.
        assert!(!sketch.contains("delay("), "interval must not block other nodes");
        assert!(!sketch.contains("// unsupported Node iv"), "interval must not be a placeholder");
    }

    /// Scenario: Counter Node retains its count on-device.
    #[test]
    fn counter_node_retains_its_count_on_device() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("btn-1", "Button", json!({ "pin": 6 })),
                node_data("ct-1", "Counter", json!({})),
            ],
            edges: vec![edge("btn-1", "ct-1")],
        };

        let sketch = generate_sketch_text(&flow);

        // The count lives in a module-level declaration => persists across loop().
        assert!(
            sketch.contains("double counter_ct_1_count = 0.0;"),
            "counter must keep a persistent running count, got:\n{sketch}"
        );
        // It is updated (incremented) inside the scheduled loop body.
        assert!(sketch.contains("counter_ct_1_count += 1.0"), "counter must increment on signal");
        assert!(!sketch.contains("// unsupported Node ct"), "counter must not be a placeholder");
    }

    /// Scenario: Trigger and Constant Nodes match live behavior.
    #[test]
    fn trigger_and_constant_nodes_match_live_behavior() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("sensor-1", "Sensor", json!({ "pin": "A0" })),
                node_data("tg-1", "Trigger", json!({ "threshold": 5.0, "behaviour": "increasing" })),
                node_data("const-1", "Constant", json!({ "value": 42.0 })),
            ],
            edges: vec![edge("sensor-1", "tg-1")],
        };

        let sketch = generate_sketch_text(&flow);

        // Trigger reproduces its threshold/direction bang from the sensor reading.
        assert!(sketch.contains("bool trigger_tg_1_result"), "trigger bool output");
        assert!(sketch.contains(">= 5.0"), "trigger applies its threshold");
        assert!(sketch.contains("trigger_tg_1_diff > 0.0"), "trigger respects increasing direction");
        // Constant emits its fixed live value.
        assert!(
            sketch.contains("double constant_const_1_value = 42.0;"),
            "constant must emit its fixed value, got:\n{sketch}"
        );
        assert!(!sketch.contains("// unsupported Node tg"));
        assert!(!sketch.contains("// unsupported Node const"));
    }

    /// Scenario: Nested timing Nodes run concurrently without drift.
    ///
    /// An Interval drives a Delay. Both timers must run concurrently on the
    /// scheduler — each off its own `millis()` comparison — without drift or one
    /// blocking the other.
    #[test]
    fn nested_timing_nodes_run_concurrently_without_drift() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("iv-1", "Interval", json!({ "interval": 200 })),
                node_data("delay-1", "Delay", json!({ "delay": 1000 })),
            ],
            edges: vec![edge("iv-1", "delay-1")],
        };

        let sketch = generate_sketch_text(&flow);

        // Two independent millis-based timers, neither blocking.
        assert!(
            sketch.contains("millis() - interval_iv_1_previous >= 200UL"),
            "interval timer present, got:\n{sketch}"
        );
        assert!(
            sketch.contains("millis() - delay_delay_1_armed_at >= 1000UL"),
            "delay timer present, got:\n{sketch}"
        );
        assert!(!sketch.contains("delay("), "concurrent timers must not block");
        // The Delay is armed from the Interval's output (nested timing wired through).
        assert!(
            sketch.contains("(double)(interval_iv_1_value)") || sketch.contains("(interval_iv_1_value)"),
            "delay must be driven by the interval, got:\n{sketch}"
        );
    }

    /// No control Node is left as a placeholder.
    #[test]
    fn no_control_node_left_as_placeholder() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("delay-1", "Delay", json!({})),
                node_data("iv-1", "Interval", json!({})),
                node_data("tg-1", "Trigger", json!({})),
                node_data("ct-1", "Counter", json!({})),
                node_data("const-1", "Constant", json!({})),
            ],
            edges: vec![],
        };

        let sketch = generate_sketch_text(&flow);

        assert!(sketch.contains("delay_delay_1_value"));
        assert!(sketch.contains("interval_iv_1_value"));
        assert!(sketch.contains("trigger_tg_1_result"));
        assert!(sketch.contains("counter_ct_1_count"));
        assert!(sketch.contains("constant_const_1_value"));
        assert_eq!(
            sketch.matches("// unsupported Node ").count(),
            0,
            "no control Node may be a placeholder, got:\n{sketch}"
        );
        assert!(!sketch.contains("delay("), "control nodes stay non-blocking");
    }

    // --- Remaining input/output/generator Nodes (Task #37) ---

    /// Scenario: Remaining input Nodes feed values into the Flow.
    ///
    /// A Flow uses every remaining non-Cloud input Node (Switch, Motion,
    /// Proximity, Hotkey, `I2cDevice` plus the Sensor-backed aliases). Each must
    /// read its hardware into a state/value variable that downstream Nodes can
    /// consume, exactly as the live runtime forwards its reading.
    #[test]
    fn remaining_input_nodes_feed_values_into_the_flow() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("sw-1", "Switch", json!({ "pin": 2 })),
                node_data("mo-1", "Motion", json!({ "pin": 8 })),
                node_data("px-1", "Proximity", json!({ "pin": "A1" })),
                node_data("hk-1", "Hotkey", json!({ "accelerator": "a" })),
                node_data("i2c-1", "I2cDevice", json!({ "address": 64, "read_length": 2 })),
                node_data("pot-1", "Potentiometer", json!({ "pin": "A2" })),
                node_data("led-1", "Led", json!({ "pin": 13 })),
            ],
            // Switch drives the Led, so its read flows into the rest of the Flow.
            edges: vec![edge("sw-1", "led-1")],
        };

        let sketch = generate_sketch_text(&flow);

        // Each input reads hardware into its variable.
        assert!(sketch.contains("switch_sw_1_state = (digitalRead"), "switch reads");
        assert!(sketch.contains("motion_mo_1_state = (digitalRead"), "motion reads");
        assert!(sketch.contains("proximity_px_1_value = analogRead"), "proximity reads");
        assert!(sketch.contains("bool hotkey_hk_1_state"), "hotkey declares state");
        assert!(sketch.contains("i2c_i2c_1_value = "), "i2c reads");
        assert!(sketch.contains("sensor_pot_1_value = analogRead"), "potentiometer is a Sensor");
        // The Switch reading feeds the Led (value flows into the Flow).
        assert!(
            sketch.contains("digitalWrite(led_led_1_pin, (switch_sw_1_state)"),
            "switch value must drive the led, got:\n{sketch}"
        );
        assert!(!sketch.contains("delay("), "stays non-blocking");
    }

    /// Scenario: Remaining output Nodes drive their hardware.
    ///
    /// A Sensor drives each remaining non-Cloud output Node (Rgb, Piezo, Pixel,
    /// Matrix, Stepper, and the Led-backed Vibration). Each must emit real drive
    /// logic from the incoming value, pulling in any required library.
    #[test]
    fn remaining_output_nodes_drive_their_hardware() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("sensor-1", "Sensor", json!({ "pin": "A0" })),
                node_data("rgb-1", "Rgb", json!({})),
                node_data("pz-1", "Piezo", json!({})),
                node_data("px-1", "Pixel", json!({ "length": 8 })),
                node_data("mx-1", "Matrix", json!({})),
                node_data("st-1", "Stepper", json!({})),
                node_data("vb-1", "Vibration", json!({ "pin": 5 })),
            ],
            edges: vec![
                edge("sensor-1", "rgb-1"),
                edge("sensor-1", "pz-1"),
                edge("sensor-1", "px-1"),
                edge("sensor-1", "mx-1"),
                edge("sensor-1", "st-1"),
                edge("sensor-1", "vb-1"),
            ],
        };

        let sketch = generate_sketch_text(&flow);

        // Each output drives from the sensor value.
        assert!(sketch.contains("analogWrite(rgb_rgb_1_red_pin"), "rgb drives channels");
        assert!(sketch.contains("tone(piezo_pz_1_pin"), "piezo sounds");
        assert!(sketch.contains("pixel_px_1.setPixelColor"), "pixel fills");
        assert!(sketch.contains("matrix_mx_1.setRow"), "matrix lights");
        assert!(sketch.contains("stepper_st_1.moveTo"), "stepper targets value");
        assert!(sketch.contains("digitalWrite(led_vb_1_pin"), "vibration is an Led output");
        // Library-backed Nodes pull in their includes.
        assert!(sketch.contains("#include <Adafruit_NeoPixel.h>"), "pixel include");
        assert!(sketch.contains("#include <LedControl.h>"), "matrix include");
        assert!(sketch.contains("#include <AccelStepper.h>"), "stepper include");
        assert!(!sketch.contains("delay("), "stays non-blocking");
    }

    /// Scenario: The generator Node produces its signal non-blocking.
    #[test]
    fn generator_node_produces_signal_non_blocking() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("osc-1", "Oscillator", json!({ "waveform": "sinus", "period": 1000 })),
                node_data("servo-1", "Servo", json!({ "pin": 9 })),
            ],
            edges: vec![edge("osc-1", "servo-1")],
        };

        let sketch = generate_sketch_text(&flow);

        // The Oscillator samples its waveform off the loop scheduler's millis() clock.
        assert!(
            sketch.contains("millis() - oscillator_osc_1_start"),
            "oscillator must sample against the scheduler clock, got:\n{sketch}"
        );
        assert!(sketch.contains("oscillator_osc_1_value = "), "oscillator output");
        // No blocking wait anywhere.
        assert!(!sketch.contains("delay("), "oscillator must be non-blocking");
        // The signal flows onward to the wired Servo.
        assert!(
            sketch.contains("(oscillator_osc_1_value)"),
            "oscillator must drive the servo, got:\n{sketch}"
        );
        assert!(!sketch.contains("// unsupported Node osc"), "oscillator must not be a placeholder");
    }

    /// Scenario: No remaining non-Cloud Node is a placeholder. Mqtt now emits
    /// real on-device code (Task #38); the remaining Cloud Nodes (Figma/Llm/
    /// Monitor) still fall through to placeholders (Feature #27 territory).
    #[test]
    fn no_remaining_non_cloud_node_is_a_placeholder() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("sw-1", "Switch", json!({})),
                node_data("mo-1", "Motion", json!({})),
                node_data("px-in", "Proximity", json!({})),
                node_data("hk-1", "Hotkey", json!({})),
                node_data("i2c-1", "I2cDevice", json!({})),
                node_data("force-1", "Force", json!({})),
                node_data("hall-1", "HallEffect", json!({})),
                node_data("ldr-1", "Ldr", json!({})),
                node_data("pot-1", "Potentiometer", json!({})),
                node_data("tilt-1", "Tilt", json!({})),
                node_data("rgb-1", "Rgb", json!({})),
                node_data("pz-1", "Piezo", json!({})),
                node_data("px-out", "Pixel", json!({})),
                node_data("mx-1", "Matrix", json!({})),
                node_data("st-1", "Stepper", json!({})),
                node_data("vb-1", "Vibration", json!({})),
                node_data("osc-1", "Oscillator", json!({})),
                // Mqtt now emits real on-device code (Task #38).
                node_data("mqtt-1", "Mqtt", json!({ "broker": "b", "topic": "t", "wifiSsid": "net" })),
                // The remaining Cloud Nodes still fall through (Feature #27).
                node("figma-1", "Figma"),
                node("llm-1", "Llm"),
                node("monitor-1", "Monitor"),
            ],
            edges: vec![],
        };

        // Cloud Nodes only validate on a networking-capable board (ESP32);
        // on the Uno they would be refused before emission.
        let sketch = sketch_for(&flow, &networking_target());

        // Exactly the three still-unsupported Cloud Nodes are placeholders.
        assert_eq!(
            sketch.matches("// unsupported Node ").count(),
            3,
            "only the three remaining Cloud Nodes may be placeholders, got:\n{sketch}"
        );
        // Mqtt is no longer a placeholder; it emits a real MQTT client.
        assert!(!sketch.contains("// unsupported Node mqtt_1"), "Mqtt must emit real code");
        assert!(sketch.contains("PubSubClient mqtt_mqtt_1_client"), "Mqtt client declared");
        // Spot-check that representative remaining Nodes emit real artefacts.
        assert!(sketch.contains("switch_sw_1_state"));
        assert!(sketch.contains("oscillator_osc_1_value"));
        assert!(sketch.contains("Adafruit_NeoPixel"));
        assert!(!sketch.contains("delay("), "stays non-blocking");
    }

    /// Determinism holds for a Flow mixing the remaining Node types.
    #[test]
    fn remaining_nodes_flow_is_deterministic() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("osc-1", "Oscillator", json!({ "waveform": "square", "period": 500 })),
                node_data("sw-1", "Switch", json!({ "pin": 2 })),
                node_data("rgb-1", "Rgb", json!({})),
                node_data("st-1", "Stepper", json!({})),
            ],
            edges: vec![edge("osc-1", "rgb-1"), edge("sw-1", "st-1")],
        };
        assert_eq!(generate(&flow, &default_target()).unwrap(), generate(&flow, &default_target()).unwrap());
    }

    /// Determinism holds for a control-heavy Flow.
    #[test]
    fn control_flow_is_deterministic() {
        let flow = FlowUpdate {
            nodes: vec![
                node_data("iv-1", "Interval", json!({ "interval": 250 })),
                node_data("delay-1", "Delay", json!({ "delay": 500 })),
                node_data("ct-1", "Counter", json!({})),
                node_data("const-1", "Constant", json!({ "value": 3.0 })),
                node_data("tg-1", "Trigger", json!({ "threshold": 2.0 })),
            ],
            edges: vec![edge("iv-1", "delay-1"), edge("iv-1", "ct-1")],
        };
        assert_eq!(generate(&flow, &default_target()).unwrap(), generate(&flow, &default_target()).unwrap());
    }
}
