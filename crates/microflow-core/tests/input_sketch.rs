//! What an input Node hands on when its Sketch runs — and that it is what the
//! live Node emits for the same pin levels.
//!
//! Each scenario generates the Sketch of a flow in which one input Node (`in`)
//! reads a pin and one of its Emits is wired into two Counters — one counting
//! its emissions (`increment`), one keeping the last value (`set`) — compiles
//! it for the host against a stand-in for the Arduino core (a clock, and pin
//! levels the test scripts), steps `loop()` once per millisecond, and records
//! every loop iteration on which the counting Counter moved, with the value
//! that arrived.
//!
//! With the `runtime` feature the same pin levels reach the live Node the way
//! a board running `StandardFirmata` reports them — a digital port report or
//! an analog report each time a level changes — on a runtime seeded with an
//! Uno's pins, and the live Node's emissions on that handle must come at the
//! same milliseconds with the same values.
//!
//! Needs a C++ compiler on the PATH as `c++`; without one the scenarios are
//! skipped with a note.

use microflow_core::codegen::board::target_by_id;
use microflow_core::codegen::generate;
use microflow_core::flow::{FlowEdge, FlowNode, FlowUpdate, Position};
use serde_json::json;
use std::path::PathBuf;
use std::process::Command;

/// Where the device clock stands when a scenario starts.
const BOOT_MS: u32 = 1000;

/// The Arduino core, as far as these Sketches need it, and a `main` that plays
/// `<boot ms> <until ms> [<at ms> <pin> <level>]...` and prints a line each
/// time the counting Counter moves.
const HOST: &str = r#"
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#define INPUT 0x0
#define OUTPUT 0x1
#define INPUT_PULLUP 0x2
#define HIGH 0x1
#define LOW 0x0
#define constrain(amt, low, high) ((amt) < (low) ? (low) : ((amt) > (high) ? (high) : (amt)))
static unsigned long host_millis = 0;
static int host_pins[64];
unsigned long millis() { return host_millis; }
int analogRead(uint8_t pin) { return host_pins[pin]; }
int digitalRead(uint8_t pin) { return host_pins[pin] ? HIGH : LOW; }
void pinMode(uint8_t, uint8_t) {}

#include "sketch.ino"

int main(int argc, char **argv) {
  const unsigned long boot = strtoul(argv[1], 0, 10);
  const unsigned long until = strtoul(argv[2], 0, 10);
  host_millis = boot;
  setup();
  double counted = 0.0;
  for (unsigned long t = 0; t <= until; t++) {
    host_millis = boot + t;
    for (int i = 3; i + 2 < argc; i += 3) {
      if (strtoul(argv[i], 0, 10) == t) { host_pins[atoi(argv[i + 1])] = atoi(argv[i + 2]); }
    }
    loop();
    if (counter_rec_n_count != counted) {
      counted = counter_rec_n_count;
      printf("%lu %.4f\n", t, counter_rec_v_count);
    }
  }
  return 0;
}
"#;

struct Scenario {
    name: &'static str,
    /// The input Node's type and settings (its id is `in`).
    kind: &'static str,
    data: serde_json::Value,
    /// The Emit wired into the recording Counters.
    handle: &'static str,
    /// `(at ms, pin, level)`: a pin's level (a raw analog reading, or 0/1)
    /// from then on. Every pin starts at 0.
    script: Vec<(u32, u8, i32)>,
    until: u32,
}

fn node(id: &str, kind: &str, data: serde_json::Value) -> FlowNode {
    FlowNode { id: id.to_string(), node_type: Some(kind.to_string()), data, position: Position { x: 0.0, y: 0.0 } }
}

fn edge(source: &str, source_handle: &str, target: &str, target_handle: &str) -> FlowEdge {
    FlowEdge {
        id: None,
        source: source.to_string(),
        source_handle: source_handle.to_string(),
        target: target.to_string(),
        target_handle: target_handle.to_string(),
    }
}

fn has_cxx() -> bool {
    Command::new("c++").arg("--version").output().is_ok_and(|out| out.status.success())
}

/// What the compiled Sketch records.
fn sketch_records(scenario: &Scenario) -> Vec<String> {
    let flow = FlowUpdate {
        nodes: vec![
            node("in", scenario.kind, scenario.data.clone()),
            node("rec-n", "Counter", json!({})),
            node("rec-v", "Counter", json!({})),
        ],
        edges: vec![edge("in", scenario.handle, "rec-n", "increment"), edge("in", scenario.handle, "rec-v", "set")],
    };
    let outcome = generate(&flow, &target_by_id("uno").expect("the Uno is supported")).expect("never errors");
    let sketch = outcome.sketch.unwrap_or_else(|| panic!("no sketch: {:?}", outcome.problems));

    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("input_sketch").join(scenario.name);
    std::fs::create_dir_all(&dir).expect("create the scenario directory");
    std::fs::write(dir.join("sketch.ino"), &sketch).expect("write the sketch");
    std::fs::write(dir.join("host.cpp"), HOST).expect("write the host");
    let program = dir.join("host");
    let compiled = Command::new("c++")
        .args(["-std=gnu++11", "-Wall", "-Wextra", "-Werror", "-Wno-unused-variable", "-Wno-unused-parameter"])
        .arg("-I")
        .arg(&dir)
        .arg("-o")
        .arg(&program)
        .args(["-x", "c++"])
        .arg(dir.join("host.cpp"))
        .output()
        .expect("run c++");
    assert!(
        compiled.status.success(),
        "{}: the generated sketch does not compile:\n{}\n{sketch}",
        scenario.name,
        String::from_utf8_lossy(&compiled.stderr)
    );

    let mut run = Command::new(&program);
    run.arg(BOOT_MS.to_string()).arg(scenario.until.to_string());
    for (at, pin, level) in &scenario.script {
        run.arg(at.to_string()).arg(pin.to_string()).arg(level.to_string());
    }
    let out = run.output().expect("run the compiled sketch");
    assert!(out.status.success(), "the compiled sketch failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).expect("utf-8 output").lines().map(str::to_string).collect()
}

/// An Uno's pins as a Runtime Host seeds them from the board's capability
/// and analog-mapping answers: PWM on 3, 5, 6, 9, 10 and 11, analog inputs
/// A0–A5 on 14–19.
#[cfg(feature = "runtime")]
fn uno_seed() -> String {
    let pins: Vec<serde_json::Value> = (0..20)
        .map(|pin| {
            let mut modes = vec![0, 1, 4, 11];
            if [3, 5, 6, 9, 10, 11].contains(&pin) {
                modes.push(3);
            }
            let channel = if pin >= 14 { pin - 14 } else { -1 };
            if channel >= 0 {
                modes.push(2);
            }
            json!({ "pin": pin, "supportedModes": modes, "analogChannel": channel })
        })
        .collect();
    serde_json::to_string(&pins).expect("a seed serializes")
}

/// What the live Node emits on the scenario's handle when a board reports the
/// same levels: every digital port and analog input once at the start (what
/// `StandardFirmata` answers when reporting is switched on), then each change.
/// Wakeups fire on the same millisecond clock, after that millisecond's
/// reports.
#[cfg(feature = "runtime")]
fn live_records(scenario: &Scenario) -> Vec<String> {
    use microflow_core::runtime::{Effects, FlowRuntime, Wakeup};

    fn apply(
        effects: Effects,
        now: u32,
        handle: &str,
        timers: &mut Vec<(u64, Wakeup)>,
        out: &mut Vec<(u32, serde_json::Value)>,
    ) {
        timers.retain(|(_, wakeup)| !effects.cancellations.contains(&wakeup.id));
        timers.extend(effects.wakeups.into_iter().map(|wakeup| (u64::from(now) + wakeup.delay_ms, wakeup)));
        for event in effects.component_events {
            if event.source.as_ref() == "in" && event.source_handle.as_ref() == handle {
                out.push((now, serde_json::to_value(&event.value).expect("a value serializes")));
            }
        }
    }

    /// The Firmata reports for `pins`: one per digital port (each input's
    /// level as a bit) and one per analog input.
    fn reports(pins: &[i32; 20], ports: &[usize], channels: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for &port in ports {
            let mask: usize =
                (0..8).filter(|bit| pins.get(port * 8 + bit).is_some_and(|&level| level != 0)).fold(0, |m, bit| m | (1 << bit));
            #[allow(clippy::cast_possible_truncation)]
            bytes.extend([0x90 | port as u8, (mask & 0x7F) as u8, (mask >> 7) as u8]);
        }
        for &channel in channels {
            let level = pins[usize::from(channel) + 14];
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            bytes.extend([0xE0 | channel, (level & 0x7F) as u8, ((level >> 7) & 0x7F) as u8]);
        }
        bytes
    }

    let mut runtime = FlowRuntime::new();
    runtime.seed_pins(&uno_seed()).expect("the seed reads");
    let mut timers = Vec::new();
    let mut emitted = Vec::new();
    let flow = FlowUpdate { nodes: vec![node("in", scenario.kind, scenario.data.clone())], edges: vec![] };
    runtime.set_now(0.0);
    apply(runtime.update_flow(flow), 0, scenario.handle, &mut timers, &mut emitted);
    let mut pins = [0_i32; 20];
    for now in 0..=scenario.until {
        runtime.set_now(f64::from(now));
        let mut ports = Vec::new();
        let mut channels = Vec::new();
        for &(_, pin, level) in scenario.script.iter().filter(|(at, _, _)| *at == now) {
            pins[usize::from(pin)] = level;
            if pin >= 14 {
                channels.push(pin - 14);
            } else {
                ports.push(usize::from(pin) / 8);
            }
        }
        if now == 0 {
            ports = vec![0, 1, 2];
            channels = (0..6).collect();
        }
        if !ports.is_empty() || !channels.is_empty() {
            let effects = runtime.feed_bytes(&reports(&pins, &ports, &channels));
            apply(effects, now, scenario.handle, &mut timers, &mut emitted);
        }
        while let Some(index) = timers.iter().position(|(due, _)| *due <= u64::from(now)) {
            let (_, wakeup) = timers.remove(index);
            apply(runtime.wake(&wakeup.node_id, &wakeup.method), now, scenario.handle, &mut timers, &mut emitted);
        }
    }
    emitted
        .iter()
        .map(|(at, value)| {
            let number = value.as_f64().or_else(|| value.as_bool().map(|on| if on { 1.0 } else { 0.0 }));
            format!("{at} {:.4}", number.expect("a number or a bool"))
        })
        .collect()
}

/// Run `scenario` through its generated Sketch — and, with the `runtime`
/// feature, through the live Node, which must agree. `None` without `c++`.
fn records(scenario: &Scenario) -> Option<Vec<String>> {
    if !has_cxx() {
        eprintln!("skipped {}: no `c++` on the PATH to compile the generated sketch with", scenario.name);
        return None;
    }
    let sketch = sketch_records(scenario);
    #[cfg(feature = "runtime")]
    assert_eq!(sketch, live_records(scenario), "{}: the sketch (left) and the live runtime (right) disagree", scenario.name);
    Some(sketch)
}

/// A Proximity hands on centimetres, converted for its controller, and only
/// a move of more than 1 cm. A0 reads 0 until the script says otherwise.
fn proximity(name: &'static str, controller: &str, readings: &[(u32, i32)]) -> Scenario {
    Scenario {
        name,
        kind: "Proximity",
        data: json!({ "pin": "A0", "controller": controller }),
        handle: "value",
        script: readings.iter().map(|&(at, raw)| (at, 14, raw)).collect(),
        until: 100,
    }
}

/// The Sharp GP2Y0A21YK: 10–80 cm, from the voltage. Nothing at A0 reads as
/// far away. 307 is ~1.5 V, ~25.8 cm; 310 is within a centimetre of it.
#[test]
fn a_gp2y0a21yk_hands_on_centimetres() {
    let scenario = proximity("gp2y0a21yk", "GP2Y0A21YK", &[(10, 307), (20, 310), (30, 400), (40, 1000), (50, 60)]);
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["0 80.0000", "10 25.8196", "30 18.1720", "40 10.0000", "50 80.0000"]);
}

/// The Sharp GP2Y0A02YK0F: 20–150 cm.
#[test]
fn a_gp2y0a02yk0f_hands_on_centimetres() {
    let scenario = proximity("gp2y0a02yk0f", "GP2Y0A02YK0F", &[(10, 307), (20, 600), (30, 603), (40, 80)]);
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["0 150.0000", "10 54.5939", "20 23.7183", "40 150.0000"]);
}

/// An HC-SR04's reading over 58, between 2 and 400 cm.
#[test]
fn an_hcsr04_hands_on_centimetres() {
    let scenario = proximity("hcsr04", "HCSR04", &[(10, 580), (20, 600), (30, 640), (40, 1023)]);
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["0 2.0000", "10 10.0000", "30 11.0345", "40 17.6379"]);
}

/// Any other controller: the reading scaled to 0–200 cm.
#[test]
fn another_controller_hands_on_the_reading_scaled_to_200_cm() {
    let scenario = proximity("linear", "GP2Y0A710K0F", &[(10, 1023), (20, 1020), (30, 511)]);
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["10 200.0000", "30 99.9022"]);
}

/// A Sensor hands on a reading only once it is `threshold` away from the
/// last one it handed on.
#[test]
fn a_sensor_hands_on_a_reading_past_its_threshold() {
    let scenario = Scenario {
        name: "sensor-threshold",
        kind: "Sensor",
        data: json!({ "pin": "A0", "threshold": 10 }),
        handle: "value",
        script: vec![(10, 14, 5), (20, 14, 12), (30, 14, 15), (40, 14, 30), (50, 14, 21), (60, 14, 19)],
        until: 100,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["20 12.0000", "40 30.0000", "60 19.0000"]);
}

/// A Button held for its `holdtime` says so once, on `hold`; a shorter press
/// says nothing, and nor does the rest of a long one.
#[test]
fn a_held_button_says_hold_once() {
    let scenario = Scenario {
        name: "button-hold",
        kind: "Button",
        data: json!({ "pin": 2, "holdtime": 300 }),
        handle: "hold",
        script: vec![(100, 2, 1), (300, 2, 0), (500, 2, 1), (1000, 2, 0), (1100, 2, 1), (1401, 2, 0)],
        until: 1600,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["800 1.0000", "1400 1.0000"]);
}

/// A Button settles contact bounce: an edge within 50 ms of the last one
/// waits for the line to hold quiet, and the Button takes the level the line
/// then holds. A bouncing press at 100 is one press; a blip at 310–320 that
/// ends where it began is nothing; a release 5 ms after the press at 500 is
/// taken 50 ms later.
#[test]
fn a_bouncing_button_settles() {
    let scenario = Scenario {
        name: "button-bounce",
        kind: "Button",
        data: json!({ "pin": 2 }),
        handle: "value",
        script: vec![
            (100, 2, 1), (103, 2, 0), (106, 2, 1), (109, 2, 0), (112, 2, 1),
            (300, 2, 0), (310, 2, 1), (320, 2, 0),
            (500, 2, 1), (505, 2, 0),
        ],
        until: 700,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["100 1.0000", "300 0.0000", "500 1.0000", "555 0.0000"]);
}

/// A Switch settles its contacts the way a Button does. Its line reads LOW
/// at the start, which a normally-open Switch reads as closed; the move at
/// 20 comes within 50 ms of that first reading, so it is taken at 70.
#[test]
fn a_bouncing_switch_settles_like_a_button() {
    let scenario = Scenario {
        name: "switch-bounce",
        kind: "Switch",
        data: json!({ "pin": 2, "type": "NO" }),
        handle: "value",
        script: vec![(20, 2, 1), (100, 2, 1), (103, 2, 0), (106, 2, 1), (300, 2, 0), (320, 2, 1), (330, 2, 0)],
        until: 500,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["0 1.0000", "70 0.0000", "103 1.0000", "156 0.0000", "300 1.0000"]);
}
