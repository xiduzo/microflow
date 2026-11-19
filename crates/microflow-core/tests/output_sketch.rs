//! What an output Node hands on when its Sketch runs — and that it is what the
//! live Node emits.
//!
//! A Led, Relay, Piezo, Servo or Rgb emits on `value` what it last did (its
//! level, whether it is open, whether it sounds, where it moved, its colour).
//! Each scenario generates the Sketch of a flow in which Buttons and Sensors
//! drive one such output and the output's `value` is wired on into two
//! Counters — one counting its emissions (`increment`), one keeping the last
//! value (`set`) — compiles it for the host against a stand-in for the Arduino
//! core (a clock, and pin levels the test scripts), steps `loop()` once per
//! millisecond, and records every loop iteration on which the counting Counter
//! moved, with the value that arrived.
//!
//! With the `runtime` feature the same inputs go through the live Node — a
//! Sensor reading that changes is that number on the wired port, a Button
//! press is `true` on it — and the live Node's `value` emissions must come at
//! the same milliseconds with the same values. A Button settles contact
//! bounce over 50 ms on both sides (`tests/input_sketch.rs`), so the scripts
//! move a Button's line at least that long after its last move (and after the
//! start, its first reading): a clean press, which the Button passes on at
//! once.
//!
//! Needs a C++ compiler on the PATH as `c++`; without one the scenarios are
//! skipped with a note.

use microflow_core::codegen::board::target_by_id;
use microflow_core::codegen::generate;
use microflow_core::flow::{FlowEdge, FlowNode, FlowUpdate, Position};
use serde_json::json;
use std::path::PathBuf;
use std::process::Command;

/// Where the device clock stands when a scenario starts. Not 0: the generated
/// scheduler runs its first tick once `millis()` has moved.
const BOOT_MS: u32 = 1000;

/// The Arduino core, as far as these Sketches need it, and a `main` that plays
/// `<boot ms> <until ms> [<at ms> <pin> <level>]...` and prints `RECORD` each
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
void digitalWrite(uint8_t, uint8_t) {}
void analogWrite(uint8_t, int) {}
// A tone without a duration sounds until noTone(): no output Node asks for one.
void tone(uint8_t, unsigned int, unsigned long duration) { if (duration == 0) { printf("endless tone\n"); } }
void noTone(uint8_t) {}

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
      RECORD;
    }
  }
  return 0;
}
"#;

/// The Servo library, as far as a Sketch calls it.
const SERVO_H: &str = "#pragma once\nclass Servo { public: void attach(int) {} void write(int) {} };\n";

/// What drives the output in a scenario.
#[derive(Clone, Copy)]
enum Source {
    /// A Button on this pin, wired by its `true` handle: a press.
    Button(u8),
    /// A Sensor on this analog input (`A0` is pin 14 on the Uno): a reading.
    Sensor(&'static str, u8),
}

impl Source {
    fn id(self) -> String {
        match self {
            Self::Button(pin) => format!("button-{pin}"),
            Self::Sensor(_, pin) => format!("sensor-{pin}"),
        }
    }

    /// The pin the live side reads a script line for (the live run needs
    /// the `runtime` feature).
    #[cfg_attr(not(feature = "runtime"), allow(dead_code))]
    fn pin(self) -> u8 {
        match self {
            Self::Button(pin) | Self::Sensor(_, pin) => pin,
        }
    }
}

struct Scenario {
    name: &'static str,
    /// The output Node's type and settings (its id is `out`).
    kind: &'static str,
    data: serde_json::Value,
    /// The output's Emit wired into the recording Counters.
    handle: &'static str,
    /// Which source drives which of the output's Ports.
    wires: Vec<(Source, &'static str)>,
    /// `(at ms, pin, level)`: a pin's level from then on.
    script: Vec<(u32, u8, i32)>,
    until: u32,
    /// A C++ statement printing the line for one emission (`t` is the ms).
    record: &'static str,
    /// The same line for one live emission (its value as JSON).
    #[cfg_attr(not(feature = "runtime"), allow(dead_code))]
    live_line: fn(u32, &serde_json::Value) -> String,
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

/// The scenario's flow: its sources, the output, and the two recording
/// Counters on the output's `value`.
fn flow(scenario: &Scenario) -> FlowUpdate {
    let mut nodes = vec![
        node("out", scenario.kind, scenario.data.clone()),
        node("rec-n", "Counter", json!({})),
        node("rec-v", "Counter", json!({})),
    ];
    let mut edges =
        vec![edge("out", scenario.handle, "rec-n", "increment"), edge("out", scenario.handle, "rec-v", "set")];
    for (source, port) in &scenario.wires {
        if !nodes.iter().any(|n| n.id == source.id()) {
            nodes.push(match source {
                Source::Button(pin) => node(&source.id(), "Button", json!({ "pin": pin })),
                Source::Sensor(label, _) => node(&source.id(), "Sensor", json!({ "pin": label })),
            });
        }
        let handle = if matches!(source, Source::Button(_)) { "true" } else { "value" };
        edges.push(edge(&source.id(), handle, "out", port));
    }
    FlowUpdate { nodes, edges }
}

/// What the compiled Sketch records.
fn sketch_records(scenario: &Scenario) -> Vec<String> {
    let outcome = generate(&flow(scenario), &target_by_id("uno").expect("the Uno is supported")).expect("never errors");
    let sketch = outcome.sketch.unwrap_or_else(|| panic!("no sketch: {:?}", outcome.problems));

    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("output_sketch").join(scenario.name);
    std::fs::create_dir_all(&dir).expect("create the scenario directory");
    std::fs::write(dir.join("sketch.ino"), &sketch).expect("write the sketch");
    std::fs::write(dir.join("Servo.h"), SERVO_H).expect("write the Servo stand-in");
    std::fs::write(dir.join("host.cpp"), HOST.replace("RECORD", scenario.record)).expect("write the host");
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

/// What the live Node emits on the scenario's handle for the same inputs: a Sensor reading
/// that changes is that number on each Port it drives, a Button press `true`.
/// Wakeups fire on the same millisecond clock, after that millisecond's inputs.
#[cfg(feature = "runtime")]
fn live_records(scenario: &Scenario) -> Vec<String> {
    use microflow_core::runtime::{ComponentValue, Effects, FlowRuntime, Wakeup};

    fn apply(
        effects: Effects,
        now: u32,
        handle: &str,
        timers: &mut Vec<(u64, Wakeup)>,
        out: &mut Vec<(u32, ComponentValue)>,
    ) {
        timers.retain(|(_, wakeup)| !effects.cancellations.contains(&wakeup.id));
        timers.extend(effects.wakeups.into_iter().map(|wakeup| (u64::from(now) + wakeup.delay_ms, wakeup)));
        for event in effects.component_events {
            if event.source.as_ref() == "out" && event.source_handle.as_ref() == handle {
                out.push((now, event.value));
            }
        }
    }

    let mut runtime = FlowRuntime::new();
    runtime.seed_pins(&uno_seed()).expect("the seed reads");
    let mut timers = Vec::new();
    let mut emitted = Vec::new();
    let flow = FlowUpdate { nodes: vec![node("out", scenario.kind, scenario.data.clone())], edges: vec![] };
    apply(runtime.update_flow(flow), 0, scenario.handle, &mut timers, &mut emitted);
    let mut pins = [0_i32; 64];
    for now in 0..=scenario.until {
        runtime.set_now(f64::from(now));
        for &(_, pin, level) in scenario.script.iter().filter(|(at, _, _)| *at == now) {
            let was = std::mem::replace(&mut pins[usize::from(pin)], level);
            for (source, port) in scenario.wires.iter().filter(|(source, _)| source.pin() == pin) {
                let value = match source {
                    Source::Button(_) if was == 0 && level != 0 => ComponentValue::Bool(true),
                    Source::Sensor(..) if was != level => ComponentValue::Number(f64::from(level)),
                    _ => continue,
                };
                apply(runtime.dispatch("out", port, value), now, scenario.handle, &mut timers, &mut emitted);
            }
        }
        while let Some(index) = timers.iter().position(|(due, _)| *due <= u64::from(now)) {
            let (_, wakeup) = timers.remove(index);
            apply(runtime.wake(&wakeup.node_id, &wakeup.method), now, scenario.handle, &mut timers, &mut emitted);
        }
    }
    emitted
        .iter()
        .map(|(at, value)| (scenario.live_line)(*at, &serde_json::to_value(value).expect("a value serializes")))
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

/// The number that arrived, as both sides print it.
const NUMBER: &str = r#"printf("%lu %.4f\n", t, counter_rec_v_count)"#;

fn number_line(at: u32, value: &serde_json::Value) -> String {
    let number = value.as_f64().or_else(|| value.as_bool().map(|on| if on { 1.0 } else { 0.0 }));
    format!("{at} {:.4}", number.expect("a number or a bool"))
}

/// A Led's level: a brightness, then `true`, a new brightness and two
/// toggles. A `value` whose source has not moved does not undo `true`.
#[test]
fn a_led_hands_on_its_level() {
    let scenario = Scenario {
        name: "led",
        kind: "Led",
        handle: "value",
        data: json!({ "pin": 9 }),
        wires: vec![(Source::Sensor("A0", 14), "value"), (Source::Button(2), "true"), (Source::Button(3), "toggle")],
        script: vec![(100, 14, 100), (200, 2, 1), (250, 2, 0), (300, 14, 51), (400, 3, 1), (450, 3, 0), (600, 3, 1), (650, 3, 0)],
        until: 1000,
        record: NUMBER,
        live_line: number_line,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["100 0.3922", "200 1.0000", "300 0.2000", "400 0.0000", "600 1.0000"]);
}

/// A Relay's state: open, toggled closed, opened, closed — and a `false`
/// while closed emits nothing.
#[test]
fn a_relay_hands_on_whether_it_is_open() {
    let scenario = Scenario {
        name: "relay",
        kind: "Relay",
        handle: "value",
        data: json!({ "pin": 10, "type": "NC" }),
        wires: vec![(Source::Button(2), "true"), (Source::Button(3), "toggle"), (Source::Button(4), "false")],
        script: vec![
            (100, 2, 1), (150, 2, 0), (200, 3, 1), (250, 3, 0), (300, 4, 1), (350, 4, 0), (400, 3, 1), (450, 3, 0), (500, 4, 1),
        ],
        until: 1000,
        record: NUMBER,
        live_line: number_line,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["100 1.0000", "200 0.0000", "400 1.0000", "500 0.0000"]);
}

/// A standard Servo's position: a reading, `min`, a clamped reading, a `max`
/// it already holds (nothing), and a reading again. It starts centred, so a
/// first reading of its centre would emit nothing either.
#[test]
fn a_servo_hands_on_where_it_moved() {
    let scenario = Scenario {
        name: "servo",
        kind: "Servo",
        handle: "value",
        data: json!({ "pin": 3, "range": { "min": 20, "max": 160 } }),
        wires: vec![(Source::Sensor("A0", 14), "value"), (Source::Button(2), "min"), (Source::Button(3), "max")],
        script: vec![(100, 14, 45), (200, 2, 1), (250, 2, 0), (300, 14, 170), (400, 3, 1), (450, 3, 0), (500, 14, 100), (600, 14, 90)],
        until: 1000,
        record: NUMBER,
        live_line: number_line,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["100 45.0000", "200 20.0000", "300 160.0000", "500 100.0000", "600 90.0000"]);
}

/// A continuous Servo hands on the speed it was given, and 0 on `stop`.
#[test]
fn a_continuous_servo_hands_on_its_speed() {
    let scenario = Scenario {
        name: "servo-continuous",
        kind: "Servo",
        handle: "value",
        data: json!({ "pin": 3, "type": "continuous" }),
        wires: vec![(Source::Sensor("A0", 14), "rotate"), (Source::Button(2), "stop")],
        script: vec![(100, 14, 1), (200, 2, 1), (250, 2, 0), (300, 14, 2)],
        until: 1000,
        record: NUMBER,
        live_line: number_line,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["100 1.0000", "200 0.0000", "300 2.0000"]);
}

/// A Piezo sounds from the trigger until its duration is up, or until `stop`.
#[test]
fn a_piezo_hands_on_whether_it_sounds() {
    let scenario = Scenario {
        name: "piezo",
        kind: "Piezo",
        handle: "value",
        data: json!({ "pin": 8, "duration": 1000 }),
        wires: vec![(Source::Button(2), "trigger"), (Source::Button(3), "stop")],
        script: vec![(100, 2, 1), (150, 2, 0), (2000, 2, 1), (2050, 2, 0), (2500, 3, 1)],
        until: 4000,
        record: NUMBER,
        live_line: number_line,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["100 1.0000", "1100 0.0000", "2000 1.0000", "2500 0.0000"]);
}

/// An Rgb hands on its colour each time it changes: a channel, the alpha,
/// `off`, and a channel again — and a channel source that has not moved since
/// `off` does not bring its colour back.
#[test]
fn an_rgb_hands_on_its_colour() {
    fn colour(at: u32, value: &serde_json::Value) -> String {
        let channel = |name: &str| value[name].as_f64().unwrap_or_else(|| panic!("an Rgb emits a colour, got {value}"));
        format!("{at} {} {} {} {:.4}", channel("r"), channel("g"), channel("b"), channel("a"))
    }
    let scenario = Scenario {
        name: "rgb",
        kind: "Rgb",
        handle: "value",
        data: json!({ "pins": { "red": 9, "green": 10, "blue": 11 } }),
        wires: vec![
            (Source::Sensor("A0", 14), "red"),
            (Source::Sensor("A1", 15), "alpha"),
            (Source::Sensor("A2", 16), "blue"),
            (Source::Button(2), "off"),
        ],
        script: vec![(100, 14, 200), (200, 15, 50), (300, 2, 1), (350, 2, 0), (400, 16, 80), (500, 16, 80)],
        until: 1000,
        record: r#"printf("%lu %d %d %d %.4f\n", t, (int)rgb_out_red, (int)rgb_out_green, (int)rgb_out_blue, rgb_out_a)"#,
        live_line: colour,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["100 200 0 0 1.0000", "200 200 0 0 0.5000", "300 0 0 0 1.0000", "400 0 0 80 1.0000"]);
}

/// A Led on a pin without PWM (13 on the Uno) is lit by a brightness only
/// from 128, as Arduino's `analogWrite` lights such a pin: a brightness of
/// 100 leaves it dark, so a toggle then lights it.
#[test]
fn a_led_without_pwm_is_lit_from_128() {
    let scenario = Scenario {
        name: "led-no-pwm",
        kind: "Led",
        handle: "value",
        data: json!({ "pin": 13 }),
        wires: vec![(Source::Sensor("A0", 14), "value"), (Source::Button(3), "toggle")],
        script: vec![(100, 14, 100), (400, 3, 1), (450, 3, 0), (500, 14, 200), (600, 3, 1), (650, 3, 0), (700, 3, 1)],
        until: 1000,
        record: NUMBER,
        live_line: number_line,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["100 0.3922", "400 1.0000", "500 0.7843", "600 0.0000", "700 1.0000"]);
}

/// A Piezo triggered again while it sounds keeps sounding, from the new
/// trigger for its whole duration: whether it sounds does not change.
#[test]
fn a_piezo_triggered_while_it_sounds_sounds_on() {
    let scenario = Scenario {
        name: "piezo-retrigger",
        kind: "Piezo",
        handle: "value",
        data: json!({ "pin": 8, "duration": 1000 }),
        wires: vec![(Source::Button(2), "trigger")],
        script: vec![(100, 2, 1), (150, 2, 0), (500, 2, 1), (550, 2, 0)],
        until: 3000,
        record: NUMBER,
        live_line: number_line,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["100 1.0000", "1500 0.0000"]);
}

/// A buzz of 0 ms is silent: the trigger sounds nothing (no endless tone on
/// the board) and the Piezo never says it sounds.
#[test]
fn a_piezo_buzz_of_no_duration_is_silent() {
    let scenario = Scenario {
        name: "piezo-no-duration",
        kind: "Piezo",
        handle: "value",
        data: json!({ "pin": 8, "duration": 0 }),
        wires: vec![(Source::Button(2), "trigger"), (Source::Button(3), "stop")],
        script: vec![(100, 2, 1), (150, 2, 0), (500, 3, 1)],
        until: 1000,
        record: NUMBER,
        live_line: number_line,
    };
    let Some(records) = records(&scenario) else { return };
    assert!(records.is_empty(), "{records:?}");
}

/// A `RangeMap`'s `to` carries the mapped number each time a value arrives,
/// even when it maps onto the number it carried last.
#[test]
fn a_range_map_hands_on_every_mapped_value() {
    let scenario = Scenario {
        name: "range-map-to",
        kind: "RangeMap",
        handle: "to",
        data: json!({ "from": { "min": 0, "max": 1023 }, "to": { "min": 0, "max": 10 } }),
        wires: vec![(Source::Sensor("A0", 14), "value")],
        script: vec![(10, 14, 100), (20, 14, 101), (30, 14, 512), (40, 14, 0)],
        until: 100,
        record: NUMBER,
        live_line: number_line,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["10 1.0000", "20 1.0000", "30 5.0000", "40 0.0000"]);
}

/// A `RangeMap`'s `value` (the input with what it mapped to) changes each
/// time a value arrives that differs from the last.
#[test]
fn a_range_map_hands_on_its_pair() {
    fn at(at: u32, value: &serde_json::Value) -> String {
        assert!(value.is_array(), "a RangeMap's value is its pair, got {value}");
        format!("{at}")
    }
    let scenario = Scenario {
        name: "range-map-value",
        kind: "RangeMap",
        handle: "value",
        data: json!({ "from": { "min": 0, "max": 1023 }, "to": { "min": 0, "max": 10 } }),
        wires: vec![(Source::Sensor("A0", 14), "value")],
        script: vec![(10, 14, 100), (20, 14, 101), (30, 14, 512), (40, 14, 0)],
        until: 100,
        record: r#"printf("%lu\n", t)"#,
        live_line: at,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["10", "20", "30", "40"]);
}

/// A Smooth takes one sample per value it is sent, not one per loop tick: a
/// moving average over two readings is their mean, and stays there.
#[test]
fn a_smooth_takes_one_sample_per_value() {
    let scenario = Scenario {
        name: "smooth",
        kind: "Smooth",
        handle: "value",
        data: json!({ "type": "movingAverage", "windowSize": 2 }),
        wires: vec![(Source::Sensor("A0", 14), "value")],
        script: vec![(100, 14, 100), (200, 14, 200), (300, 14, 400)],
        until: 500,
        record: NUMBER,
        live_line: number_line,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["100 100.0000", "200 150.0000", "300 300.0000"]);
}

/// An Oscillator samples its wave every 16 ms from its start and hands on
/// each sample, the same as the one before or not: a square wave of 64 ms
/// hands on its high, high, low, low, high...
#[test]
fn an_oscillator_hands_on_a_sample_every_16_ms() {
    let scenario = Scenario {
        name: "oscillator",
        kind: "Oscillator",
        handle: "value",
        data: json!({ "waveform": "square", "period": 64, "amplitude": 1 }),
        wires: vec![],
        script: vec![],
        until: 100,
        record: NUMBER,
        live_line: number_line,
    };
    let Some(records) = records(&scenario) else { return };
    assert_eq!(records, ["16 1.0000", "32 -1.0000", "48 -1.0000", "64 1.0000", "80 1.0000", "96 -1.0000"]);
}
