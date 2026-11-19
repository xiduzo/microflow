//! What a generated Delay does when its Sketch runs — and that it is what the
//! live Delay does.
//!
//! The emitter's unit tests pin the *shape* of the C++; this runs it. Each
//! scenario generates the Sketch of a `Sensor → Delay` flow, compiles it for
//! the host against a stand-in for the Arduino core (a clock and an analog
//! level the test scripts), steps `loop()` once per millisecond, and records
//! every loop iteration on which the Delay's `fired` flag is up, with the
//! value it carries. A change of the sensor's reading is a trigger, as it is on
//! the device.
//!
//! With the `runtime` feature the same triggers go through the live Delay
//! (`FlowRuntime`, with a host loop that arms its wakeups on the same
//! millisecond clock), and the two must fire at the same times with the same
//! values.
//!
//! Needs a C++ compiler on the PATH as `c++`; without one the scenarios are
//! skipped with a note (the Rust-only tests in `nodes/delay/` still run).

use microflow_core::codegen::board::target_by_id;
use microflow_core::codegen::generate;
use microflow_core::flow::{FlowEdge, FlowNode, FlowUpdate, Position};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;

/// `(ms since the start, value)`: a trigger arriving, or the Delay firing.
type At = (u32, i32);

/// How many triggers a queue holds (`nodes::delay::config::QUEUE_CAPACITY`).
const QUEUE_CAPACITY: usize = 16;

/// Where the device clock stands when a scenario starts, unless it says
/// otherwise. Not 0: the generated scheduler runs its first tick once
/// `millis()` has moved.
const BOOT_MS: i64 = 1000;

/// The Arduino core, as far as a `Sensor → Delay` Sketch needs it, and a
/// `main` that plays `<boot ms> <until ms> [<at ms> <level>]...`.
const HOST: &str = r#"
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
    if (delay_delay_fired) { printf("%lu %ld\n", t, (long)delay_delay_value); }
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

/// Generate and compile the Sketch of a Sensor feeding a Delay with `data`
/// into `name`'s own directory: the path of the program.
fn compile_sketch(name: &str, data: &serde_json::Value) -> PathBuf {
    let flow = FlowUpdate {
        nodes: vec![node("sensor", "Sensor", json!({ "pin": "A0" })), node("delay", "Delay", data.clone())],
        edges: vec![FlowEdge {
            id: None,
            source: "sensor".to_string(),
            source_handle: "value".to_string(),
            target: "delay".to_string(),
            target_handle: "trigger".to_string(),
        }],
    };
    let target = target_by_id("uno").expect("the Uno is a supported board");
    let outcome = generate(&flow, &target).expect("generation never errors");
    let sketch = outcome.sketch.unwrap_or_else(|| panic!("no sketch: {:?}", outcome.problems));

    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("delay_sketch").join(name);
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

/// When the compiled Delay fired, and with what.
fn sketch_fires(program: &Path, boot_ms: i64, triggers: &[At], until_ms: u32) -> Vec<At> {
    let mut run = Command::new(program);
    run.arg(boot_ms.to_string()).arg(until_ms.to_string());
    for (at, level) in triggers {
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

/// When the live Delay fired, and with what: the same triggers dispatched to
/// its `trigger` port, with a host that keeps its wakeups on a millisecond
/// clock. On a millisecond that has both, a trigger arrives before a wakeup
/// elapses — the order of the generated loop, which holds before it fires.
#[cfg(feature = "runtime")]
fn live_fires(data: &serde_json::Value, triggers: &[At], until_ms: u32) -> Vec<At> {
    use microflow_core::runtime::{ComponentValue, Effects, FlowRuntime, Wakeup};

    fn apply(effects: Effects, now: u32, timers: &mut Vec<(u64, Wakeup)>, fired: &mut Vec<At>) {
        timers.retain(|(_, wakeup)| !effects.cancellations.contains(&wakeup.id));
        timers.extend(effects.wakeups.into_iter().map(|wakeup| (u64::from(now) + wakeup.delay_ms, wakeup)));
        for event in effects.component_events {
            if event.source.as_ref() == "delay" && event.source_handle.as_ref() == "event" {
                // The triggers are whole numbers, so what fires is one too.
                #[allow(clippy::cast_possible_truncation)]
                fired.push((now, event.value.as_number().expect("a number") as i32));
            }
        }
    }

    let mut runtime = FlowRuntime::new();
    let mut timers = Vec::new();
    let mut fired = Vec::new();
    let flow = FlowUpdate { nodes: vec![node("delay", "Delay", data.clone())], edges: vec![] };
    apply(runtime.update_flow(flow), 0, &mut timers, &mut fired);
    for now in 0..=until_ms {
        runtime.set_now(f64::from(now));
        for (_, value) in triggers.iter().filter(|(at, _)| *at == now) {
            let effects = runtime.dispatch("delay", "trigger", ComponentValue::Number(f64::from(*value)));
            apply(effects, now, &mut timers, &mut fired);
        }
        while let Some(index) = timers.iter().position(|(due, _)| *due <= u64::from(now)) {
            let (_, wakeup) = timers.remove(index);
            apply(runtime.wake(&wakeup.node_id, &wakeup.method), now, &mut timers, &mut fired);
        }
    }
    fired
}

/// Run `triggers` through the generated Sketch of a Delay with `data` — and,
/// with the `runtime` feature, through the live Delay, which must agree.
/// `None` when there is no C++ compiler to run the Sketch with.
fn fires(name: &str, data: &serde_json::Value, boot_ms: i64, triggers: &[At], until_ms: u32) -> Option<Vec<At>> {
    if !has_cxx() {
        eprintln!("skipped {name}: no `c++` on the PATH to compile the generated sketch with");
        return None;
    }
    let sketch = sketch_fires(&compile_sketch(name, data), boot_ms, triggers, until_ms);
    #[cfg(feature = "runtime")]
    assert_eq!(
        sketch,
        live_fires(data, triggers, until_ms),
        "{name}: the sketch (left) and the live runtime (right) disagree"
    );
    Some(sketch)
}

#[test]
fn a_queue_fires_every_trigger_in_order_with_its_own_value() {
    let data = json!({ "delay": 500, "forgetPrevious": false });
    let triggers = [(10, 100), (110, 200), (260, 300)];
    let Some(fired) = fires("queue", &data, BOOT_MS, &triggers, 2000) else { return };
    assert_eq!(fired, [(510, 100), (610, 200), (760, 300)]);
}

#[test]
fn a_delay_is_a_queue_unless_told_to_forget() {
    let Some(fired) = fires("default", &json!({ "delay": 500 }), BOOT_MS, &[(10, 1), (20, 2)], 2000) else {
        return;
    };
    assert_eq!(fired, [(510, 1), (520, 2)]);
}

#[test]
fn a_debounce_fires_only_the_latest_trigger() {
    let data = json!({ "delay": 500, "forgetPrevious": true });
    let triggers = [(10, 100), (110, 200), (260, 300), (1000, 400)];
    let Some(fired) = fires("debounce", &data, BOOT_MS, &triggers, 3000) else { return };
    assert_eq!(fired, [(760, 300), (1500, 400)]);
}

/// The Delay of the "Debounced Button" template
/// (`apps/web/src/flows/templates`): a bouncing contact settles into one event.
#[test]
fn the_debounced_button_template_passes_a_bouncing_press_once() {
    let data = json!({ "delay": 30, "forgetPrevious": true });
    let bounce = [(10, 1), (14, 0), (19, 1), (25, 0), (31, 1), (400, 0)];
    let Some(fired) = fires("template", &data, BOOT_MS, &bounce, 1000) else { return };
    assert_eq!(fired, [(61, 1), (430, 0)]);
}

/// More triggers than the queue holds: the oldest keep their turn, the newest
/// pending one gives way to each newcomer, so the latest is never the one
/// lost. Once it has drained the queue holds every trigger again.
#[test]
fn a_full_queue_replaces_its_newest_trigger_and_recovers() {
    // One trigger a millisecond, four more than fit.
    let burst: Vec<At> = (10..).zip(1..).take(QUEUE_CAPACITY + 4).collect();
    let mut triggers = burst.clone();
    triggers.extend([(3000, 7), (3100, 8)]);

    let Some(fired) = fires("overflow", &json!({ "delay": 1000 }), BOOT_MS, &triggers, 5000) else { return };

    let kept = burst[..QUEUE_CAPACITY - 1].iter().chain(burst.last());
    let mut expected: Vec<At> = kept.map(|(at, value)| (at + 1000, *value)).collect();
    expected.extend([(4000, 7), (4100, 8)]);
    assert_eq!(fired, expected);
}

/// A source that never lets up does not starve the queue: what it holds still
/// fires on time and in order, and room opens up for later triggers.
#[test]
fn a_queue_under_a_steady_overload_keeps_firing_on_time() {
    let delay = 1005;
    // 150 triggers, 20 ms apart: 50 arrive in the time one of them waits.
    let triggers: Vec<At> = (0..150).zip(1..).map(|(nth, value)| (10 + 20 * nth, value)).collect();

    let Some(fired) = fires("overload", &json!({ "delay": delay }), BOOT_MS, &triggers, 6000) else { return };

    // Three seconds of triggers: far more than the one queue-full a source
    // that starved it would leave.
    assert!(fired.len() > 2 * QUEUE_CAPACITY, "only {} of 150 fired", fired.len());
    for (at, value) in &fired {
        assert!(triggers.contains(&(at - delay, *value)), "{value} fired at {at}, not {delay} ms after it arrived");
    }
    assert!(fired.windows(2).all(|pair| pair[0] < pair[1]), "out of order: {fired:?}");
    assert_eq!(fired.last(), triggers.last().map(|(at, value)| (at + delay, *value)).as_ref());
}

/// `millis()` rolls over while triggers are pending: the elapsed-time compare
/// is unsigned, so they fire as if it had not.
#[test]
fn pending_triggers_fire_on_time_across_a_millis_rollover() {
    for (name, forget_previous, expected) in [
        ("rollover-queue", false, vec![(510, 100), (610, 200), (760, 300)]),
        ("rollover-debounce", true, vec![(760, 300)]),
    ] {
        let data = json!({ "delay": 500, "forgetPrevious": forget_previous });
        // The clock rolls over 300 ms in, with triggers pending on both sides.
        let Some(fired) = fires(name, &data, -300, &[(10, 100), (110, 200), (260, 300)], 2000) else { return };
        assert_eq!(fired, expected, "{name}");
    }
}
