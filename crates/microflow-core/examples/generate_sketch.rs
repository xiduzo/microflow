//! Generate a representative Arduino sketch to stdout — a quick way to
//! eyeball (or compile-check) the Sketch Generation output end-to-end:
//!
//! ```sh
//! cargo run -p microflow-core --example generate_sketch > /tmp/sketch/sketch.ino
//! ```

use microflow_core::codegen::{board, generate};
use microflow_core::flow::FlowUpdate;

fn main() {
    let flow: FlowUpdate = serde_json::from_str(
        r#"{
        "nodes": [
            {"id": "button-1", "type": "Button", "data": {"pin": 6}, "position": {"x": 0, "y": 0}},
            {"id": "sensor-1", "type": "Sensor", "data": {"pin": "A0"}, "position": {"x": 0, "y": 0}},
            {"id": "smooth-1", "type": "Smooth", "data": {"type": "movingAverage", "windowSize": 8}, "position": {"x": 0, "y": 0}},
            {"id": "map-1", "type": "RangeMap", "data": {"from": {"min": 0, "max": 1023}, "to": {"min": 0, "max": 255}}, "position": {"x": 0, "y": 0}},
            {"id": "led-1", "type": "Led", "data": {"pin": 9}, "position": {"x": 0, "y": 0}},
            {"id": "led-2", "type": "Led", "data": {"pin": 13}, "position": {"x": 0, "y": 0}},
            {"id": "counter-1", "type": "Counter", "data": {}, "position": {"x": 0, "y": 0}},
            {"id": "compare-1", "type": "Compare", "data": {"validator": "number", "subValidator": "greater than", "number": 3}, "position": {"x": 0, "y": 0}},
            {"id": "servo-1", "type": "Servo", "data": {"pin": 10, "range": {"min": 0, "max": 180}}, "position": {"x": 0, "y": 0}},
            {"id": "calc-1", "type": "Calculate", "data": {"function": "add"}, "position": {"x": 0, "y": 0}},
            {"id": "const-1", "type": "Constant", "data": {"value": 100}, "position": {"x": 0, "y": 0}}
        ],
        "edges": [
            {"source": "sensor-1", "sourceHandle": "value", "target": "smooth-1", "targetHandle": "value"},
            {"source": "smooth-1", "sourceHandle": "value", "target": "map-1", "targetHandle": "value"},
            {"source": "map-1", "sourceHandle": "to", "target": "led-1", "targetHandle": "value"},
            {"source": "button-1", "sourceHandle": "true", "target": "led-2", "targetHandle": "toggle"},
            {"source": "button-1", "sourceHandle": "true", "target": "counter-1", "targetHandle": "increment"},
            {"source": "counter-1", "sourceHandle": "value", "target": "compare-1", "targetHandle": "value"},
            {"source": "compare-1", "sourceHandle": "true", "target": "counter-1", "targetHandle": "reset"},
            {"source": "map-1", "sourceHandle": "to", "target": "calc-1", "targetHandle": "value"},
            {"source": "const-1", "sourceHandle": "value", "target": "calc-1", "targetHandle": "value"},
            {"source": "calc-1", "sourceHandle": "value", "target": "servo-1", "targetHandle": "value"}
        ]
    }"#,
    )
    .expect("flow json parses");

    let target = board::target_by_id("uno").expect("uno target");
    let outcome = generate(&flow, &target).expect("generation never errors");
    for p in &outcome.problems {
        eprintln!("  - {}", p.message);
    }
    if let Some(sketch) = outcome.sketch {
        print!("{sketch}");
    } else {
        eprintln!("flow cannot be emitted for {}:", target.name);
        std::process::exit(1);
    }
}
