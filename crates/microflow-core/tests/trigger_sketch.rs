//! What a generated Trigger does when its Sketch runs — and that it is what the
//! live Trigger does.
//!
//! The emitter's unit tests pin the *shape* of the C++; this runs it. Each
//! scenario generates the Sketch of a `Sensor → Trigger` flow, compiles it for
//! the host against a stand-in for the Arduino core (a clock and an analog
//! level the test scripts), steps `loop()` once per millisecond, and records
//! every loop iteration on which the Trigger banged, with the value the bang
//! carries. A change of the sensor's reading is a value reaching the Trigger,
//! as it is on the device and live.
//!
//! With the `runtime` feature the same values go through the live Trigger
//! (`FlowRuntime`, its clock set to the same millisecond), and the two must
//! bang at the same times with the same values.
//!
//! Needs a C++ compiler on the PATH as `c++`; without one the scenarios are
//! skipped with a note (the Rust-only tests in `nodes/trigger/` still run).

use microflow_core::codegen::board::target_by_id;
use microflow_core::codegen::generate;
use microflow_core::flow::{FlowEdge, FlowNode, FlowUpdate, Position};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;

/// `(ms since the start, value)`: a reading arriving, or the Trigger banging.
type At = (u32, i32);

/// How many values a Trigger holds (`nodes::trigger::config::WINDOW_CAPACITY`).
const WINDOW_CAPACITY: u32 = 16;

/// Where the device clock stands when a scenario starts, unless it says
/// otherwise. Not 0: the generated scheduler runs its first tick once
/// `millis()` has moved.
const BOOT_MS: i64 = 1000;

/// The Arduino core, as far as a `Sensor → Trigger` Sketch needs it, and a
/// `main` that plays `<boot ms> <until ms> [<at ms> <level>]...`.
const HOST: &str = r#"
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#define INPUT 0x0
#define OUTPUT 0x1
#define HIGH 0x1
#define LOW 0x0
static unsigned long host_millis = 0;
static int host_level = 0;
unsigned long millis() { return host_millis; }
int analogRead(uint8_t) { return host_level; }
void pinMode(uint8_t, uint8_t) {}

#include "sketch.ino"

int main(int argc, char **argv) {
  // A negative boot time is that many ms before `millis()` rolls over.
  const unsigned long boot = (unsigned long)strtoll(argv[1], 0, 10);
  const unsigned long until = strtoul(argv[2], 0, 10);
  host_millis = boot;
  setup();
  for (unsigned long t = 0; t <= until; t++) {
    host_millis = boot + t;
    for (int i = 3; i + 1 < argc; i += 2) {
      if (strtoul(argv[i], 0, 10) == t) { host_level = atoi(argv[i + 1]); }
    }
    loop();
    if (trigger_trigger_result) { printf("%lu %ld\n", t, (long)trigger_trigger_value); }
  }
  return 0;
}
"#;

fn node(id: &str, kind: &str, data: serde_json::Value) -> FlowNode {
    FlowNode {
        id: id.to_string(),
        node_type: Some(kind.to_string()),
        data,
        position: Position { x: 0.0, y: 0.0 },
    }
}

fn has_cxx() -> bool {
    Command::new("c++").arg("--version").output().is_ok_and(|out| out.status.success())
}

/// Generate and compile the Sketch of a Sensor feeding a Trigger with `data`
/// into `name`'s own directory: the path of the program.
fn compile_sketch(name: &str, data: &serde_json::Value) -> PathBuf {
    let flow = FlowUpdate {
        nodes: vec![node("sensor", "Sensor", json!({ "pin": "A0" })), node("trigger", "Trigger", data.clone())],
        edges: vec![FlowEdge {
            id: None,
            source: "sensor".to_string(),
            source_handle: "value".to_string(),
            target: "trigger".to_string(),
            target_handle: "value".to_string(),
        }],
    };
    let target = target_by_id("uno").expect("the Uno is a supported board");
    let outcome = generate(&flow, &target).expect("generation never errors");
    let sketch = outcome.sketch.unwrap_or_else(|| panic!("no sketch: {:?}", outcome.problems));

    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("trigger_sketch").join(name);
    std::fs::create_dir_all(&dir).expect("create the scenario directory");
    std::fs::write(dir.join("sketch.ino"), sketch).expect("write the sketch");
    std::fs::write(dir.join("host.cpp"), HOST).expect("write the host");
    let program = dir.join("host");
    let compiled = Command::new("c++")
        .args(["-std=gnu++11", "-Wall", "-Wextra", "-Werror", "-Wno-unused-variable", "-Wno-unused-parameter"])
        .arg("-o")
        .arg(&program)
        // The sketch is C++ whatever its extension says.
        .args(["-x", "c++"])
        .arg(dir.join("host.cpp"))
        .output()
        .expect("run c++");
    assert!(
        compiled.status.success(),
        "the generated sketch does not compile:\n{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    program
}

/// When the compiled Trigger banged, and with what.
fn sketch_bangs(program: &Path, boot_ms: i64, readings: &[At], until_ms: u32) -> Vec<At> {
    let mut run = Command::new(program);
    run.arg(boot_ms.to_string()).arg(until_ms.to_string());
    for (at, level) in readings {
        run.arg(at.to_string()).arg(level.to_string());
    }
    let out = run.output().expect("run the compiled sketch");
    assert!(out.status.success(), "the compiled sketch failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout)
        .expect("utf-8 output")
        .lines()
        .map(|line| {
            let (at, value) = line.split_once(' ').expect("<at> <value>");
            (at.parse().expect("a time"), value.parse().expect("a value"))
        })
        .collect()
}

/// When the live Trigger banged, and with what: the same readings dispatched
/// to its `value` port with the runtime's clock on their millisecond.
#[cfg(feature = "runtime")]
fn live_bangs(data: &serde_json::Value, readings: &[At]) -> Vec<At> {
    use microflow_core::runtime::{ComponentValue, FlowRuntime};

    let mut runtime = FlowRuntime::new();
    runtime.update_flow(FlowUpdate { nodes: vec![node("trigger", "Trigger", data.clone())], edges: vec![] });
    let mut banged = Vec::new();
    for &(at, level) in readings {
        runtime.set_now(f64::from(at));
        let effects = runtime.dispatch("trigger", "value", ComponentValue::Number(f64::from(level)));
        for event in effects.component_events {
            if event.source.as_ref() == "trigger" && event.source_handle.as_ref() == "bang" {
                // The readings are whole numbers, so what bangs is one too.
                #[allow(clippy::cast_possible_truncation)]
                banged.push((at, event.value.as_number().expect("a number") as i32));
            }
        }
    }
    banged
}

/// Play `readings` through the generated Sketch of a Trigger with `data` —
/// and, with the `runtime` feature, through the live Trigger, which must
/// agree. Each reading must differ from the one before it (the Sensor sends
/// only changes), and the first from 0. `None` when there is no C++ compiler.
fn bangs(name: &str, data: &serde_json::Value, boot_ms: i64, readings: &[At], until_ms: u32) -> Option<Vec<At>> {
    assert!(
        readings.iter().scan(0, |last, &(_, level)| Some(std::mem::replace(last, level) != level)).all(|changed| changed),
        "{name}: a reading that does not change is no value for the Trigger"
    );
    if !has_cxx() {
        eprintln!("skipped {name}: no `c++` on the PATH to compile the generated sketch with");
        return None;
    }
    let sketch = sketch_bangs(&compile_sketch(name, data), boot_ms, readings, until_ms);
    #[cfg(feature = "runtime")]
    assert_eq!(sketch, live_bangs(data, readings), "{name}: the sketch (left) and the live runtime (right) disagree");
    Some(sketch)
}

/// The Trigger of the "Edge Trigger Alarm" template
/// (`apps/web/src/flows/templates`): one bang per sharp rise.
#[test]
fn the_edge_trigger_alarm_template_bangs_once_per_sharp_rise() {
    let data = json!({ "behaviour": "increasing", "threshold": 50 });
    let readings = [(10, 100), (110, 120), (210, 180), (310, 240), (1310, 200), (1410, 400)];
    let Some(banged) = bangs("template", &data, BOOT_MS, &readings, 2000) else { return };
    assert_eq!(banged, [(210, 180), (1410, 400)]);
}

/// A change counts from the oldest reading of the last `within` ms: one that
/// is `within` ms old still counts, one a millisecond older does not.
#[test]
fn only_a_change_within_the_window_bangs() {
    let data = json!({ "behaviour": "increasing", "threshold": 5, "within": 250 });
    let Some(quick) = bangs("within-quick", &data, BOOT_MS, &[(10, 10), (210, 13), (260, 15)], 1000) else {
        return;
    };
    assert_eq!(quick, [(260, 15)]);
    let Some(slow) = bangs("within-slow", &data, BOOT_MS, &[(10, 10), (210, 13), (261, 15)], 1000) else {
        return;
    };
    assert_eq!(slow, []);
}

#[test]
fn a_trigger_watches_for_a_decrease_unless_told_otherwise() {
    // 850: alone in its window, the 16 is no change; the 10 after it is.
    let readings = [(10, 20), (60, 18), (110, 14), (310, 30), (360, 40), (850, 16), (900, 10)];
    let Some(banged) = bangs("decreasing", &json!({ "threshold": 5 }), BOOT_MS, &readings, 1000) else { return };
    assert_eq!(banged, [(110, 14), (900, 10)]);
}

#[test]
fn a_percentage_trigger_compares_the_change_with_the_value_it_counts_from() {
    let data = json!({ "behaviour": "increasing", "threshold": 50, "relative": true });
    let readings = [(10, 100), (60, 140), (110, 150)];
    let Some(banged) = bangs("relative", &data, BOOT_MS, &readings, 1000) else { return };
    assert_eq!(banged, [(110, 150)]);
}

/// More readings in one window than the Trigger holds: the newest held one
/// gives way to each newcomer, so a change still counts from the oldest — and,
/// once that has gone, from the last reading of the burst.
#[test]
fn a_full_window_keeps_the_value_a_change_counts_from() {
    // One reading a millisecond, each 1 above the one before.
    let burst: Vec<At> = (10..).zip(1..).take(WINDOW_CAPACITY as usize * 4).collect();

    let data = json!({ "behaviour": "increasing", "threshold": 50, "within": 10_000 });
    let Some(rising) = bangs("full-rising", &data, BOOT_MS, &burst, 1000) else { return };
    assert_eq!(rising, [(60, 51)]);

    // A shorter burst, ending on 20 at 29. At 125 every reading of it held is
    // too old but that last one, and 14 is 6 below it.
    let mut readings: Vec<At> = burst[..WINDOW_CAPACITY as usize + 4].to_vec();
    readings.push((125, 14));
    let data = json!({ "threshold": 5, "within": 100 });
    let Some(falling) = bangs("full-falling", &data, BOOT_MS, &readings, 1000) else { return };
    assert_eq!(falling, [(125, 14)]);
}

/// `millis()` rolls over inside a window: the elapsed-time compare is
/// unsigned, so the window is what it would have been without it.
#[test]
fn the_window_is_timed_right_across_a_millis_rollover() {
    let data = json!({ "behaviour": "increasing", "threshold": 5, "within": 250 });
    // The clock rolls over 100 ms in.
    let Some(quick) = bangs("rollover-quick", &data, -100, &[(10, 10), (260, 15)], 1000) else { return };
    assert_eq!(quick, [(260, 15)]);
    let Some(slow) = bangs("rollover-slow", &data, -100, &[(10, 10), (261, 15)], 1000) else { return };
    assert_eq!(slow, []);
}
