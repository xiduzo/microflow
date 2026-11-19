//! What a Function Node computes and hands on when its Sketch runs — and that
//! it is what the live Node, running the same JavaScript, emits.
//!
//! The board runs a translation of the Node's code to C++, held to
//! JavaScript's semantics where the two languages differ: `&&` / `||` hand on
//! an operand, `%` keeps the dividend's sign, `Math.round` rounds halves up,
//! `NaN` is falsy, `Math.min` / `Math.max` / `Math.pow` see `NaN` and `-0`,
//! `===` between a number and a boolean is `false`, a boolean divides as a
//! number, and so on. Each table row is one body and what the live Node
//! emits for it (worked out with JavaScript itself): the sketch must emit the
//! same, at the same moments, with the same type — and, with the `js`
//! feature, so must the live runtime.
//!
//! A value the Node already holds is not sent again (`set_value`): the first
//! result of 0 is never sent, a first `false` is (the Node starts at the
//! number 0), and a `NaN` is sent on every evaluation.
//!
//! Code the board cannot run the way the live Node does is refused: a note in
//! the sketch, a warning from generation, and a Node that never emits.
//!
//! Needs a C++ compiler on the PATH as `c++`; without one the scenarios are
//! skipped with a note.

use microflow_core::codegen::board::target_by_id;
use microflow_core::codegen::generate;
use microflow_core::codegen::validate::ProblemSeverity;
use microflow_core::flow::{FlowEdge, FlowNode, FlowUpdate, Position};
use serde_json::json;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::process::Command;

/// Where the device clock stands when a scenario starts.
const BOOT_MS: u32 = 1000;

/// The inputs every row of [`VALUES`] runs on, each from a Constant.
const INPUTS: [f64; 6] = [-2.5, -0.5, 0.0, 0.5, 1.0, 7.0];

/// A body, and what the live Node sends for each of [`INPUTS`]: a number, a
/// boolean, or `-` for nothing (the result equals the 0 the Node holds).
/// Worked out by running each body as a JavaScript function with the Node's
/// builtins.
const VALUES: &[(&str, [&str; 6])] = &[
    // `%` keeps the dividend's sign and works on fractions, as C's fmod.
    ("return input % 3;", ["-2.5", "-0.5", "-", "0.5", "1", "1"]),
    ("return input % -3;", ["-2.5", "-0.5", "-", "0.5", "1", "1"]),
    ("return input % 0;", ["NaN", "NaN", "NaN", "NaN", "NaN", "NaN"]),
    ("return -7 % 2.5 + input;", ["-4.5", "-2.5", "-2", "-1.5", "-1", "5"]),
    // Math.round: a half rounds up (-2.5 to -2, -0.5 to -0), and exactly.
    ("return Math.round(input);", ["-2", "-", "-", "1", "1", "7"]),
    ("return 1 / Math.round(input);", ["-0.5", "-Infinity", "Infinity", "1", "1", "0.14285714285714285"]),
    ("return Math.round(0.49999999999999994) + input;", ["-2.5", "-0.5", "-", "0.5", "1", "7"]),
    ("return Math.round(input) === -2;", ["true", "false", "false", "false", "false", "false"]),
    ("return Math.round(-0.5) === 0 ? input : 0;", ["-2.5", "-0.5", "-", "0.5", "1", "7"]),
    // `&&` / `||` hand on an operand, and NaN is falsy.
    ("return input && 5;", ["5", "5", "-", "5", "5", "5"]),
    ("return input || 5;", ["-2.5", "-0.5", "5", "0.5", "1", "7"]),
    ("return (0 / 0) || input;", ["-2.5", "-0.5", "-", "0.5", "1", "7"]),
    ("return !(input / 0 * 0);", ["true", "true", "true", "true", "true", "true"]),
    ("return (input - 1) ? 1 : 2;", ["1", "1", "1", "1", "2", "1"]),
    ("return (input * 0 / 0) ? 1 : 2;", ["2", "2", "2", "2", "2", "2"]),
    // The Node's builtins.
    ("return toBool(input / 0 * 0);", ["false", "false", "false", "false", "false", "false"]),
    ("return toBool(input);", ["true", "true", "false", "true", "true", "true"]),
    ("return toNumber(0 / 0, input) + 1;", ["-1.5", "0.5", "1", "1.5", "2", "8"]),
    ("return toNumber(input) + toNumber(0 / 0);", ["-2.5", "-0.5", "-", "0.5", "1", "7"]),
    ("return toNumber(input > 2);", ["-", "-", "-", "-", "-", "1"]),
    ("return ensureRange(input, 0, 5);", ["-", "-", "-", "0.5", "1", "-"]),
    ("return ensureRange(input, 0, 5, 9);", ["9", "9", "-", "0.5", "1", "9"]),
    ("return isValid(Math.sqrt(input));", ["false", "false", "true", "true", "true", "true"]),
    // Math.min / max / pow: NaN wins, -0 is below 0, and any number of arguments.
    ("return Math.min(input, 0 / 0);", ["NaN", "NaN", "NaN", "NaN", "NaN", "NaN"]),
    ("return Math.max(0 / 0, input);", ["NaN", "NaN", "NaN", "NaN", "NaN", "NaN"]),
    ("return 1 / Math.min(input * 0, -0);", ["-Infinity", "-Infinity", "-Infinity", "-Infinity", "-Infinity", "-Infinity"]),
    ("return 1 / Math.max(-0, input * 0);", ["-Infinity", "-Infinity", "Infinity", "Infinity", "Infinity", "Infinity"]),
    ("return Math.min(input, 1, 2);", ["-2.5", "-0.5", "-", "0.5", "1", "1"]),
    ("return Math.max();", ["-Infinity", "-Infinity", "-Infinity", "-Infinity", "-Infinity", "-Infinity"]),
    ("return Math.floor();", ["NaN", "NaN", "NaN", "NaN", "NaN", "NaN"]),
    ("return Math.pow(1, input / 0);", ["NaN", "NaN", "NaN", "NaN", "NaN", "NaN"]),
    ("return Math.pow(input, 2);", ["6.25", "0.25", "-", "0.25", "1", "49"]),
    ("return input ** 2;", ["6.25", "0.25", "-", "0.25", "1", "49"]),
    ("return 2 ** 3 ** 2;", ["512", "512", "512", "512", "512", "512"]),
    ("return (-input) ** 0.5;", ["1.5811388300841898", "0.7071067811865476", "-", "NaN", "NaN", "NaN"]),
    ("return Math.floor(input) + Math.ceil(input) + Math.abs(input);", ["-2.5", "-0.5", "-", "1.5", "3", "21"]),
    ("return Math.sqrt(input);", ["NaN", "NaN", "-", "0.7071067811865476", "1", "2.6457513110645907"]),
    // Division by zero, and booleans in arithmetic: numbers, never integers.
    ("return input / 0;", ["-Infinity", "-Infinity", "NaN", "Infinity", "Infinity", "Infinity"]),
    ("return 5 % 0 + input;", ["NaN", "NaN", "NaN", "NaN", "NaN", "NaN"]),
    ("return (input > 0) / (input > 1);", ["NaN", "NaN", "NaN", "Infinity", "Infinity", "1"]),
    ("return (input > 0) % 2;", ["-", "-", "-", "1", "1", "1"]),
    ("return true + true;", ["2", "2", "2", "2", "2", "2"]),
    ("return -true;", ["-1", "-1", "-1", "-1", "-1", "-1"]),
    ("return +input + +true;", ["-1.5", "0.5", "1", "1.5", "2", "8"]),
    // Equality: `===` never matches a number to a boolean, `==` converts.
    ("return input === (input > 0);", ["false", "false", "false", "false", "false", "false"]),
    ("return input == (input > 0);", ["false", "false", "true", "false", "true", "false"]),
    ("return input !== true;", ["true", "true", "true", "true", "true", "true"]),
    ("return (input > 0) === (input > 1);", ["true", "true", "true", "false", "false", "true"]),
    ("return input >= 1 === true;", ["false", "false", "false", "false", "true", "true"]),
    // Booleans out, and a value that is a number or a boolean used as a number.
    ("return input > 0 && input < 5;", ["false", "false", "false", "true", "true", "false"]),
    ("return input > 1 ? input > 2 : input < 0;", ["true", "true", "false", "false", "false", "true"]),
    ("return (input && input > 1) + 0;", ["-", "-", "-", "-", "-", "1"]),
    ("return !input;", ["false", "false", "true", "false", "false", "false"]),
    ("return !!input;", ["true", "true", "false", "true", "true", "true"]),
    // Literals, unary minus, bindings and statements.
    ("return 0.1 + 0.2 + input;", ["-2.2", "-0.19999999999999996", "0.30000000000000004", "0.8", "1.3", "7.3"]),
    ("return 1e3 + .5 + 5. + input;", ["1003", "1005", "1005.5", "1006", "1006.5", "1012.5"]),
    ("return input - -1;", ["-1.5", "0.5", "1", "1.5", "2", "8"]),
    ("return - -input;", ["-2.5", "-0.5", "-", "0.5", "1", "7"]),
    ("const a = input * 2\nreturn a + 1", ["-4", "-", "1", "2", "3", "15"]),
    ("var input = input * 2; return input;", ["-5", "-1", "-", "1", "2", "14"]),
    ("const a = input; var b = a; var b = b + 1; return b;", ["-1.5", "0.5", "1", "1.5", "2", "8"]),
    ("const unused = Math.sqrt(input); const k = 3; return k * input;", ["-7.5", "-1.5", "-", "1.5", "3", "21"]),
    ("// a {{slot}} in a comment\nreturn input; // trailing", ["-2.5", "-0.5", "-", "0.5", "1", "7"]),
];

/// Code the board refuses, and whether the live Node is silent on it too
/// (the code throws, or returns nothing, there as well).
const REFUSED: &[(&str, bool)] = &[
    // JavaScript rejects it, or it returns nothing: silent live as well.
    ("return 1.2.3;", true),
    ("const input = 1; return input;", true),
    ("return\ninput;", true),
    ("return -input ** 2;", true),
    ("for (;;) {} return 1;", true),
    ("return input + {{gain}};", true),
    ("return;", true),
    ("const a = input;", true),
    // The live Node runs it; the board cannot run it the same way.
    ("return 010;", false),
    ("return 0x10;", false),
    ("return --input;", false),
    ("return input-- - 1;", false),
    // JavaScript rejects a second `let` of a name; boa (the live engine)
    // takes it, and the live Node returns 2. The board keeps to JavaScript.
    ("let a = 1; let a = 2; return a;", false),
    ("return input > 1 ? 1 : false;", false),
    ("return input && input > 1;", false),
    ("return input === (input > 1 ? 1 : false);", false),
    ("return \"text\";", false),
    ("return Math.random() * 0 + 1;", false),
    ("return Math.PI;", false),
];

/// The Arduino core, as far as these Sketches need it, and a `main` that
/// plays `<boot ms> <until ms> [<at ms> <pin> <level>]...` and prints each
/// Function emission as `<t> <id> b <0|1>` or `<t> <id> n <bits>`.
const HOST: &str = r#"
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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

#include "sketch.ino"

inline void show(unsigned long t, const char *id, bool v) { printf("%lu %s b %d\n", t, id, v ? 1 : 0); }
inline void show(unsigned long t, const char *id, double v) {
  uint64_t bits;
  memcpy(&bits, &v, sizeof bits);
  printf("%lu %s n %016llx\n", t, id, (unsigned long long)bits);
}

int main(int argc, char **argv) {
  const unsigned long boot = strtoul(argv[1], 0, 10);
  const unsigned long until = strtoul(argv[2], 0, 10);
  host_millis = boot;
  setup();
  for (unsigned long t = 0; t <= until; t++) {
    host_millis = boot + t;
    for (int i = 3; i + 2 < argc; i += 3) {
      if (strtoul(argv[i], 0, 10) == t) { host_pins[atoi(argv[i + 1])] = atoi(argv[i + 2]); }
    }
    loop();
RECORD
  }
  return 0;
}
"#;

/// One flow, the Function Nodes in it whose emissions are recorded, and the
/// pin levels it runs on.
struct Scenario {
    name: &'static str,
    flow: FlowUpdate,
    functions: Vec<String>,
    /// `(at ms, pin, level)`: a pin's level from then on. Every pin starts at 0.
    script: Vec<(u32, u8, i32)>,
    until: u32,
}

/// Each recorded Function's emissions, as `<t> <value>` lines.
type Records = BTreeMap<String, Vec<String>>;

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

fn function(id: &str, code: &str) -> FlowNode {
    node(id, "Function", json!({ "code": code }))
}

/// A number as the table and both sides show it.
fn show_number(n: f64) -> String {
    if n.is_nan() {
        "NaN".to_string()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity" } else { "-Infinity" }.to_string()
    } else {
        format!("{n:?}")
    }
}

/// A table entry as both sides show it (`-` stays `-`).
fn expected(entry: &str) -> String {
    match entry {
        "-" | "true" | "false" => entry.to_string(),
        "NaN" => show_number(f64::NAN),
        "Infinity" => show_number(f64::INFINITY),
        "-Infinity" => show_number(f64::NEG_INFINITY),
        number => show_number(number.parse().unwrap_or_else(|e| panic!("`{number}`: {e}"))),
    }
}

fn has_cxx() -> bool {
    Command::new("c++").arg("--version").output().is_ok_and(|out| out.status.success())
}

/// Generate the scenario's Sketch on the Uno, with its problems.
fn sketch_of(scenario: &Scenario) -> (String, Vec<microflow_core::codegen::validate::ValidationProblem>) {
    let outcome = generate(&scenario.flow, &target_by_id("uno").expect("the Uno is supported")).expect("never errors");
    let sketch = outcome.sketch.unwrap_or_else(|| panic!("no sketch: {:?}", outcome.problems));
    (sketch, outcome.problems)
}

/// What the compiled Sketch records.
fn sketch_records(scenario: &Scenario) -> Records {
    let (sketch, _) = sketch_of(scenario);
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("function_sketch").join(scenario.name);
    std::fs::create_dir_all(&dir).expect("create the scenario directory");
    std::fs::write(dir.join("sketch.ino"), &sketch).expect("write the sketch");
    let mut record = String::new();
    for id in &scenario.functions {
        let token = id.replace('-', "_");
        writeln!(
            record,
            "    if (function_{token}_fired && function_{token}_changed) {{ show(t, \"{id}\", function_{token}_value); }}"
        )
        .expect("writing to a String cannot fail");
    }
    std::fs::write(dir.join("host.cpp"), HOST.replace("RECORD\n", &record)).expect("write the host");
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
    let mut records = Records::new();
    for line in String::from_utf8(out.stdout).expect("utf-8 output").lines() {
        let [t, id, kind, value] = line.split(' ').collect::<Vec<_>>()[..] else { panic!("bad line `{line}`") };
        let shown = match kind {
            "b" => (value == "1").to_string(),
            _ => show_number(f64::from_bits(u64::from_str_radix(value, 16).expect("hex bits"))),
        };
        records.entry(id.to_string()).or_default().push(format!("{t} {shown}"));
    }
    records
}

/// An Uno's pins as a Runtime Host seeds them: PWM on 3, 5, 6, 9, 10 and 11,
/// analog inputs A0–A5 on 14–19.
#[cfg(feature = "js")]
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

/// What the live flow's Function Nodes emit when a board reports the same
/// levels: every digital port and analog input once at the start, then each
/// change. Wakeups fire on the same millisecond clock.
#[cfg(feature = "js")]
fn live_records(scenario: &Scenario) -> Records {
    use microflow_core::runtime::value::ComponentValue;
    use microflow_core::runtime::{Effects, FlowRuntime, Wakeup};

    fn apply(effects: Effects, now: u32, functions: &[String], timers: &mut Vec<(u64, Wakeup)>, out: &mut Records) {
        timers.retain(|(_, wakeup)| !effects.cancellations.contains(&wakeup.id));
        timers.extend(effects.wakeups.into_iter().map(|wakeup| (u64::from(now) + wakeup.delay_ms, wakeup)));
        for event in effects.component_events {
            if &*event.source_handle != "value" || !functions.iter().any(|f| *f == *event.source) {
                continue;
            }
            let shown = match event.value {
                ComponentValue::Bool(b) => b.to_string(),
                ComponentValue::Number(n) => show_number(n),
                other => format!("{other:?}"),
            };
            out.entry(event.source.to_string()).or_default().push(format!("{now} {shown}"));
        }
    }

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
    let mut emitted = Records::new();
    let fns = &scenario.functions;
    runtime.set_now(0.0);
    apply(runtime.update_flow(scenario.flow.clone()), 0, fns, &mut timers, &mut emitted);
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
            apply(runtime.feed_bytes(&reports(&pins, &ports, &channels)), now, fns, &mut timers, &mut emitted);
        }
        while let Some(index) = timers.iter().position(|(due, _)| *due <= u64::from(now)) {
            let (_, wakeup) = timers.remove(index);
            apply(runtime.wake(&wakeup.node_id, &wakeup.method), now, fns, &mut timers, &mut emitted);
        }
    }
    emitted
}

/// Run `scenario` through its compiled Sketch and, with the `js` feature,
/// through the live flow; both must match `want`. Every mismatch is listed.
fn check(scenario: &Scenario, want: &Records, describe: &dyn Fn(&str) -> String) {
    #[cfg_attr(not(feature = "js"), allow(unused_mut))]
    let mut sides = vec![("sketch", sketch_records(scenario))];
    #[cfg(feature = "js")]
    sides.push(("live", live_records(scenario)));
    let mut mismatches = Vec::new();
    for (side, got) in &sides {
        for id in &scenario.functions {
            let none = Vec::new();
            let (got, want) = (got.get(id).unwrap_or(&none), want.get(id).unwrap_or(&none));
            if got != want {
                mismatches.push(format!("{side}: {} — want {want:?}, got {got:?}", describe(id)));
            }
        }
    }
    assert_eq!(mismatches, [] as [String; 0], "{}: {} mismatch(es):\n{}", scenario.name, mismatches.len(), mismatches.join("\n"));
}

/// Every row of [`VALUES`] on every input, each from a Constant: one emission
/// at the start, the same on the board as live.
#[test]
fn every_expression_computes_on_the_board_what_it_computes_live() {
    if !has_cxx() {
        eprintln!("skipped: no `c++` on the PATH to compile the generated sketch with");
        return;
    }
    let mut flow = FlowUpdate { nodes: Vec::new(), edges: Vec::new() };
    let mut functions = Vec::new();
    let mut want = Records::new();
    for (j, input) in INPUTS.iter().enumerate() {
        flow.nodes.push(node(&format!("c{j}"), "Constant", json!({ "value": input })));
    }
    for (i, (code, row)) in VALUES.iter().enumerate() {
        for (j, entry) in row.iter().enumerate() {
            let id = format!("f{i}x{j}");
            flow.nodes.push(function(&id, code));
            flow.edges.push(edge(&format!("c{j}"), "value", &id, "trigger"));
            if *entry != "-" {
                want.insert(id.clone(), vec![format!("0 {}", expected(entry))]);
            }
            functions.push(id);
        }
    }
    let scenario = Scenario { name: "values", flow, functions, script: vec![], until: 5 };
    let (_, problems) = sketch_of(&scenario);
    assert_eq!(problems, [], "every row runs on the board");
    check(&scenario, &want, &|id| {
        let (i, j) = id[1..].split_once('x').expect("f<i>x<j>");
        let (i, j): (usize, usize) = (i.parse().expect("row"), j.parse().expect("input"));
        format!("{:?} on input {}", VALUES[i].0, INPUTS[j])
    });
}

/// One flow of Functions fed by `source`'s `value`, each with its own
/// expected emissions, over the pin `script`.
fn fed_by(name: &'static str, source: &FlowNode, rows: &[(&str, &[&str])], script: Vec<(u32, u8, i32)>) {
    if !has_cxx() {
        eprintln!("skipped {name}: no `c++` on the PATH to compile the generated sketch with");
        return;
    }
    let mut flow = FlowUpdate { nodes: vec![source.clone()], edges: Vec::new() };
    let mut functions = Vec::new();
    let mut want = Records::new();
    for (i, (code, emits)) in rows.iter().enumerate() {
        let id = format!("f{i}");
        flow.nodes.push(function(&id, code));
        flow.edges.push(edge(&source.id, "value", &id, "trigger"));
        want.insert(
            id.clone(),
            emits
                .iter()
                .map(|e| {
                    let (t, v) = e.split_once(' ').expect("`<t> <value>`");
                    format!("{t} {}", expected(v))
                })
                .collect(),
        );
        functions.push(id);
    }
    let scenario = Scenario { name, flow, functions, script, until: 400 };
    check(&scenario, &want, &|id| format!("{:?}", rows[id[1..].parse::<usize>().expect("f<i>")].0));
}

/// A Function sends a value only when it differs from the one it holds: a
/// repeated result is not sent again, a first `false` is (the Node starts at
/// the number 0), a `NaN` is sent on every evaluation — and on no loop pass
/// in between.
#[test]
fn a_function_sends_a_result_when_it_differs_from_the_one_it_holds() {
    let rows: &[(&str, &[&str])] = &[
        ("return input > 500;", &["100 false", "300 true"]),
        ("return (input - input) / (input - input);", &["100 NaN", "200 NaN", "300 NaN"]),
        ("return Math.round(input / 200);", &["100 1", "300 5"]),
        ("return input > 500 ? 1 : 0;", &["300 1"]),
    ];
    let script = vec![(100, 14, 100), (200, 14, 200), (300, 14, 900)];
    fed_by("sensor-fed", &node("s", "Sensor", json!({ "pin": "A0" })), rows, script);
}

/// A Button's level reaches a Function as a boolean, as it does live: it
/// hands on a boolean, adds as a number, and is never `===` a number.
#[test]
fn a_boolean_input_stays_a_boolean() {
    let rows: &[(&str, &[&str])] = &[
        ("return input;", &["100 true", "200 false", "300 true"]),
        ("return input === 1;", &["100 false"]),
        ("return input === true;", &["100 true", "200 false", "300 true"]),
        ("return input == 1;", &["100 true", "200 false", "300 true"]),
        ("return input + 1;", &["100 2", "200 1", "300 2"]),
        ("return !input;", &["100 false", "200 true", "300 false"]),
        ("return input || 7;", &["100 true", "200 7", "300 true"]),
    ];
    // `input || 7` is a boolean on some inputs and a number on others: refused.
    let script = vec![(100, 2, 1), (200, 2, 0), (300, 2, 1)];
    let button = node("b", "Button", json!({ "pin": 2 }));
    let supported = &rows[..rows.len() - 1];
    fed_by("button-fed", &button, supported, script);
    let flow = FlowUpdate {
        nodes: vec![button, function("mixed", rows[rows.len() - 1].0)],
        edges: vec![edge("b", "value", "mixed", "trigger")],
    };
    let outcome = generate(&flow, &target_by_id("uno").expect("uno")).expect("never errors");
    assert!(outcome.problems.iter().any(|p| p.node_id == "mixed"), "{:?}", outcome.problems);
}

/// Code the board cannot run the way the live Node does is refused: the
/// sketch notes it and never evaluates it, generation warns with the reason,
/// and the Node never emits on the board. Where the live Node is silent too
/// (the code throws, or returns nothing), the two agree.
#[test]
fn code_the_board_cannot_run_alike_is_refused_with_a_warning() {
    let mut flow = FlowUpdate { nodes: vec![node("c", "Constant", json!({ "value": 7 }))], edges: Vec::new() };
    let mut functions = Vec::new();
    for (i, (code, _)) in REFUSED.iter().enumerate() {
        let id = format!("r{i}");
        flow.nodes.push(function(&id, code));
        flow.edges.push(edge("c", "value", &id, "trigger"));
        functions.push(id);
    }
    let scenario = Scenario { name: "refused", flow, functions, script: vec![], until: 5 };
    let (sketch, problems) = sketch_of(&scenario);
    for (i, (code, _)) in REFUSED.iter().enumerate() {
        let id = format!("r{i}");
        assert!(sketch.contains(&format!("// unsupported Function Node {id}:")), "{code:?} is noted:\n{sketch}");
        let warning = problems.iter().find(|p| p.node_id == id);
        assert!(
            warning.is_some_and(|p| p.severity == ProblemSeverity::Warning && p.message.contains("never emits")),
            "{code:?} is warned about: {warning:?}"
        );
    }
    if has_cxx() {
        let got = sketch_records(&scenario);
        assert_eq!(got, Records::new(), "a refused Function never emits on the board");
    }
    #[cfg(feature = "js")]
    {
        let live = live_records(&scenario);
        let wrong: Vec<String> = REFUSED
            .iter()
            .enumerate()
            .filter_map(|(i, (code, silent))| {
                let sent = live.get(&format!("r{i}"));
                (sent.is_none() != *silent).then(|| format!("{code:?}: live sends {sent:?}"))
            })
            .collect();
        assert_eq!(wrong, [] as [String; 0], "live silence differs from the table");
    }
}
