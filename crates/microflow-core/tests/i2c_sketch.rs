//! What an I2C Device hands on when its Sketch runs — and that it is what the
//! live Node emits for the same replies.
//!
//! The documented contract (`i2c-device.mdx`): *Unsigned int* is the bytes
//! combined big-endian into one positive number, *Signed int* the same as a
//! two's-complement number; both fold at most four bytes (`fold_bytes`). A
//! reply shorter than the bytes asked for is a failed read: the live node
//! keeps its last value (and shows a diagnostic), it does not decode the
//! bytes that came.
//!
//! Each scenario generates the Sketch of an I2C Device wired into two
//! Counters — one counting its emissions, one keeping the last value — and
//! compiles it for the host against a stand-in for the Arduino core and the
//! `Wire` library, whose device answers each read with the bytes the script
//! gives it from then on (fewer than asked for: a short read). `long` is 32
//! bits there, as on the AVR and the ESP32. The Sketch reads every sampling
//! interval; with the `runtime` feature the live Node gets the same bytes as
//! a Firmata `I2C_REPLY` at the same milliseconds, and its `value` emissions
//! must come at the same milliseconds with the same values.
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
/// The sampling interval every scenario reads at.
const INTERVAL_MS: u32 = 100;

/// The Arduino core and `Wire`, as far as these Sketches need them, and a
/// `main` that plays `<boot ms> <until ms> [<at ms> <reply hex|->]...` and
/// prints `<ms> <value>` each time the counting Counter moves.
const HOST: &str = r#"
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static unsigned long host_millis = 0;
unsigned long millis() { return host_millis; }
static uint8_t host_reply[64];
static size_t host_reply_length = 0;
struct HostWire {
  uint8_t buffer[64];
  size_t length = 0;
  size_t position = 0;
  void begin() {}
  void beginTransmission(uint8_t) {}
  size_t write(uint8_t) { return 1; }
  uint8_t endTransmission(bool = true) { return 0; }
  uint8_t requestFrom(uint8_t, uint8_t quantity) {
    length = host_reply_length < quantity ? host_reply_length : quantity;
    memcpy(buffer, host_reply, length);
    position = 0;
    return (uint8_t)length;
  }
  int available() { return (int)(length - position); }
  int read() { return position < length ? buffer[position++] : -1; }
} Wire;

// The AVR and the ESP32 have a 32-bit long.
#define long int
#include "sketch.ino"
#undef long

int main(int argc, char** argv) {
  const unsigned long boot = strtoul(argv[1], 0, 10);
  const unsigned long until = strtoul(argv[2], 0, 10);
  host_millis = boot;
  setup();
  double counted = 0.0;
  for (unsigned long t = 0; t <= until; t++) {
    host_millis = boot + t;
    for (int i = 3; i + 1 < argc; i += 2) {
      if (strtoul(argv[i], 0, 10) == t) {
        const char* hex = argv[i + 1];
        host_reply_length = 0;
        for (; hex[0] && hex[1]; hex += 2) {
          char pair[3] = {hex[0], hex[1], 0};
          host_reply[host_reply_length++] = (uint8_t)strtol(pair, 0, 16);
        }
      }
    }
    loop();
    if (counter_rec_n_count != counted) {
      counted = counter_rec_n_count;
      printf("%lu %.1f\n", t, counter_rec_v_count);
    }
  }
  return 0;
}
"#;

const WIRE_H: &str = "#pragma once\n";

struct Scenario {
    name: &'static str,
    /// The I2C Device's settings (its id is `in`).
    data: serde_json::Value,
    /// `(at ms, bytes)`: what the device answers each read from then on.
    script: Vec<(u32, Vec<u8>)>,
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

fn flow(scenario: &Scenario) -> FlowUpdate {
    FlowUpdate {
        nodes: vec![
            node("in", "I2cDevice", scenario.data.clone()),
            node("rec-n", "Counter", json!({})),
            node("rec-v", "Counter", json!({})),
        ],
        edges: vec![edge("in", "value", "rec-n", "increment"), edge("in", "value", "rec-v", "set")],
    }
}

fn sketch_records(scenario: &Scenario) -> Vec<String> {
    let outcome = generate(&flow(scenario), &target_by_id("uno").expect("the Uno is supported")).expect("never errors");
    let sketch = outcome.sketch.unwrap_or_else(|| panic!("no sketch: {:?}", outcome.problems));
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("i2c_sketch").join(scenario.name);
    std::fs::create_dir_all(&dir).expect("create the scenario directory");
    std::fs::write(dir.join("sketch.ino"), &sketch).expect("write the sketch");
    std::fs::write(dir.join("Wire.h"), WIRE_H).expect("write the Wire stand-in");
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
    for (at, bytes) in &scenario.script {
        let hex = bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().concat();
        run.arg(at.to_string()).arg(if hex.is_empty() { "-".to_string() } else { hex });
    }
    let out = run.output().expect("run the compiled sketch");
    assert!(out.status.success(), "the compiled sketch failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).expect("utf-8 output").lines().map(str::to_string).collect()
}

/// The live I2C Device fed the same bytes, as `I2C_REPLY` frames, on the
/// milliseconds the Sketch reads.
#[cfg(feature = "runtime")]
fn live_records(scenario: &Scenario) -> Vec<String> {
    use microflow_core::runtime::FlowRuntime;

    let mut runtime = FlowRuntime::new();
    let _ = runtime.update_flow(flow(scenario));
    let address = scenario.data["address"].as_u64().map_or(0x48, |a| u8::try_from(a).expect("a 7-bit address"));
    let register = scenario.data["register"].as_u64().map_or(0, |r| u8::try_from(r).expect("a register"));
    let mut reply: &[u8] = &[];
    let mut records = Vec::new();
    for now in 0..=scenario.until {
        runtime.set_now(f64::from(now));
        if let Some((_, bytes)) = scenario.script.iter().find(|(at, _)| *at == now) {
            reply = bytes;
        }
        if now == 0 || now % INTERVAL_MS != 0 {
            continue;
        }
        let mut frame = vec![0xF0, 0x77, address & 0x7F, address >> 7, register & 0x7F, register >> 7];
        for byte in reply {
            frame.extend([byte & 0x7F, byte >> 7]);
        }
        frame.push(0xF7);
        for event in runtime.feed_bytes(&frame).component_events {
            if event.source.as_ref() == "in" && event.source_handle.as_ref() == "value" {
                let value = event.value.as_number().expect("a number");
                records.push(format!("{now} {value:.1}"));
            }
        }
    }
    records
}

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

fn scenario(name: &'static str, output: &str, read_length: u8, script: Vec<(u32, Vec<u8>)>) -> Scenario {
    Scenario {
        name,
        data: json!({ "address": 0x48, "register": 0x05, "readLength": read_length, "output": output, "freq": INTERVAL_MS }),
        script,
        until: 1000,
    }
}

/// Two bytes, unsigned: big-endian, positive. A short or an empty reply
/// keeps the value the device last gave.
#[test]
fn an_unsigned_reading_is_kept_through_a_short_read() {
    let Some(seen) = records(&scenario(
        "unsigned-2",
        "unsigned_int",
        2,
        vec![(0, vec![0x01, 0x02]), (150, vec![0x12]), (250, vec![0xFF, 0xFF]), (350, vec![]), (450, vec![0x00, 0x2A])],
    )) else {
        return;
    };
    assert_eq!(seen, ["100 258.0", "300 65535.0", "500 42.0"]);
}

/// Two bytes, signed: two's complement from the first byte's top bit.
#[test]
fn a_signed_reading_is_twos_complement_and_kept_through_a_short_read() {
    let Some(seen) = records(&scenario(
        "signed-2",
        "signed_int",
        2,
        vec![(0, vec![0xFF, 0xFF]), (150, vec![0x80, 0x00]), (250, vec![0xFF]), (350, vec![0x7F, 0xFF])],
    )) else {
        return;
    };
    assert_eq!(seen, ["100 -1.0", "200 -32768.0", "400 32767.0"]);
}

/// Four bytes: unsigned is positive up to 4294967295, signed spans the
/// whole 32-bit range — on a board whose `long` is 32 bits.
#[test]
fn a_four_byte_reading_fills_the_32_bit_range() {
    let Some(seen) = records(&scenario(
        "unsigned-4",
        "unsigned_int",
        4,
        vec![(0, vec![0xFF, 0xFF, 0xFF, 0xFF]), (150, vec![0x80, 0, 0, 0])],
    )) else {
        return;
    };
    assert_eq!(seen, ["100 4294967295.0", "200 2147483648.0"]);
    let Some(seen) = records(&scenario(
        "signed-4",
        "signed_int",
        4,
        vec![(0, vec![0xFF, 0xFF, 0xFF, 0xFE]), (150, vec![0x80, 0, 0, 0]), (250, vec![0x7F, 0xFF, 0xFF, 0xFF])],
    )) else {
        return;
    };
    assert_eq!(seen, ["100 -2.0", "200 -2147483648.0", "300 2147483647.0"]);
}

/// Three bytes, signed; six bytes, unsigned: the first four fold in, and a
/// reply of five is a short read.
#[test]
fn odd_lengths_sign_extend_and_cap_like_the_live_fold() {
    let Some(seen) = records(&scenario(
        "signed-3",
        "signed_int",
        3,
        vec![(0, vec![0xFF, 0xFF, 0xFF]), (150, vec![0x80, 0, 0])],
    )) else {
        return;
    };
    assert_eq!(seen, ["100 -1.0", "200 -8388608.0"]);
    let Some(seen) = records(&scenario(
        "unsigned-6",
        "unsigned_int",
        6,
        vec![(0, vec![1, 2, 3, 4, 5, 6]), (150, vec![9, 9, 9, 9, 9]), (250, vec![0, 0, 0, 1, 7, 7])],
    )) else {
        return;
    };
    assert_eq!(seen, ["100 16909060.0", "300 1.0"]);
}
