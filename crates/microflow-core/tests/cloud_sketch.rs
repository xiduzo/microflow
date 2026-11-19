//! What a networked Node puts on the wire when its Sketch runs — and that it
//! is, byte for byte, what the live Node sends.
//!
//! The live Mqtt node writes a number as Rust's `f64` Display, a boolean as
//! `true`/`false`; a design variable (Figma, Penpot) coerces what reaches its
//! `set` port to the variable's type and encodes it (`design_bridge`). The
//! sketch does this with the C++ blocks in `codegen::cloud::payload`.
//!
//! Two layers, each compiled for the host with `c++` against a stand-in for
//! the Arduino core (`String`, `WiFi`, `PubSubClient`):
//!
//! - the blocks themselves, fed many numbers, payloads and texts, against the
//!   live Mqtt and Figma nodes fed the same (with the `cloud` feature);
//! - whole ESP32 sketches — Constants, a Compare and a subscribe Mqtt node
//!   driving publish Mqtt and Figma nodes — whose publishes (topic and
//!   payload, repeats included) must be the live runtime's cloud requests.
//!
//! On the ESP32 a `double` is 64 bits, as on the host, so the comparison is
//! exact. Needs a C++ compiler on the PATH as `c++`; without one the
//! scenarios are skipped with a note.

use microflow_core::codegen::board::target_by_id;
use microflow_core::codegen::cloud::payload::{BRIDGE, NUMBER_TEXT};
use microflow_core::codegen::credentials::Credentials;
use microflow_core::codegen::generate_with_credentials;
use microflow_core::flow::{FlowEdge, FlowNode, FlowUpdate, Position};
use serde_json::json;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The Arduino core and the ESP32 network libraries, as far as these
/// Sketches need them. `PubSubClient::publish` prints `PUBLISH <topic>
/// <payload as hex>`; `loop()` delivers the scripted inbound messages due at
/// the current millisecond to a client subscribed to their topic.
const ARDUINO: &str = r#"
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>
typedef uint8_t byte;
static unsigned long host_millis = 0;
unsigned long millis() { return host_millis; }
void yield() {}
class String {
 public:
  String() {}
  String(const char* s) : s_(s ? s : "") {}
  String& operator=(const char* s) { s_ = s; return *this; }
  String& operator+=(const String& o) { s_ += o.s_; return *this; }
  String& operator+=(const char* o) { s_ += o; return *this; }
  String& operator+=(char c) { s_ += c; return *this; }
  bool operator==(const String& o) const { return s_ == o.s_; }
  bool operator!=(const String& o) const { return s_ != o.s_; }
  bool operator==(const char* o) const { return s_ == o; }
  const char* c_str() const { return s_.c_str(); }
  unsigned int length() const { return (unsigned int)s_.size(); }
  double toDouble() const { return atof(s_.c_str()); }
 private:
  std::string s_;
};
static void host_hex(const char* s, size_t n) {
  if (n == 0) { printf("-empty-"); }
  for (size_t i = 0; i < n; i++) { printf("%02x", (unsigned char)s[i]); }
}
static std::string host_unhex(const char* hex) {
  std::string out;
  for (; hex[0] && hex[1] && hex[0] != '\n'; hex += 2) {
    char pair[3] = {hex[0], hex[1], 0};
    out += (char)strtol(pair, 0, 16);
  }
  return out;
}
#define WL_CONNECTED 3
#define WIFI_STA 1
struct HostWiFi {
  int status() { return WL_CONNECTED; }
  void mode(int) {}
  void begin(const char*, const char*) {}
} WiFi;
class WiFiClient {};
struct HostMessage { unsigned long at; std::string topic; std::string payload; };
static std::vector<HostMessage> host_inbox;
class PubSubClient {
 public:
  explicit PubSubClient(WiFiClient&) {}
  void setServer(const char*, uint16_t) {}
  void setCallback(void (*callback)(char*, byte*, unsigned int)) { callback_ = callback; }
  bool connect(const char*) { connected_ = true; return true; }
  bool connect(const char*, const char*, const char*) { connected_ = true; return true; }
  bool connected() { return connected_; }
  bool subscribe(const char* topic) { topics_.push_back(topic); return true; }
  bool publish(const char* topic, const char* payload) {
    printf("PUBLISH %s ", topic);
    host_hex(payload, strlen(payload));
    printf("\n");
    return true;
  }
  bool loop() {
    for (size_t m = 0; m < host_inbox.size(); m++) {
      HostMessage& message = host_inbox[m];
      for (size_t t = 0; t < topics_.size(); t++) {
        if (message.at == host_millis && message.topic == topics_[t] && callback_) {
          std::string payload = message.payload;
          callback_((char*)message.topic.c_str(), (byte*)&payload[0], (unsigned int)payload.size());
        }
      }
    }
    return true;
  }
 private:
  bool connected_ = false;
  std::vector<std::string> topics_;
  void (*callback_)(char*, byte*, unsigned int) = 0;
};
"#;

/// A `main` for the payload blocks alone. `number`: each line is the bits of
/// a double (16 hex digits), printed as `mf_number_text`. `parse`: each line
/// a payload (hex), printed as the bits of `mf_payload_number`. `bridge`:
/// each line `<kind> <n|b|s> <value>` (a double's bits, 0/1, or a text in
/// hex), printed as the payload (hex) or `-` where nothing is sent.
const BLOCKS_MAIN: &str = r#"
int main(int argc, char** argv) {
  (void)argc;
  static char line[1 << 16];
  while (fgets(line, sizeof line, stdin)) {
    if (strcmp(argv[1], "number") == 0) {
      unsigned long long bits = strtoull(line, 0, 16);
      double x;
      memcpy(&x, &bits, sizeof x);
      printf("%s\n", mf_number_text(x).c_str());
    } else if (strcmp(argv[1], "parse") == 0) {
      std::string payload = host_unhex(line);
      double x = mf_payload_number(String(payload.c_str()));
      unsigned long long bits;
      memcpy(&bits, &x, sizeof bits);
      printf("%s\n", x != x ? "nan" : "");
      if (x == x) { printf("%016llx\n", bits); }
    } else {
      int kind = line[0] - '0';
      char type = line[2];
      const char* value = line + 4;
      String out;
      bool sent;
      if (type == 'n') {
        unsigned long long bits = strtoull(value, 0, 16);
        double x;
        memcpy(&x, &bits, sizeof x);
        sent = mf_bridge_number(kind, x, out);
      } else if (type == 'b') {
        sent = mf_bridge_bool(kind, value[0] == '1', out);
      } else {
        std::string text = host_unhex(value);
        sent = mf_bridge_text(kind, String(text.c_str()), out);
      }
      if (sent) { host_hex(out.c_str(), out.length()); } else { printf("-"); }
      printf("\n");
    }
  }
  return 0;
}
"#;

/// A `main` for a whole Sketch: `<boot ms> <until ms> [<at ms> <topic>
/// <payload hex>]...` — the messages the broker delivers, and when.
const SKETCH_MAIN: &str = r#"
#include "sketch.ino"

int main(int argc, char** argv) {
  const unsigned long boot = strtoul(argv[1], 0, 10);
  const unsigned long until = strtoul(argv[2], 0, 10);
  for (int i = 3; i + 2 < argc; i += 3) {
    HostMessage message = {boot + strtoul(argv[i], 0, 10), argv[i + 1], host_unhex(argv[i + 2])};
    host_inbox.push_back(message);
  }
  host_millis = boot;
  setup();
  for (unsigned long t = 1; t <= until; t++) {
    host_millis = boot + t;
    loop();
  }
  return 0;
}
"#;

fn has_cxx() -> bool {
    Command::new("c++").arg("--version").output().is_ok_and(|out| out.status.success())
}

fn hex(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "-empty-".to_string();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().concat()
}

/// Compile `source` (with the Arduino stand-in in front) in `dir`.
fn compile(dir: &Path, source: &str) -> PathBuf {
    std::fs::create_dir_all(dir).expect("create the scenario directory");
    std::fs::write(dir.join("host.cpp"), format!("{ARDUINO}\n{source}")).expect("write the host");
    // The libraries the Sketch includes are the stand-ins in front of it.
    for library in ["WiFi.h", "PubSubClient.h"] {
        std::fs::write(dir.join(library), "#pragma once\n").expect("write a library stand-in");
    }
    let program = dir.join("host");
    let compiled = Command::new("c++")
        .args(["-std=gnu++11", "-Wall", "-Wextra", "-Werror", "-Wno-unused-variable", "-Wno-unused-parameter"])
        .arg("-I")
        .arg(dir)
        .arg("-o")
        .arg(&program)
        .args(["-x", "c++"])
        .arg(dir.join("host.cpp"))
        .output()
        .expect("run c++");
    assert!(
        compiled.status.success(),
        "{}: does not compile:\n{}",
        dir.display(),
        String::from_utf8_lossy(&compiled.stderr)
    );
    program
}

/// Run the payload blocks in `mode` over `lines`; one output line each.
fn run_blocks(mode: &str, lines: &[String]) -> Vec<String> {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("cloud_sketch").join(format!("blocks-{mode}"));
    let program = compile(&dir, &format!("{NUMBER_TEXT}\n{BRIDGE}\n{BLOCKS_MAIN}"));
    let mut child = Command::new(&program)
        .arg(mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("run the blocks");
    let mut input = lines.join("\n");
    input.push('\n');
    let mut stdin = child.stdin.take().expect("stdin");
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()).expect("feed the blocks"));
    let out = child.wait_with_output().expect("the blocks run");
    writer.join().expect("fed");
    assert!(out.status.success(), "the blocks failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).expect("utf-8 output").lines().filter(|l| !l.is_empty()).map(str::to_string).collect()
}

/// The numbers the payload tests send: the edges of `f64`, every power of
/// two, short decimals, and a deterministic spread of bit patterns.
fn numbers() -> Vec<f64> {
    let mut out = vec![
        0.0, -0.0, 1.0, -1.0, 0.1, 0.2, 0.3, 0.1 + 0.2, -5e-324, -f64::MAX, 2f64.powi(-25), -(2f64.powi(-25)), 1.5, 2.5, 1.0 / 3.0, 2.0 / 3.0, 100.0, 1e15, 1e16, 1e21, 1e22,
        1e-5, 1e-7, 123_456_789.123, 9_007_199_254_740_993.0, f64::MAX, f64::MIN_POSITIVE, 5e-324,
        f64::EPSILON, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 255.0, 0.003_921_568_627_450_98,
    ];
    for exp in -1074..=1023 {
        out.push(2f64.powi(exp));
    }
    for k in 0..1000 {
        out.push(f64::from(k) / 1000.0);
        out.push(f64::from(k) * 0.37 - 150.0);
    }
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    for _ in 0..20_000 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let x = f64::from_bits(state);
        if x.is_finite() {
            out.push(x);
        }
    }
    out
}

/// The texts the coercion tests send: words, numbers with units, commas and
/// exponents, every colour form, and text that must be escaped.
#[cfg_attr(not(feature = "cloud"), allow(dead_code))]
fn texts() -> Vec<&'static str> {
    vec![
        "", " ", "true", "TRUE", " yes ", "si", "On", "off", "no", "0", "1", "2", "-0", "0.0", "abc", "12px",
        "90deg", "1,5", "1,5,6", " 3.25 ", ".5", "5.", "-.5", "+7", ".", "-", "1e3", "1e", "1e+", "1E-2",
        "1e400", "-1e400", "1e-400", "inf", "-inf", "NaN", "infinity", "0x1A", "#fff", "#FFF", "fff", "#ffff",
        "#ff8000", "#FF800080", "#12345", "#1234567", "#gggggg", "#", "rgb(255, 128, 0)", "RGB(255 128 0 / 0.5)",
        "rgba(255,0,0,0.25)", "rgb(255,0)", "rgb(1,2,3,4,5)", "rgb(a,b,c)", "rgb(300,-5,12px)", "rgba(", "rgb()",
        "rgb(10%,20%,30%)", "rgb(1,2,3", "hello \"world\"", "tab\there", "line\nbreak", "back\\slash",
        "\u{1}ctl\u{1f}", "\u{7f}", "h\u{e9}llo \u{2603}", "  padded  ", "-12.5e1x", "1.2.3", "007",
    ]
}

/// What the live node writes for a number, a payload and a set: the
/// reference every board output below is held to.
#[cfg(feature = "cloud")]
mod live {
    use microflow_core::flow::{FlowNode, FlowUpdate, Position};
    use microflow_core::runtime::{CloudRequestKind, ComponentValue, Effects, FlowRuntime};
    use serde_json::json;

    fn node(id: &str, kind: &str, data: serde_json::Value) -> FlowNode {
        FlowNode { id: id.to_string(), node_type: Some(kind.to_string()), data, position: Position { x: 0.0, y: 0.0 } }
    }

    pub fn payloads(effects: Effects) -> Vec<(String, Vec<u8>)> {
        effects
            .cloud_requests
            .into_iter()
            .filter_map(|request| match request.kind {
                CloudRequestKind::MqttPublish { topic, payload, .. } => Some((topic, payload)),
                _ => None,
            })
            .collect()
    }

    fn one_node(kind: &str, data: serde_json::Value) -> FlowRuntime {
        let mut runtime = FlowRuntime::new();
        let _ = runtime.update_flow(FlowUpdate { nodes: vec![node("n", kind, data)], edges: vec![] });
        runtime
    }

    /// The payload a publish Mqtt node sends for each value.
    pub fn mqtt_payloads(values: &[ComponentValue]) -> Vec<Vec<u8>> {
        let mut runtime = one_node("Mqtt", json!({ "direction": "publish", "brokerId": "b", "topic": "t" }));
        values
            .iter()
            .map(|value| {
                let mut sent = payloads(runtime.dispatch("n", "trigger", value.clone()));
                assert_eq!(sent.len(), 1, "one publish per trigger");
                sent.remove(0).1
            })
            .collect()
    }

    /// The number a subscribe Mqtt node hands on for each payload (what a
    /// number-reading port takes of it: no number is 0).
    pub fn mqtt_numbers(payloads: &[Vec<u8>]) -> Vec<f64> {
        let mut runtime = one_node("Mqtt", json!({ "direction": "subscribe", "brokerId": "b", "topic": "t" }));
        payloads
            .iter()
            .map(|payload| {
                let effects = runtime.deliver_message("n", "t", payload);
                let event = effects.component_events.iter().find(|e| e.source_handle.as_ref() == "value");
                event.expect("every message is emitted").value.as_number().unwrap_or(0.0)
            })
            .collect()
    }

    /// The payload a design variable of `resolved_type` publishes for each
    /// value set on it, or `None` where it publishes nothing.
    pub fn bridge_payloads(resolved_type: &str, values: &[ComponentValue]) -> Vec<Option<Vec<u8>>> {
        let mut runtime = one_node(
            "Figma",
            json!({ "brokerId": "b", "uniqueId": "u", "variableId": "VariableID:1:2", "resolvedType": resolved_type }),
        );
        values
            .iter()
            .map(|value| {
                let mut sent = payloads(runtime.dispatch("n", "set", value.clone()));
                assert!(sent.len() <= 1, "at most one publish per set: {sent:?}");
                sent.pop().map(|(_, payload)| payload)
            })
            .collect()
    }
}

/// The board writes every number as the live Mqtt node does: the same
/// shortest round-trip digits, never `1.00`, never an exponent.
#[test]
fn a_number_is_sent_as_the_live_node_writes_it() {
    if !has_cxx() {
        eprintln!("skipped: no `c++` on the PATH");
        return;
    }
    let numbers = numbers();
    let lines: Vec<String> = numbers.iter().map(|x| format!("{:016x}", x.to_bits())).collect();
    let board = run_blocks("number", &lines);
    let display: Vec<String> = numbers.iter().map(ToString::to_string).collect();
    let differ: Vec<String> = board
        .iter()
        .zip(&display)
        .filter(|(b, d)| b != d)
        .take(10)
        .map(|(b, d)| format!("board {b}, live {d}"))
        .collect();
    assert_eq!(board.len(), display.len(), "one line per number");
    assert_eq!(differ, [] as [String; 0]);
    assert_eq!(&board[..2], ["0", "-0"]);
    // A sum that is not 0.3, a tie Display rounds up, the smallest and
    // largest doubles: each as the live node writes it.
    for edge in ["0.30000000000000004", "0.000000029802322387695313", "-0.000000029802322387695313"] {
        assert!(board.iter().any(|b| b == edge), "{edge}");
    }
    let tiny = format!("-0.{}5", "0".repeat(323));
    let huge = format!("-17976931348623157{}", "0".repeat(292));
    assert!(board.contains(&tiny) && board.contains(&huge), "the extremes of f64");

    #[cfg(feature = "cloud")]
    {
        use microflow_core::runtime::ComponentValue;
        let sample: Vec<f64> = numbers.iter().copied().step_by(37).collect();
        let live = live::mqtt_payloads(&sample.iter().map(|x| ComponentValue::Number(*x)).collect::<Vec<_>>());
        let expected: Vec<Vec<u8>> = sample.iter().map(|x| x.to_string().into_bytes()).collect();
        assert_eq!(live, expected, "the live Mqtt node writes a number as its Display");
        let words = live::mqtt_payloads(&[ComponentValue::Bool(true), ComponentValue::Bool(false)]);
        assert_eq!(words, [b"true".to_vec(), b"false".to_vec()]);
    }
}

/// A received Mqtt payload is the number the live node reads from it.
#[cfg(feature = "cloud")]
#[test]
fn a_received_payload_is_the_number_the_live_node_reads() {
    if !has_cxx() {
        eprintln!("skipped: no `c++` on the PATH");
        return;
    }
    let mut payloads: Vec<Vec<u8>> = texts().iter().map(|t| t.as_bytes().to_vec()).collect();
    payloads.extend(["false", "+3", "-0", "1.", "+inf", "-infinity", "nan", "1_0", "1e5 "].map(|t| t.as_bytes().to_vec()));
    payloads.extend(numbers().iter().step_by(11).map(|x| x.to_string().into_bytes()));
    payloads.retain(|p| !p.is_empty());
    let lines: Vec<String> = payloads.iter().map(|p| hex(p)).collect();
    let board = run_blocks("parse", &lines);
    let live: Vec<String> = live::mqtt_numbers(&payloads)
        .iter()
        .map(|x| if x.is_nan() { "nan".to_string() } else { format!("{:016x}", x.to_bits()) })
        .collect();
    let differ: Vec<String> = board
        .iter()
        .zip(&live)
        .zip(&payloads)
        .filter(|((b, l), _)| b != l)
        .map(|((b, l), p)| format!("{:?}: board {b}, live {l}", String::from_utf8_lossy(p)))
        .collect();
    assert_eq!(board.len(), live.len(), "one line per payload");
    assert_eq!(differ, [] as [String; 0]);
}

/// A value set on a design variable is coerced to the variable's type and
/// sent with the payload the live node writes — or not sent where the live
/// node drops it — for a boolean, a number and a text, into every kind.
#[cfg(feature = "cloud")]
#[test]
fn a_value_set_on_a_design_variable_is_sent_as_the_live_node_sends_it() {
    use microflow_core::runtime::ComponentValue;
    if !has_cxx() {
        eprintln!("skipped: no `c++` on the PATH");
        return;
    }
    let mut values: Vec<ComponentValue> = vec![ComponentValue::Bool(true), ComponentValue::Bool(false)];
    values.extend(numbers().iter().step_by(23).map(|x| ComponentValue::Number(*x)));
    values.extend([f64::NAN, f64::INFINITY, -0.0, 0.0, 2.5, 0.1].map(ComponentValue::Number));
    values.extend(texts().iter().map(|t| ComponentValue::String((*t).to_string())));

    let mut differ = Vec::new();
    for (code, resolved_type) in [(0, "BOOLEAN"), (1, "FLOAT"), (2, "COLOR"), (3, "STRING"), (3, "EASING")] {
        let lines: Vec<String> = values
            .iter()
            .map(|value| match value {
                ComponentValue::Number(x) => format!("{code} n {:016x}", x.to_bits()),
                ComponentValue::Bool(b) => format!("{code} b {}", u8::from(*b)),
                ComponentValue::String(s) => format!("{code} s {}", if s.is_empty() { String::new() } else { hex(s.as_bytes()) }),
                other => panic!("not sent here: {other:?}"),
            })
            .collect();
        let board = run_blocks("bridge", &lines);
        let live: Vec<String> = live::bridge_payloads(resolved_type, &values)
            .iter()
            .map(|payload| payload.as_ref().map_or_else(|| "-".to_string(), |p| hex(p)))
            .collect();
        assert_eq!(board.len(), live.len(), "{resolved_type}: one line per value");
        for ((b, l), value) in board.iter().zip(&live).zip(&values) {
            if b != l {
                differ.push(format!("{resolved_type} {value:?}: board {b}, live {l}"));
            }
        }
    }
    assert_eq!(differ, [] as [String; 0]);
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

/// Constants, a Compare and a subscribe Mqtt node, each driving a publish
/// Mqtt node or a design variable of each type; and the messages the broker
/// delivers to the subscribe node (`(at ms, payload)`, a repeat included).
fn cloud_flow() -> (FlowUpdate, Vec<(u32, &'static str)>) {
    let constants = [0.1, 1.0, -0.0, 2.5, 1.0 / 3.0, 123_456_789.123, 1e-7, 1e15, 1e21, -9.3e18, f64::MAX];
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    for (i, value) in constants.iter().enumerate() {
        let constant = format!("c-{i}");
        let publish = format!("pub-{i}");
        nodes.push(node(&constant, "Constant", json!({ "value": value })));
        nodes.push(node(&publish, "Mqtt", json!({ "direction": "publish", "topic": format!("out/{i}") })));
        edges.push(edge(&constant, "value", &publish, "trigger"));
    }
    for (i, resolved_type) in ["BOOLEAN", "FLOAT", "COLOR", "STRING"].iter().enumerate() {
        let variable = format!("var-{i}");
        nodes.push(node(
            &variable,
            "Figma",
            json!({ "uniqueId": "u", "variableId": format!("VariableID:1:{i}"), "resolvedType": resolved_type }),
        ));
        edges.push(edge("c-0", "value", &variable, "set"));
        edges.push(edge("c-3", "value", &variable, "set"));
    }
    nodes.push(node("cmp", "Compare", json!({ "validator": "number", "subValidator": "greater than", "number": 0.5 })));
    nodes.push(node("pub-bool", "Mqtt", json!({ "direction": "publish", "topic": "out/bool" })));
    edges.push(edge("c-3", "value", "cmp", "value"));
    edges.push(edge("cmp", "true", "pub-bool", "trigger"));
    nodes.push(node("mon", "Monitor", json!({ "uniqueId": "u", "broker": "broker.example.invalid", "wifiSsid": "net" })));
    edges.push(edge("c-4", "value", "mon", "value"));
    nodes.push(node("sub", "Mqtt", json!({ "direction": "subscribe", "topic": "in" })));
    nodes.push(node("echo", "Mqtt", json!({ "direction": "publish", "topic": "out/echo" })));
    edges.push(edge("sub", "value", "echo", "trigger"));
    let messages = vec![(10, "12.50"), (11, "12.50"), (12, "1e3"), (13, "-0"), (14, ".5"), (15, "inf"), (16, "+3"), (17, "1.")];
    (FlowUpdate { nodes, edges }, messages)
}

/// What the generated ESP32 Sketch publishes, sorted: `topic payload-hex`.
fn sketch_publishes(flow: &FlowUpdate, messages: &[(u32, &str)]) -> Vec<String> {
    let credentials = Credentials {
        wifi_ssid: "net".into(),
        wifi_password: "pass".into(), // ggignore — fake test credential
        broker_host: "broker.example.invalid".into(),
        ..Credentials::default()
    };
    let outcome = generate_with_credentials(flow, &target_by_id("esp32").expect("the ESP32 is supported"), Some(&credentials))
        .expect("never errors");
    let sketch = outcome.sketch.unwrap_or_else(|| panic!("no sketch: {:?}", outcome.problems));
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("cloud_sketch").join("flow");
    std::fs::create_dir_all(&dir).expect("create the scenario directory");
    std::fs::write(dir.join("sketch.ino"), &sketch).expect("write the sketch");
    let program = compile(&dir, SKETCH_MAIN);
    let mut run = Command::new(&program);
    run.arg("1000").arg("100");
    for (at, payload) in messages {
        run.arg(at.to_string()).arg("in").arg(hex(payload.as_bytes()));
    }
    let out = run.output().expect("run the compiled sketch");
    assert!(out.status.success(), "the compiled sketch failed: {}", String::from_utf8_lossy(&out.stderr));
    let mut lines: Vec<String> = String::from_utf8(out.stdout)
        .expect("utf-8 output")
        .lines()
        .filter_map(|l| l.strip_prefix("PUBLISH ").map(str::to_string))
        .collect();
    lines.sort();
    lines
}

/// A flow's publishes on the board are the live runtime's, payload for
/// payload: numbers as Display, `true` from a Compare, a design variable's
/// value coerced to its type (nothing for a colour variable set to a number),
/// and each received message passed on, a repeat included.
#[test]
fn a_flow_publishes_on_the_board_what_it_publishes_live() {
    if !has_cxx() {
        eprintln!("skipped: no `c++` on the PATH");
        return;
    }
    let (flow, messages) = cloud_flow();
    let board = sketch_publishes(&flow, &messages);
    assert!(board.contains(&format!("out/0 {}", hex(b"0.1"))), "a number as Display: {board:?}");
    assert!(board.contains(&format!("out/bool {}", hex(b"true"))), "a boolean as a word: {board:?}");
    assert!(
        board.contains(&format!("microflow/u/monitor/mon {}", hex(b"0.3333333333333333"))),
        "a Monitor shows a number as live does: {board:?}"
    );

    #[cfg(feature = "cloud")]
    {
        use microflow_core::runtime::FlowRuntime;
        let mut runtime = FlowRuntime::new();
        let started = runtime.update_flow(flow.clone());
        // A Monitor publishes on the board what it shows live, as text.
        let shown: Vec<(String, Vec<u8>)> = started
            .component_events
            .iter()
            .filter(|e| e.source.as_ref() == "mon" && e.source_handle.as_ref() == "value")
            .map(|e| ("microflow/u/monitor/mon".to_string(), e.value.as_number().expect("a number").to_string().into_bytes()))
            .collect();
        assert_eq!(shown.len(), 1, "the Monitor shows the Constant once");
        let mut live = live::payloads(started);
        live.extend(shown);
        for (_, payload) in &messages {
            live.extend(live::payloads(runtime.deliver_message("sub", "in", payload.as_bytes())));
        }
        let mut live: Vec<String> = live.iter().map(|(topic, payload)| format!("{topic} {}", hex(payload))).collect();
        live.sort();
        assert_eq!(board, live, "the sketch (left) and the live runtime (right) publish differently");
    }
}
