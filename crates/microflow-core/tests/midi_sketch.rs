//! What a Midi node hands on and sends when its Sketch runs — and that it is
//! what the live node emits and sends.
//!
//! An in-node's handles each feed two Counters (one counting emissions, one
//! keeping the value); the Sketch is compiled for the host against a
//! stand-in for the Arduino core and the MIDI library, whose jack delivers
//! the scripted messages, one per loop pass, as the library reports them
//! (a note-on at velocity 0 reads as a note-off). With the `cloud` feature
//! the live node gets the same messages from a host port, and its emissions
//! must come at the same milliseconds with the same values — including the
//! handles it does not emit (a note-mode node's `value`).
//!
//! An out-node is driven by Constants; the messages the Sketch sends must be
//! the live node's `MidiSend` bytes.
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

/// The Arduino core and the MIDI library, as far as these Sketches need them.
/// `main` plays `<boot ms> <until ms> [<at ms> <status> <data1> <data2>]...`;
/// `RECORD` prints the moved Counters after each loop pass.
const HOST: &str = r#"
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef uint8_t byte;
#define constrain(amt, low, high) ((amt) < (low) ? (low) : ((amt) > (high) ? (high) : (amt)))
static unsigned long host_millis = 0;
static unsigned long host_boot = 0;
unsigned long millis() { return host_millis; }
#define MIDI_CHANNEL_OMNI 0
struct HostMessage { unsigned long at; int status; int data1; int data2; };
static HostMessage host_messages[64];
static int host_message_count = 0;
static int host_next = 0;
struct HostMidi {
  int type = 0, channel = 0, data1 = 0, data2 = 0;
  void begin(int) {}
  void turnThruOff() {}
  bool read() {
    if (host_next >= host_message_count || host_messages[host_next].at > host_millis) { return false; }
    HostMessage& m = host_messages[host_next++];
    type = m.status & 0xF0;
    channel = (m.status & 0x0F) + 1;
    data1 = m.data1;
    data2 = m.data2;
    if (type == 0x90 && data2 == 0) { type = 0x80; }
    return true;
  }
  int getType() { return type; }
  int getChannel() { return channel; }
  int getData1() { return data1; }
  int getData2() { return data2; }
  void sendNoteOn(int note, int velocity, int channel) { printf("%lu send %02x %02x %02x\n", host_millis - host_boot, 0x90 | (channel - 1), note, velocity); }
  void sendNoteOff(int note, int velocity, int channel) { printf("%lu send %02x %02x %02x\n", host_millis - host_boot, 0x80 | (channel - 1), note, velocity); }
  void sendControlChange(int control, int value, int channel) { printf("%lu send %02x %02x %02x\n", host_millis - host_boot, 0xB0 | (channel - 1), control, value); }
};
#define MIDI_CREATE_DEFAULT_INSTANCE() HostMidi MIDI

#include "sketch.ino"

int main(int argc, char** argv) {
  const unsigned long boot = strtoul(argv[1], 0, 10);
  const unsigned long until = strtoul(argv[2], 0, 10);
  for (int i = 3; i + 3 < argc; i += 4) {
    HostMessage m = {boot + strtoul(argv[i], 0, 10), (int)strtol(argv[i + 1], 0, 16), atoi(argv[i + 2]), atoi(argv[i + 3])};
    host_messages[host_message_count++] = m;
  }
  host_millis = boot;
  host_boot = boot;
  setup();
  RECORD_STATE
  for (unsigned long t = 0; t <= until; t++) {
    host_millis = boot + t;
    loop();
    RECORD
  }
  return 0;
}
"#;

const MIDI_H: &str = "#pragma once\n";

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

/// A Midi node (`midi`), its `handles` each wired into a counting and a
/// keeping Counter, and Constants (with these values) wired into `send`.
fn flow(data: &serde_json::Value, handles: &[&str], sends: &[f64]) -> FlowUpdate {
    let mut nodes = vec![node("midi", "Midi", data.clone())];
    let mut edges = Vec::new();
    for handle in handles {
        nodes.push(node(&format!("n-{handle}"), "Counter", json!({})));
        nodes.push(node(&format!("v-{handle}"), "Counter", json!({})));
        edges.push(edge("midi", handle, &format!("n-{handle}"), "increment"));
        edges.push(edge("midi", handle, &format!("v-{handle}"), "set"));
    }
    for (i, value) in sends.iter().enumerate() {
        nodes.push(node(&format!("c-{i}"), "Constant", json!({ "value": value })));
        edges.push(edge(&format!("c-{i}"), "value", "midi", "send"));
    }
    FlowUpdate { nodes, edges }
}

/// What the compiled Sketch records: `<ms> <handle> <value>` per emission
/// and `<ms> send <bytes>` per message sent, sorted.
fn sketch_records(name: &str, flow: &FlowUpdate, handles: &[&str], messages: &[(u32, u8, u8, u8)], until: u32) -> Vec<String> {
    let outcome = generate(flow, &target_by_id("uno").expect("the Uno is supported")).expect("never errors");
    let sketch = outcome.sketch.unwrap_or_else(|| panic!("no sketch: {:?}", outcome.problems));
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("midi_sketch").join(name);
    std::fs::create_dir_all(&dir).expect("create the scenario directory");
    std::fs::write(dir.join("sketch.ino"), &sketch).expect("write the sketch");
    std::fs::write(dir.join("MIDI.h"), MIDI_H).expect("write the MIDI stand-in");
    let state = handles.iter().map(|h| format!("double seen_{h} = 0.0;")).collect::<Vec<_>>().concat();
    let record = handles
        .iter()
        .map(|h| {
            let token = h.replace('-', "_");
            format!(
                "if (counter_n_{token}_count != seen_{h}) {{ seen_{h} = counter_n_{token}_count; printf(\"%lu {h} %.1f\\n\", t, counter_v_{token}_count); }}"
            )
        })
        .collect::<Vec<_>>()
        .concat();
    let host = HOST.replace("RECORD_STATE", &state).replace("RECORD", &record);
    std::fs::write(dir.join("host.cpp"), host).expect("write the host");
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
        "{name}: the generated sketch does not compile:\n{}\n{sketch}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let mut run = Command::new(&program);
    run.arg(BOOT_MS.to_string()).arg(until.to_string());
    for (at, status, data1, data2) in messages {
        run.arg(at.to_string()).arg(format!("{status:02x}")).arg(data1.to_string()).arg(data2.to_string());
    }
    let out = run.output().expect("run the compiled sketch");
    assert!(out.status.success(), "the compiled sketch failed: {}", String::from_utf8_lossy(&out.stderr));
    let mut lines: Vec<String> = String::from_utf8(out.stdout)
        .expect("utf-8 output")
        .lines()
        .map(|line| {
            let (at, rest) = line.split_once(' ').expect("a ms first");
            // The Sketch's first pass is at 0, the live start; sort by time.
            format!("{:05} {rest}", at.parse::<u32>().expect("a ms"))
        })
        .collect();
    lines.sort();
    lines
}

/// The same through the live runtime: messages from a host port at their
/// milliseconds, Constants at the start.
#[cfg(feature = "cloud")]
fn live_records(flow: &FlowUpdate, handles: &[&str], messages: &[(u32, u8, u8, u8)]) -> Vec<String> {
    use microflow_core::runtime::{CloudRequestKind, Effects, FlowRuntime};

    fn record(effects: Effects, at: u32, handles: &[&str], out: &mut Vec<String>) {
        for event in effects.component_events {
            if event.source.as_ref() == "midi" && handles.contains(&event.source_handle.as_ref()) {
                let value = event.value.as_number().expect("a number or a boolean");
                out.push(format!("{at:05} {} {value:.1}", event.source_handle));
            }
        }
        for request in effects.cloud_requests {
            if let CloudRequestKind::MidiSend { bytes, .. } = request.kind {
                let bytes: Vec<String> = bytes.iter().map(|b| format!("{b:02x}")).collect();
                out.push(format!("{at:05} send {}", bytes.join(" ")));
            }
        }
    }

    let mut runtime = FlowRuntime::new();
    let mut out = Vec::new();
    record(runtime.update_flow(flow.clone()), 0, handles, &mut out);
    for &(at, status, data1, data2) in messages {
        record(runtime.dispatch_midi_message("Jack", &[status, data1, data2]), at, handles, &mut out);
    }
    out.sort();
    out
}

fn records(name: &str, data: &serde_json::Value, handles: &[&str], sends: &[f64], messages: &[(u32, u8, u8, u8)]) -> Option<Vec<String>> {
    if !has_cxx() {
        eprintln!("skipped {name}: no `c++` on the PATH to compile the generated sketch with");
        return None;
    }
    let flow = flow(data, handles, sends);
    let sketch = sketch_records(name, &flow, handles, messages, 200);
    #[cfg(feature = "cloud")]
    assert_eq!(sketch, live_records(&flow, handles, messages), "{name}: the sketch (left) and the live runtime (right) disagree");
    Some(sketch)
}

/// A note-mode in-node emits `note`, `velocity` and `on` or `off` for every
/// message on its channel, a repeat included — and never `value`, which the
/// live node does not emit in note mode and the editor does not draw.
#[test]
fn a_note_in_node_emits_its_notes_and_no_value() {
    let messages = [(10, 0x92, 60, 100), (20, 0x92, 60, 100), (30, 0x82, 60, 64), (40, 0x92, 62, 0), (50, 0x91, 64, 90), (60, 0x92, 65, 30)];
    let Some(seen) = records(
        "note-in",
        &json!({ "direction": "in", "mode": "note", "channel": 3 }),
        &["note", "velocity", "on", "off", "value"],
        &[],
        &messages,
    ) else {
        return;
    };
    assert!(!seen.iter().any(|line| line.contains(" value ")), "no `value` in note mode: {seen:?}");
    assert_eq!(seen.iter().filter(|line| line.contains(" on ")).count(), 3, "{seen:?}");
}

/// A cc-mode in-node emits its control's value when it changes.
#[test]
fn a_cc_in_node_emits_its_controls_value_when_it_changes() {
    let messages = [(10, 0xB0, 7, 99), (20, 0xB0, 7, 99), (30, 0xB0, 1, 50), (40, 0xB0, 7, 0)];
    let Some(seen) = records("cc-in", &json!({ "direction": "in", "mode": "cc", "control": 7 }), &["value"], &[], &messages) else {
        return;
    };
    assert_eq!(seen, ["00010 value 99.0", "00040 value 0.0"]);
}

/// An out-node sends what the live node sends: a control change rounded and
/// clamped to 0–127 (a value far out of range included), a note on for a
/// truthy value and a note off for a falsy one.
#[test]
fn an_out_node_sends_what_the_live_node_sends() {
    let sends = [300.0, -5.0, 63.5, 126.4, 1e10, -1e10, 0.49];
    let Some(seen) = records("cc-out", &json!({ "direction": "out", "mode": "cc", "control": 7, "channel": 2 }), &[], &sends, &[]) else {
        return;
    };
    assert_eq!(seen.len(), sends.len(), "{seen:?}");
    let Some(seen) = records(
        "note-out",
        &json!({ "direction": "out", "mode": "note", "note": 64, "velocity": 90 }),
        &[],
        &[1.0, 0.0],
        &[],
    ) else {
        return;
    };
    assert_eq!(seen, ["00000 send 80 40 00", "00000 send 90 40 5a"]);
}
