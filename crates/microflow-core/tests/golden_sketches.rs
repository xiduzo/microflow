//! Golden-sketch snapshot tests: generate full `.ino` sources for a corpus of
//! representative Flows and compare them byte-for-byte against the files in
//! `tests/golden/`. A behavioral change to any emitter shows up as a readable
//! diff on a whole sketch instead of slipping past substring assertions, and
//! the checked-in goldens double as the corpus CI compiles with `arduino-cli`
//! (see `.github/workflows/sketch-compile.yml`).
//!
//! To regenerate after an intentional output change:
//!
//! ```sh
//! UPDATE_GOLDEN=1 cargo test -p microflow-core --test golden_sketches
//! ```
//!
//! then review the golden diffs like any other code change.
//!
//! Each golden's filename is `<board id>_<scenario>.ino`; the prefix tells the
//! CI compile job which FQBN to build it with.

use microflow_core::codegen::board::target_by_id;
use microflow_core::codegen::credentials::Credentials;
use microflow_core::codegen::{generate_with_credentials, GenerationOutcome};
use microflow_core::flow::{FlowEdge, FlowNode, FlowUpdate, Position};
use serde_json::json;
use std::path::PathBuf;

fn node(id: &str, kind: &str, data: serde_json::Value) -> FlowNode {
    FlowNode {
        id: id.to_string(),
        node_type: Some(kind.to_string()),
        data,
        position: Position { x: 0.0, y: 0.0 },
    }
}

fn edge(source: &str, source_handle: &str, target: &str, target_handle: &str) -> FlowEdge {
    FlowEdge {
        id: None,
        source: source.to_string(),
        target: target.to_string(),
        source_handle: source_handle.to_string(),
        target_handle: target_handle.to_string(),
    }
}

/// One corpus entry: golden filename (its `<board>_` prefix names the target),
/// the Flow, optional credentials, and whether validation problems are part of
/// the expected outcome (warnings alongside the sketch — never errors).
struct Golden {
    name: &'static str,
    flow: FlowUpdate,
    credentials: Option<Credentials>,
    expect_problems: bool,
}

impl Golden {
    fn plain(name: &'static str, nodes: Vec<FlowNode>, edges: Vec<FlowEdge>) -> Self {
        Self {
            name,
            flow: FlowUpdate { nodes, edges },
            credentials: None,
            expect_problems: false,
        }
    }
}

// One flow-literal per golden; length is the corpus, not complexity.
#[allow(clippy::too_many_lines)]
fn corpus() -> Vec<Golden> {
    vec![
        // Digital output family: a Button driving a Led over all three port
        // shapes (pulse on/off plus PWM level).
        Golden::plain(
            "uno_button_led",
            vec![
                node("btn-1", "Button", json!({ "pin": 6, "isPullup": true })),
                node("led-1", "Led", json!({ "pin": 13 })),
                node("led-2", "Led", json!({ "pin": 5 })),
            ],
            vec![
                edge("btn-1", "true", "led-1", "true"),
                edge("btn-1", "false", "led-1", "false"),
                edge("btn-1", "value", "led-2", "value"),
            ],
        ),
        // Analog input to PWM output — the classic sensor/servo pairing.
        Golden::plain(
            "uno_sensor_servo",
            vec![
                node("sensor-1", "Sensor", json!({ "pin": "A0" })),
                node("servo-1", "Servo", json!({ "pin": 9 })),
            ],
            vec![edge("sensor-1", "value", "servo-1", "value")],
        ),
        // Same pairing on the ESP32 core, which swaps in the ESP32Servo
        // library and resolves analog macros against the board pin map.
        Golden::plain(
            "esp32_sensor_servo",
            vec![
                node("sensor-1", "Sensor", json!({ "pin": "A0" })),
                node("servo-1", "Servo", json!({ "pin": 13 })),
            ],
            vec![edge("sensor-1", "value", "servo-1", "value")],
        ),
        // Transformation chain: RangeMap's `to` handle feeding Smooth.
        Golden::plain(
            "uno_transform_chain",
            vec![
                node("sensor-1", "Sensor", json!({ "pin": "A1" })),
                node(
                    "map-1",
                    "RangeMap",
                    json!({ "from": { "min": 0.0, "max": 1023.0 }, "to": { "min": 0.0, "max": 255.0 } }),
                ),
                node("smooth-1", "Smooth", json!({ "attenuation": 0.5 })),
                node("led-1", "Led", json!({ "pin": 11 })),
            ],
            vec![
                edge("sensor-1", "value", "map-1", "value"),
                edge("map-1", "to", "smooth-1", "value"),
                edge("smooth-1", "value", "led-1", "value"),
            ],
        ),
        // Control family: Interval events counted, compared, switching a Relay.
        Golden::plain(
            "uno_control",
            vec![
                node("interval-1", "Interval", json!({ "interval": 500, "autoStart": true })),
                node("counter-1", "Counter", json!({})),
                node("compare-1", "Compare", json!({ "validator": "number", "number": 10.0 })),
                node("relay-1", "Relay", json!({ "pin": 7 })),
            ],
            vec![
                edge("interval-1", "event", "counter-1", "increment"),
                edge("counter-1", "value", "compare-1", "value"),
                edge("compare-1", "true", "relay-1", "true"),
                edge("compare-1", "false", "relay-1", "false"),
            ],
        ),
        // Generator into an addressable Pixel strip.
        Golden::plain(
            "uno_generator_pixel",
            vec![
                node("osc-1", "Oscillator", json!({ "waveform": "sinus", "period": 2000.0 })),
                node(
                    "pixel-1",
                    "Pixel",
                    json!({
                        "pin": 6,
                        "length": 8,
                        "presets": [["#ff0000", "#00ff00"], ["#0000ff", "#ffffff"]],
                    }),
                ),
            ],
            vec![edge("osc-1", "value", "pixel-1", "value")],
        ),
        // The remaining output emitters together: Piezo, Stepper, Rgb, Matrix.
        Golden::plain(
            "uno_outputs",
            vec![
                node("btn-1", "Button", json!({ "pin": 12 })),
                node("osc-1", "Oscillator", json!({ "waveform": "sawtooth", "period": 1000.0 })),
                node("piezo-1", "Piezo", json!({ "pin": 8 })),
                node("stepper-1", "Stepper", json!({ "stepPin": 2, "dirPin": 3 })),
                // Blue on 6, not 11: the Piezo's tone() claims Timer2 on AVR,
                // and PWM on pin 11 next to it now (correctly) warns.
                node("rgb-1", "Rgb", json!({ "pins": { "red": 9, "green": 10, "blue": 6 } })),
                node("matrix-1", "Matrix", json!({ "pins": { "data": 4, "clock": 5, "cs": 7 } })),
            ],
            vec![
                edge("btn-1", "true", "piezo-1", "trigger"),
                edge("osc-1", "value", "stepper-1", "value"),
                edge("osc-1", "value", "rgb-1", "alpha"),
                edge("osc-1", "value", "matrix-1", "value"),
            ],
        ),
        // Two Midi Nodes sharing one MIDI instance and read-pump. Midi always
        // warns (it claims the board's primary hardware serial), so warnings
        // are part of this golden's expected outcome.
        Golden {
            name: "uno_midi",
            flow: FlowUpdate {
                nodes: vec![
                    node("midi-in", "Midi", json!({ "direction": "in", "mode": "cc", "control": 1 })),
                    node("midi-out", "Midi", json!({ "direction": "out", "mode": "note", "note": 60 })),
                ],
                edges: vec![edge("midi-in", "value", "midi-out", "send")],
            },
            credentials: None,
            expect_problems: true,
        },
        // I2C device streaming into a Led, with a Button-triggered read.
        Golden::plain(
            "uno_i2c",
            vec![
                node("btn-1", "Button", json!({ "pin": 3 })),
                // autoread off so the Button-wired `trigger` port gates the
                // read (with autoread on, the emitter reads every tick and the
                // trigger edge would be redundant).
                node("i2c-1", "I2cDevice", json!({ "address": 64, "readLength": 2, "autoread": false })),
                node("led-1", "Led", json!({ "pin": 11 })),
            ],
            vec![
                edge("btn-1", "true", "i2c-1", "trigger"),
                edge("i2c-1", "value", "led-1", "value"),
            ],
        ),
        // SHT21 (no-hold SHT2x) streaming: exercises the two-phase
        // request→collect settle state machine (autoread defaults on, 100 ms
        // cadence) that unit tests cover but no other golden compiles.
        Golden::plain(
            "uno_sht21",
            vec![
                node(
                    "sht-1",
                    "I2cDevice",
                    json!({ "device": "sht21_temp", "address": 64, "register": 243, "readLength": 2 }),
                ),
                node(
                    "map-1",
                    "RangeMap",
                    json!({ "from": { "min": 0.0, "max": 65535.0 }, "to": { "min": 0.0, "max": 255.0 } }),
                ),
                node("led-1", "Led", json!({ "pin": 9 })),
            ],
            vec![
                edge("sht-1", "value", "map-1", "value"),
                edge("map-1", "to", "led-1", "value"),
            ],
        ),
        // Every Cloud Node on the ESP32 with embedded (fake) credentials. The
        // Llm response is a String wired into a pulse port — the text-change
        // detector path.
        Golden {
            name: "esp32_cloud",
            flow: FlowUpdate {
                nodes: vec![
                    // Mqtt/Llm carry broker/endpoint credentials in their node
                    // data (the documented shape); Figma/Monitor are left
                    // credential-less to snapshot the REPLACE_ME + #warning
                    // fallback path alongside.
                    node(
                        "mqtt-sub",
                        "Mqtt",
                        json!({
                            "direction": "subscribe",
                            "topic": "microflow/in",
                            "broker": "broker.example.invalid",
                            "port": 1883,
                            "wifiSsid": "golden-net",
                        }),
                    ),
                    node(
                        "mqtt-pub",
                        "Mqtt",
                        json!({
                            "direction": "publish",
                            "topic": "microflow/out",
                            "broker": "broker.example.invalid",
                            "port": 1883,
                            "wifiSsid": "golden-net",
                        }),
                    ),
                    node("figma-1", "Figma", json!({ "variableId": "VariableID:1:2" })),
                    node(
                        "llm-1",
                        "Llm",
                        json!({
                            "model": "test-model",
                            "prompt": "Say hi",
                            "system": "Be brief",
                            "endpoint": "https://llm.example.invalid",
                            "llmApiKey": "sk-golden-fake", // ggignore — fake test credential
                            "wifiSsid": "golden-net",
                        }),
                    ),
                    node("monitor-1", "Monitor", json!({})),
                ],
                edges: vec![
                    edge("mqtt-sub", "value", "monitor-1", "value"),
                    edge("figma-1", "value", "llm-1", "trigger"),
                    edge("llm-1", "value", "mqtt-pub", "trigger"),
                ],
            },
            // Surface values are deliberately distinct from the node-data ones
            // above so the golden proves the surface wins (broker/endpoint in
            // the sketch read `-surface`).
            credentials: Some(Credentials {
                wifi_ssid: "golden-net".to_string(),
                wifi_password: "golden-pass".to_string(), // ggignore — fake test credential
                broker_host: "broker-surface.example.invalid".to_string(),
                broker_port: 1883,
                llm_endpoint: "https://llm-surface.example.invalid".to_string(),
                llm_api_key: "sk-golden-fake".to_string(), // ggignore — fake test credential
                ..Credentials::default()
            }),
            expect_problems: false,
        },
        // Kitchen sink on the Uno: warnings (Cloud Node without networking,
        // unknown Node placeholder) ride alongside a still-emitted sketch.
        Golden {
            name: "uno_kitchen_sink",
            flow: FlowUpdate {
                nodes: vec![
                    node("btn-1", "Button", json!({ "pin": 4 })),
                    node("led-1", "Led", json!({ "pin": 13 })),
                    node("mqtt-1", "Mqtt", json!({ "direction": "publish", "topic": "t" })),
                    node("gizmo-1", "Gizmo", json!({})),
                ],
                edges: vec![
                    edge("btn-1", "toggle", "led-1", "toggle"),
                    edge("btn-1", "true", "mqtt-1", "trigger"),
                ],
            },
            credentials: None,
            expect_problems: true,
        },
    ]
}

/// The board id is the golden filename's prefix (`uno_...` → `uno`).
fn board_id(name: &str) -> &str {
    name.split('_').next().expect("golden names are non-empty")
}

fn golden_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(format!("{name}.ino"))
}

fn generate_golden(golden: &Golden) -> GenerationOutcome {
    let target = target_by_id(board_id(golden.name))
        .unwrap_or_else(|| panic!("unknown board prefix in golden '{}'", golden.name));
    generate_with_credentials(&golden.flow, &target, golden.credentials.as_ref())
        .expect("generation never errors")
}

#[test]
fn golden_sketches_match() {
    let update = std::env::var("UPDATE_GOLDEN").is_ok_and(|v| v == "1");
    let mut mismatches = Vec::new();

    for golden in corpus() {
        let outcome = generate_golden(&golden);
        let sketch = outcome.sketch.unwrap_or_else(|| {
            panic!("golden '{}' emitted no sketch: {:?}", golden.name, outcome.problems)
        });
        if golden.expect_problems {
            assert!(
                !outcome.problems.is_empty(),
                "golden '{}' expects warnings alongside its sketch",
                golden.name
            );
        } else {
            assert!(
                outcome.problems.is_empty(),
                "golden '{}' expects a clean fit, got: {:?}",
                golden.name,
                outcome.problems
            );
        }

        let path = golden_path(golden.name);
        if update {
            std::fs::create_dir_all(path.parent().expect("golden dir")).expect("create dir");
            std::fs::write(&path, &sketch).expect("write golden");
            continue;
        }
        let expected = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "missing golden {} ({e}); run UPDATE_GOLDEN=1 cargo test -p microflow-core --test golden_sketches",
                path.display()
            )
        });
        if sketch != expected {
            mismatches.push(golden.name);
            eprintln!(
                "--- golden mismatch: {} ---\nexpected ({}):\n{expected}\ngot:\n{sketch}",
                golden.name,
                path.display()
            );
        }
    }

    assert!(
        mismatches.is_empty(),
        "golden sketches changed: {mismatches:?} — if intentional, regenerate with UPDATE_GOLDEN=1 and review the diff"
    );
}

/// Every checked-in golden belongs to the corpus — a renamed or removed corpus
/// entry must not leave a stale `.ino` behind for CI to compile.
#[test]
fn no_stale_golden_files() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let known: Vec<String> = corpus().iter().map(|g| format!("{}.ino", g.name)).collect();
    for entry in std::fs::read_dir(&dir).expect("golden dir exists") {
        let name = entry.expect("dir entry").file_name();
        let name = name.to_string_lossy();
        assert!(
            known.iter().any(|k| k == name.as_ref()),
            "stale golden file '{name}' has no corpus entry"
        );
    }
}
