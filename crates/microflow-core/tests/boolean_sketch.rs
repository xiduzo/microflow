//! What a boolean or transform Node hands on when its Sketch runs — and that it
//! is what the live Node emits, for the same pin levels.
//!
//! A Compare or a Gate emits on `true` or `false` each time it checks, and on
//! `value` when its result changes. A Button or a Switch emits on `true` or
//! `false` each time it takes a new level. Whatever the handle, the value it
//! carries is the Node's result: `false` carries `false`. A transform (Compare,
//! Gate, Calculate, Function) checks or computes only when a value reaches it,
//! so it hands on nothing before the first one. A Constant hands on its value
//! once, at the start, whatever that value is.
//!
//! Each scenario generates the Sketch of a whole flow, adds two Counters on the
//! recorded Node's Emit — one counting its emissions (`increment`), one keeping
//! the last value (`set`) — compiles it for the host against a stand-in for the
//! Arduino core (a clock, and pin levels the test scripts), steps `loop()` once
//! per millisecond, and records every loop iteration on which the counting
//! Counter moved, with the value that arrived.
//!
//! With the `runtime` feature the same flow runs live, on a runtime seeded with
//! an Uno's pins, fed the Firmata reports a board running `StandardFirmata`
//! sends for the same levels — every digital port and analog input once at the
//! start, then each change — and the recorded Node's emissions on that handle
//! must come at the same milliseconds with the same values. A flow with a
//! Function Node runs live only with the `js` feature.
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
#include <string>
#define INPUT 0x0
#define OUTPUT 0x1
#define INPUT_PULLUP 0x2
#define HIGH 0x1
#define LOW 0x0
#define constrain(amt, low, high) ((amt) < (low) ? (low) : ((amt) > (high) ? (high) : (amt)))
typedef uint8_t byte;
static unsigned long host_millis = 0;
static int host_pins[64];
unsigned long millis() { return host_millis; }
int analogRead(uint8_t pin) { return host_pins[pin]; }
int digitalRead(uint8_t pin) { return host_pins[pin] ? HIGH : LOW; }
void pinMode(uint8_t, uint8_t) {}
void yield() {}
// Arduino's String, as far as a Sketch uses it.
class String {
 public:
  std::string s;
  String() {}
  String(const char *c) : s(c) {}
  String(double d) { char b[32]; snprintf(b, sizeof b, "%.2f", d); s = b; }
  unsigned int length() const { return (unsigned int)s.size(); }
  const char *c_str() const { return s.c_str(); }
  float toFloat() const { return (float)atof(s.c_str()); }
  String &operator+=(char c) { s += c; return *this; }
  bool operator==(const String &o) const { return s == o.s; }
  bool operator!=(const String &o) const { return s != o.s; }
};
// The network a Monitor's Sketch publishes over: always connected, and
// publishing nowhere.
#define WL_CONNECTED 3
#define WIFI_STA 1
struct HostWiFi { int status() { return WL_CONNECTED; } void mode(int) {} void begin(const char *, const char *) {} };
static HostWiFi WiFi;
class WiFiClient {};
class PubSubClient {
 public:
  PubSubClient(WiFiClient &) {}
  void setServer(const char *, uint16_t) {}
  void setCallback(void (*)(char *, byte *, unsigned int)) {}
  bool connect(const char *) { return true; }
  bool connected() { return true; }
  bool loop() { return true; }
  bool subscribe(const char *) { return true; }
  bool publish(const char *, const char *) { return true; }
};
// The serial MIDI jack a Midi Node's Sketch reads: the scenario's messages,
// `{at ms, status, data1, data2}`, one per read once due.
static unsigned long host_boot = 0;
static const unsigned long host_midi[][4] = { MIDI_SCRIPT };
#define MIDI_CHANNEL_OMNI 0
struct HostMidi {
  unsigned int next = 0;
  unsigned long msg[4] = {0, 0, 0, 0};
  void begin(int) {}
  void turnThruOff() {}
  bool read() {
    if (next >= sizeof host_midi / sizeof host_midi[0] || host_midi[next][1] == 0) { return false; }
    if (host_midi[next][0] > host_millis - host_boot) { return false; }
    for (int i = 0; i < 4; i++) { msg[i] = host_midi[next][i]; }
    next++;
    return true;
  }
  byte getType() { return (byte)(msg[1] & 0xF0); }
  byte getChannel() { return (byte)((msg[1] & 0x0F) + 1); }
  byte getData1() { return (byte)msg[2]; }
  byte getData2() { return (byte)msg[3]; }
};
#define MIDI_CREATE_DEFAULT_INSTANCE() HostMidi MIDI

#include "sketch.ino"

int main(int argc, char **argv) {
  const unsigned long boot = strtoul(argv[1], 0, 10);
  const unsigned long until = strtoul(argv[2], 0, 10);
  host_millis = boot;
  host_boot = boot;
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

/// The libraries a Monitor's or a Midi Node's Sketch includes. The stand-ins
/// live in the host above, so the headers themselves are empty.
const LIBRARY_HEADERS: [&str; 3] = ["WiFi.h", "PubSubClient.h", "MIDI.h"];

struct Scenario {
    name: &'static str,
    nodes: Vec<FlowNode>,
    edges: Vec<FlowEdge>,
    /// The Node and the Emit whose emissions are recorded.
    record: (&'static str, &'static str),
    /// `(at ms, pin, level)`: a pin's level (a raw analog reading on 14–19,
    /// or 0/1) from then on. Every pin starts at 0.
    script: Vec<(u32, u8, i32)>,
    until: u32,
    /// `(at ms, [status, data1, data2])`: a MIDI message arriving, at most
    /// one a millisecond (a Sketch reads one per tick).
    midi: Vec<(u32, [u8; 3])>,
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

/// A Sensor on `A0` (pin 14) or `A1` (pin 15).
fn sensor(id: &str, label: &str) -> FlowNode {
    node(id, "Sensor", json!({ "pin": label }))
}

fn has_cxx() -> bool {
    Command::new("c++").arg("--version").output().is_ok_and(|out| out.status.success())
}

/// What the compiled Sketch records.
fn sketch_records(scenario: &Scenario) -> Vec<String> {
    let (recorded, handle) = scenario.record;
    let mut flow = FlowUpdate { nodes: scenario.nodes.clone(), edges: scenario.edges.clone() };
    flow.nodes.push(node("rec-n", "Counter", json!({})));
    flow.nodes.push(node("rec-v", "Counter", json!({})));
    flow.edges.push(edge(recorded, handle, "rec-n", "increment"));
    flow.edges.push(edge(recorded, handle, "rec-v", "set"));
    let outcome = generate(&flow, &target_by_id("uno").expect("the Uno is supported")).expect("never errors");
    let sketch = outcome.sketch.unwrap_or_else(|| panic!("no sketch: {:?}", outcome.problems));

    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("boolean_sketch").join(scenario.name);
    std::fs::create_dir_all(&dir).expect("create the scenario directory");
    std::fs::write(dir.join("sketch.ino"), &sketch).expect("write the sketch");
    for header in LIBRARY_HEADERS {
        std::fs::write(dir.join(header), "").expect("write a library header");
    }
    let mut midi: Vec<String> = scenario
        .midi
        .iter()
        .map(|(at, [status, d1, d2])| format!("{{{at}, {status}, {d1}, {d2}}}"))
        .collect();
    midi.push("{0, 0, 0, 0}".to_string());
    std::fs::write(dir.join("host.cpp"), HOST.replace("MIDI_SCRIPT", &midi.join(", "))).expect("write the host");
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

/// What the live flow's recorded Node emits on the recorded handle when a
/// board reports the same levels: every digital port and analog input once at
/// the start, then each change. Wakeups fire on the same millisecond clock,
/// after that millisecond's reports.
#[cfg(feature = "runtime")]
fn live_records(scenario: &Scenario) -> Vec<String> {
    use microflow_core::runtime::{Effects, FlowRuntime, Wakeup};

    fn apply(
        effects: Effects,
        now: u32,
        record: (&str, &str),
        timers: &mut Vec<(u64, Wakeup)>,
        out: &mut Vec<(u32, serde_json::Value)>,
    ) {
        timers.retain(|(_, wakeup)| !effects.cancellations.contains(&wakeup.id));
        timers.extend(effects.wakeups.into_iter().map(|wakeup| (u64::from(now) + wakeup.delay_ms, wakeup)));
        for event in effects.component_events {
            if (event.source.as_ref(), event.source_handle.as_ref()) == record {
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
    let flow = FlowUpdate { nodes: scenario.nodes.clone(), edges: scenario.edges.clone() };
    runtime.set_now(0.0);
    apply(runtime.update_flow(flow), 0, scenario.record, &mut timers, &mut emitted);
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
            apply(effects, now, scenario.record, &mut timers, &mut emitted);
        }
        // A MIDI message reaches every Midi Node, as the host's port fans it out.
        for (_, message) in scenario.midi.iter().filter(|(at, _)| *at == now) {
            for midi in scenario.nodes.iter().filter(|n| n.node_type.as_deref() == Some("Midi")) {
                apply(runtime.deliver_message(&midi.id, "", message), now, scenario.record, &mut timers, &mut emitted);
            }
        }
        while let Some(index) = timers.iter().position(|(due, _)| *due <= u64::from(now)) {
            let (_, wakeup) = timers.remove(index);
            apply(runtime.wake(&wakeup.node_id, &wakeup.method), now, scenario.record, &mut timers, &mut emitted);
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

/// Whether the live runtime can build every Node of `scenario`: a Function
/// needs the `js` feature.
#[cfg(feature = "runtime")]
fn runs_live(scenario: &Scenario) -> bool {
    cfg!(feature = "js") || !scenario.nodes.iter().any(|n| n.node_type.as_deref() == Some("Function"))
}

/// Run `scenario` through its generated Sketch — and, with the `runtime`
/// feature, through the live flow, which must agree. `None` without `c++`.
fn records(scenario: &Scenario) -> Option<Vec<String>> {
    if !has_cxx() {
        eprintln!("skipped {}: no `c++` on the PATH to compile the generated sketch with", scenario.name);
        return None;
    }
    let sketch = sketch_records(scenario);
    #[cfg(feature = "runtime")]
    if runs_live(scenario) {
        assert_eq!(sketch, live_records(scenario), "{}: the sketch (left) and the live runtime (right) disagree", scenario.name);
    }
    Some(sketch)
}

/// A Sensor on A0 into a Compare with `data`, its `handle` recorded.
fn compare(name: &'static str, data: serde_json::Value, handle: &'static str, readings: &[(u32, i32)]) -> Scenario {
    Scenario {
        name,
        nodes: vec![sensor("s", "A0"), node("cmp", "Compare", data)],
        edges: vec![edge("s", "value", "cmp", "value")],
        record: ("cmp", handle),
        script: readings.iter().map(|&(at, level)| (at, 14, level)).collect(),
        until: 600,
        midi: vec![],
    }
}

/// A Compare says `true` on each check that passes, not only when its result
/// turns true: 200 passes again.
#[test]
fn a_compare_says_true_on_every_check_that_passes() {
    let data = json!({ "validator": "number", "subValidator": "greater than", "number": 50 });
    let readings = [(100, 100), (200, 200), (300, 10), (400, 20), (500, 60)];
    let Some(got) = records(&compare("greater-true", data, "true", &readings)) else { return };
    assert_eq!(got, ["100 1.0000", "200 1.0000", "500 1.0000"]);
}

/// A Compare's `false` carries `false`, on each check that fails.
#[test]
fn a_compare_says_false_with_false_on_every_check_that_fails() {
    let data = json!({ "validator": "number", "subValidator": "greater than", "number": 50 });
    let readings = [(100, 100), (200, 200), (300, 10), (400, 20), (500, 60)];
    let Some(got) = records(&compare("greater-false", data, "false", &readings)) else { return };
    assert_eq!(got, ["300 0.0000", "400 0.0000"]);
}

/// A Compare checks nothing before a value reaches it: a reading of 0 is less
/// than 50, but the Sensor has handed on nothing yet.
#[test]
fn a_compare_says_nothing_before_its_first_value() {
    let data = json!({ "validator": "number", "subValidator": "less than", "number": 50 });
    let readings = [(100, 100), (200, 10), (300, 20)];
    let Some(got) = records(&compare("less-true", data, "true", &readings)) else { return };
    assert_eq!(got, ["200 1.0000", "300 1.0000"]);
}

/// The default number check is equality.
#[test]
fn a_compare_checks_a_number_for_equality() {
    let data = json!({ "validator": "number", "number": 100 });
    let readings = [(100, 100), (200, 101), (300, 100)];
    let Some(got) = records(&compare("equals-true", data, "true", &readings)) else { return };
    assert_eq!(got, ["100 1.0000", "300 1.0000"]);
}

/// Odd and even round the value first; `false` carries `false`.
#[test]
fn a_compare_checks_odd_and_even() {
    let readings = [(100, 3), (200, 5), (300, 4)];
    let odd = json!({ "validator": "oddEven", "subValidator": "odd" });
    let Some(got) = records(&compare("odd-true", odd, "true", &readings)) else { return };
    assert_eq!(got, ["100 1.0000", "200 1.0000"]);
    let even = json!({ "validator": "oddEven", "subValidator": "even" });
    let Some(got) = records(&compare("even-false", even, "false", &readings)) else { return };
    assert_eq!(got, ["100 0.0000", "200 0.0000"]);
}

/// A range check: strictly inside the bounds, or outside them — and 0, outside
/// 10–50, is no value until the Sensor hands it on.
#[test]
fn a_compare_checks_a_range() {
    let readings = [(100, 20), (200, 30), (300, 60)];
    let inside = json!({ "validator": "range", "range": { "min": 10, "max": 50 } });
    let Some(got) = records(&compare("inside-true", inside, "true", &readings)) else { return };
    assert_eq!(got, ["100 1.0000", "200 1.0000"]);
    let outside = json!({ "validator": "range", "subValidator": "outside", "range": { "min": 10, "max": 50 } });
    let Some(got) = records(&compare("outside-true", outside, "true", &readings)) else { return };
    assert_eq!(got, ["300 1.0000"]);
}

/// The boolean check: a Button's release is `false`, and so says the Compare.
#[test]
fn a_compare_checks_truthiness() {
    let scenario = Scenario {
        name: "boolean-false",
        nodes: vec![node("b", "Button", json!({ "pin": 2 })), node("cmp", "Compare", json!({ "validator": "boolean" }))],
        edges: vec![edge("b", "value", "cmp", "value")],
        record: ("cmp", "false"),
        script: vec![(100, 2, 1), (200, 2, 0), (300, 2, 1), (400, 2, 0)],
        until: 600,
        midi: vec![],
    };
    let Some(got) = records(&scenario) else { return };
    assert_eq!(got, ["200 0.0000", "400 0.0000"]);
}

/// Two numbers a hair apart are equal: 0.1 + 0.2 equals 0.3, as the live
/// Compare counts equality, and 0.3000000000000003 does not.
#[test]
fn a_compare_counts_numbers_within_its_tolerance_as_equal() {
    let near = |name: &'static str, number: f64, handle: &'static str| Scenario {
        name,
        nodes: vec![
            node("a", "Constant", json!({ "value": 0.1 })),
            node("b", "Constant", json!({ "value": 0.2 })),
            node("sum", "Calculate", json!({ "function": "add" })),
            node("cmp", "Compare", json!({ "validator": "number", "number": number })),
        ],
        edges: vec![edge("a", "value", "sum", "value"), edge("b", "value", "sum", "value"), edge("sum", "value", "cmp", "value")],
        record: ("cmp", handle),
        script: vec![],
        until: 10,
        midi: vec![],
    };
    let Some(got) = records(&near("equal-near", 0.3, "true")) else { return };
    assert_eq!(got, ["0 1.0000"]);
    let Some(got) = records(&near("equal-far", 0.300_000_000_000_000_3, "false")) else { return };
    assert_eq!(got, ["0 0.0000"]);
}

/// Two Buttons into an `and` Gate: it checks each time either moves, so it
/// says `false` again when both are released.
#[test]
fn a_gate_says_false_with_false_on_every_check_that_fails() {
    let scenario = Scenario {
        name: "gate-and-false",
        nodes: vec![
            node("b1", "Button", json!({ "pin": 2 })),
            node("b2", "Button", json!({ "pin": 3 })),
            node("g", "Gate", json!({ "gate": "and" })),
        ],
        edges: vec![edge("b1", "value", "g", "value"), edge("b2", "value", "g", "value")],
        record: ("g", "false"),
        script: vec![(100, 2, 1), (200, 3, 1), (300, 2, 0), (400, 3, 0)],
        until: 600,
        midi: vec![],
    };
    let Some(got) = records(&scenario) else { return };
    assert_eq!(got, ["100 0.0000", "300 0.0000", "400 0.0000"]);
}

/// A `nand` Gate of one unpressed Button would pass — but it checks nothing
/// before the Button hands something on.
#[test]
fn a_gate_says_nothing_before_its_first_value() {
    let scenario = Scenario {
        name: "gate-nand-true",
        nodes: vec![node("b", "Button", json!({ "pin": 2 })), node("g", "Gate", json!({ "gate": "nand" }))],
        edges: vec![edge("b", "value", "g", "value")],
        record: ("g", "true"),
        script: vec![(100, 2, 1), (200, 2, 0)],
        until: 400,
        midi: vec![],
    };
    let Some(got) = records(&scenario) else { return };
    assert_eq!(got, ["200 1.0000"]);
}

/// A Gate fed by a Compare's `false` counts the Compare's result, `false`,
/// so an `or` of it fails — each time the Compare fails.
#[test]
fn a_gate_counts_a_false_it_is_sent_as_false() {
    let scenario = Scenario {
        name: "gate-of-false",
        nodes: vec![
            sensor("s", "A0"),
            node("cmp", "Compare", json!({ "validator": "number", "subValidator": "less than", "number": 50 })),
            node("g", "Gate", json!({ "gate": "or" })),
        ],
        edges: vec![edge("s", "value", "cmp", "value"), edge("cmp", "false", "g", "value")],
        record: ("g", "false"),
        script: vec![(100, 14, 100), (200, 14, 10), (300, 14, 100)],
        until: 400,
        midi: vec![],
    };
    let Some(got) = records(&scenario) else { return };
    assert_eq!(got, ["100 0.0000", "300 0.0000"]);
}

/// A Button's `false` is its release, and carries `false`.
#[test]
fn a_button_says_false_with_false() {
    let scenario = Scenario {
        name: "button-false",
        nodes: vec![node("b", "Button", json!({ "pin": 2 }))],
        edges: vec![],
        record: ("b", "false"),
        script: vec![(100, 2, 1), (200, 2, 0), (300, 2, 1), (400, 2, 0)],
        until: 600,
        midi: vec![],
    };
    let Some(got) = records(&scenario) else { return };
    assert_eq!(got, ["200 0.0000", "400 0.0000"]);
}

/// A normally-closed Switch opening says `false`, with `false`.
#[test]
fn a_switch_says_false_with_false() {
    let scenario = Scenario {
        name: "switch-false",
        nodes: vec![node("sw", "Switch", json!({ "pin": 2, "type": "NC" }))],
        edges: vec![],
        record: ("sw", "false"),
        script: vec![(100, 2, 1), (200, 2, 0)],
        until: 400,
        midi: vec![],
    };
    let Some(got) = records(&scenario) else { return };
    assert_eq!(got, ["200 0.0000"]);
}

/// A Counter counts each check that passes and is set to 0 by each that
/// fails.
#[test]
fn a_false_sets_a_counter_to_zero() {
    let scenario = Scenario {
        name: "false-into-counter",
        nodes: vec![
            sensor("s", "A0"),
            node("cmp", "Compare", json!({ "validator": "number", "subValidator": "greater than", "number": 50 })),
            node("ctr", "Counter", json!({})),
        ],
        edges: vec![
            edge("s", "value", "cmp", "value"),
            edge("cmp", "true", "ctr", "increment"),
            edge("cmp", "false", "ctr", "set"),
        ],
        record: ("ctr", "value"),
        script: vec![(100, 14, 100), (200, 14, 200), (300, 14, 10), (400, 14, 20), (500, 14, 60)],
        until: 600,
        midi: vec![],
    };
    let Some(got) = records(&scenario) else { return };
    assert_eq!(got, ["100 1.0000", "200 2.0000", "300 0.0000", "500 1.0000"]);
}

/// A Monitor shows the `false` it is sent: a new value, where it showed the
/// number 0 before.
#[test]
fn a_monitor_shows_a_false_it_is_sent() {
    let scenario = Scenario {
        name: "false-into-monitor",
        nodes: vec![
            sensor("s", "A0"),
            node("cmp", "Compare", json!({ "validator": "number", "subValidator": "greater than", "number": 50 })),
            node("mon", "Monitor", json!({ "broker": "b", "uniqueId": "u", "wifiSsid": "net" })),
        ],
        edges: vec![edge("s", "value", "cmp", "value"), edge("cmp", "false", "mon", "value")],
        record: ("mon", "value"),
        script: vec![(100, 14, 100), (300, 14, 10), (400, 14, 20), (500, 14, 60)],
        until: 600,
        midi: vec![],
    };
    let Some(got) = records(&scenario) else { return };
    assert_eq!(got, ["300 0.0000"]);
}

/// A Calculate computes only when a value reaches it: `pow` of two Sensors
/// that read 0 is 1, but nothing is handed on before the first reading.
#[test]
fn a_calculate_computes_nothing_before_its_first_value() {
    let scenario = Scenario {
        name: "calculate-pow",
        nodes: vec![sensor("x", "A0"), sensor("y", "A1"), node("calc", "Calculate", json!({ "function": "pow" }))],
        edges: vec![edge("x", "value", "calc", "value"), edge("y", "value", "calc", "value")],
        record: ("calc", "value"),
        script: vec![(100, 14, 2), (200, 15, 3)],
        until: 400,
        midi: vec![],
    };
    let Some(got) = records(&scenario) else { return };
    assert_eq!(got, ["100 1.0000", "200 8.0000"]);
}

/// A Function computes only when a value reaches it.
#[test]
fn a_function_computes_nothing_before_its_first_value() {
    let scenario = Scenario {
        name: "function-plus-one",
        nodes: vec![sensor("s", "A0"), node("f", "Function", json!({ "code": "return input + 1;" }))],
        edges: vec![edge("s", "value", "f", "trigger")],
        record: ("f", "value"),
        script: vec![(100, 14, 5)],
        until: 200,
        midi: vec![],
    };
    let Some(got) = records(&scenario) else { return };
    assert_eq!(got, ["100 6.0000"]);
}

/// A Midi Node hands on a note, its velocity and `on` or `off` for every
/// message — the same note again, and a second note-on with no note-off
/// between, included.
#[test]
fn a_midi_node_hands_on_every_message() {
    let messages = vec![(100, [0x90, 60, 100]), (150, [0x90, 60, 100]), (200, [0x80, 60, 0]), (300, [0x90, 60, 90])];
    let expected = [
        ("note", vec!["100 60.0000", "150 60.0000", "200 60.0000", "300 60.0000"]),
        ("velocity", vec!["100 100.0000", "150 100.0000", "200 0.0000", "300 90.0000"]),
        ("on", vec!["100 1.0000", "150 1.0000", "300 1.0000"]),
        ("off", vec!["200 1.0000"]),
    ];
    for (handle, want) in expected {
        let scenario = Scenario {
            name: handle,
            nodes: vec![node("m", "Midi", json!({ "direction": "in", "mode": "note" }))],
            edges: vec![],
            record: ("m", handle),
            script: vec![],
            until: 400,
            midi: messages.clone(),
        };
        let Some(got) = records(&scenario) else { return };
        assert_eq!(got, want, "{handle}");
    }
}

/// A Constant hands on its value once, at the start — a 0 as well.
#[test]
fn a_constant_hands_on_its_value_once_even_when_it_is_zero() {
    for (name, value) in [("constant-zero", 0.0), ("constant-five", 5.0)] {
        let scenario = Scenario {
            name,
            nodes: vec![node("c", "Constant", json!({ "value": value })), node("ctr", "Counter", json!({}))],
            edges: vec![edge("c", "value", "ctr", "increment")],
            record: ("ctr", "value"),
            script: vec![],
            until: 10,
            midi: vec![],
        };
        let Some(got) = records(&scenario) else { return };
        assert_eq!(got, ["0 1.0000"], "{name}");
    }
}
