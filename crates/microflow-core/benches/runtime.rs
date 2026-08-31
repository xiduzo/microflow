//! Criterion benches for the live-flow hot paths.
//!
//! Every bench drives the runtime through its **public entry points** with a
//! flow built by `update_flow` from the real component registry — no test
//! doubles, no reaching into internals. What is measured is what a connected
//! board actually causes.
//!
//! Run: `cargo bench -p microflow-core --features runtime`
//! One group: `cargo bench -p microflow-core --features runtime -- inbound`
//!
//! To A/B against another commit, check this file out into a worktree of that
//! commit (plus the `criterion` dev-dep and `[[bench]]` stanza) and compare —
//! see `docs/benchmarks.md`.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use microflow_core::flow::{FlowEdge, FlowNode, FlowUpdate, Position};
use microflow_core::runtime::{ComponentValue, FlowRuntime};
use serde_json::json;
use std::hint::black_box;

// ---------------------------------------------------------------------------
// Flow construction helpers
// ---------------------------------------------------------------------------

fn node(id: &str, instance: &str, data: serde_json::Value) -> FlowNode {
    FlowNode {
        id: id.to_string(),
        node_type: Some(instance.to_string()),
        data,
        position: Position { x: 0.0, y: 0.0 },
    }
}

fn edge(source: &str, source_handle: &str, target: &str, target_handle: &str) -> FlowEdge {
    FlowEdge {
        id: Some(format!("{source}:{source_handle}->{target}:{target_handle}")),
        source: source.to_string(),
        source_handle: source_handle.to_string(),
        target: target.to_string(),
        target_handle: target_handle.to_string(),
    }
}

/// Number of digital pins before the analog block, matching the Uno/Mega
/// layout the desktop detection and the web session hand over: `analogChannel`
/// is `-1` on a digital pin and the pin's own number on an analog one, so `A0`
/// is pin `FIRST_ANALOG_PIN`.
const FIRST_ANALOG_PIN: i64 = 14;
/// Analog channels seeded, i.e. `A0`..`A15` — a Mega-shaped board.
const ANALOG_CHANNELS: i64 = 16;

/// Seed the codec's pin table exactly as the connection handshake does.
fn seed_board(runtime: &mut FlowRuntime) {
    let total = FIRST_ANALOG_PIN + ANALOG_CHANNELS;
    let pins: Vec<serde_json::Value> = (0..total)
        .map(|pin| {
            json!({
                "pin": pin,
                "supportedModes": [],
                "analogChannel": if pin >= FIRST_ANALOG_PIN { pin } else { -1 },
            })
        })
        .collect();
    runtime
        .seed_pins(&serde_json::to_string(&pins).expect("pins json"))
        .expect("seed pins");
}

/// One Firmata analog report: channel + 7-bit lo/hi value.
fn analog_frame(channel: u8, value: u16) -> [u8; 3] {
    [0xE0 | (channel & 0x0F), (value & 0x7F) as u8, ((value >> 7) & 0x7F) as u8]
}

/// Fail the bench rather than time an empty loop.
///
/// A benchmark that silently measures a mis-wired flow is worse than no
/// benchmark: it reports a number, the number is stable, and it is meaningless.
/// Every scenario below asserts once, outside the timed section, that the work
/// it means to measure actually happens.
fn assert_produces_work(label: &str, effects: &microflow_core::runtime::Effects) {
    assert!(
        !effects.component_events.is_empty() || !effects.outbound_bytes.is_empty(),
        "{label}: flow produced no events and no bytes — the scenario is mis-wired \
         and the benchmark would be timing an empty drain",
    );
}

/// True when a turn produced nothing for the host to do.
///
/// Spelled out field by field rather than calling `Effects::is_empty()`, so this
/// file compiles unchanged against commits from either side of the branch that
/// introduced that helper — an A/B is only fair if the harness is identical.
fn produced_nothing(effects: &microflow_core::runtime::Effects) -> bool {
    effects.outbound_bytes.is_empty()
        && effects.component_events.is_empty()
        && effects.wakeups.is_empty()
        && effects.cancellations.is_empty()
        && effects.cloud_requests.is_empty()
        && effects.node_diagnostics.is_empty()
}

// ---------------------------------------------------------------------------
// 1. Inbound serial: the highest-frequency entry point in the system.
// ---------------------------------------------------------------------------

/// A board streaming analog reports into `sensors` sensor nodes, each driving an
/// LED. This is the path a connected Arduino exercises continuously — every
/// chunk runs the pin scan, and a changed pin runs the drain, the router and the
/// outbound encode.
///
/// The alternating value is the *changing* case (a real sensor is never
/// perfectly still); `feed_bytes_unchanged` below covers the far more common
/// steady-value case, where the whole turn should collapse to nothing.
fn bench_inbound(c: &mut Criterion) {
    let mut group = c.benchmark_group("inbound");

    for sensors in [1i64, 8, ANALOG_CHANNELS] {
        let mut runtime = FlowRuntime::new();
        seed_board(&mut runtime);

        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for i in 0..sensors {
            let sensor = format!("sensor{i}");
            let led = format!("led{i}");
            nodes.push(node(
                &sensor,
                "Sensor",
                json!({ "instance": "Sensor", "pin": format!("A{i}"), "type": "analog", "threshold": 1 }),
            ));
            nodes.push(node(&led, "Led", json!({ "instance": "Led", "pin": 13 })));
            edges.push(edge(&sensor, "value", &led, "value"));
        }
        runtime.update_flow(FlowUpdate { nodes, edges });
        assert_produces_work("inbound/changing", &runtime.feed_bytes(&analog_frame(0, 300)));

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::new("feed_bytes_changing", sensors),
            &sensors,
            |b, _| {
                let mut tick: u16 = 0;
                b.iter(|| {
                    // Walk the value so the pin-change detector always fires.
                    tick = tick.wrapping_add(1);
                    let value = 100 + (tick % 64);
                    black_box(runtime.feed_bytes(black_box(&analog_frame(0, value))))
                });
            },
        );

        group.bench_with_input(
            BenchmarkId::new("feed_bytes_unchanged", sensors),
            &sensors,
            |b, _| {
                // Prime the detector so the value below is a genuine no-change.
                runtime.feed_bytes(&analog_frame(0, 512));
                assert!(
                    produced_nothing(&runtime.feed_bytes(&analog_frame(0, 512))),
                    "a repeated analog value must produce no effects at all",
                );
                b.iter(|| black_box(runtime.feed_bytes(black_box(&analog_frame(0, 512)))));
            },
        );
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// 2. Timer wakeups: every Interval / Oscillator / Delay node, forever.
// ---------------------------------------------------------------------------

/// A flow of `timers` Interval nodes, each waking and re-arming. Every fire
/// looks the node's outstanding timer up, drains its emit, and resolves a fresh
/// wakeup — so this prices the `outstanding` bookkeeping plus one drain turn.
fn bench_wake(c: &mut Criterion) {
    let mut group = c.benchmark_group("timers");

    for timers in [1usize, 16, 64] {
        let mut runtime = FlowRuntime::new();
        seed_board(&mut runtime);

        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for i in 0..timers {
            let interval = format!("interval{i}");
            let led = format!("led{i}");
            nodes.push(node(
                &interval,
                "Interval",
                json!({ "instance": "Interval", "interval": 20, "autoStart": true }),
            ));
            nodes.push(node(&led, "Led", json!({ "instance": "Led", "pin": 13 })));
            edges.push(edge(&interval, "value", &led, "value"));
        }
        runtime.update_flow(FlowUpdate { nodes, edges });
        assert_produces_work("timers/wake", &runtime.wake("interval0", "_tick"));

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(BenchmarkId::new("wake_and_rearm", timers), &timers, |b, _| {
            let mut i = 0usize;
            b.iter(|| {
                // Round-robin the timers so the lookup is not a single hot key.
                let id = format!("interval{}", i % timers);
                i += 1;
                black_box(runtime.wake(black_box(&id), black_box("_tick")))
            });
        });
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// 3. Snapshot fan-in: dispatch into an aggregating node.
// ---------------------------------------------------------------------------

/// Four sensors feeding one Calculate (which aggregates, so each delivery
/// rebuilds the snapshot of all its inputs), inside a flow that also carries
/// `filler` unrelated edges.
///
/// The filler is the point. It is inert — nothing in it fires — but it grows the
/// flow's edge list, which is what a real project looks like: one busy Calculate
/// in a canvas of a few hundred wires. If snapshot delivery is sensitive to the
/// filler, delivery cost is a function of total flow size rather than of the
/// node's own fan-in.
fn bench_snapshot_fanin(c: &mut Criterion) {
    let mut group = c.benchmark_group("fanin");

    for filler in [0usize, 64, 256] {
        let mut runtime = FlowRuntime::new();
        seed_board(&mut runtime);

        let mut nodes = vec![node(
            "calc",
            "Calculate",
            json!({ "instance": "Calculate", "function": "add" }),
        )];
        let mut edges = Vec::new();

        for i in 0..4 {
            let sensor = format!("sensor{i}");
            nodes.push(node(
                &sensor,
                "Sensor",
                json!({ "instance": "Sensor", "pin": format!("A{i}"), "type": "analog", "threshold": 1 }),
            ));
            edges.push(edge(&sensor, "value", "calc", "value"));
        }

        // Unrelated wires elsewhere in the same flow.
        for i in 0..filler {
            let source = format!("filler_src{i}");
            let target = format!("filler_dst{i}");
            nodes.push(node(
                &source,
                "Constant",
                json!({ "instance": "Constant", "value": 1.0 }),
            ));
            nodes.push(node(&target, "Led", json!({ "instance": "Led", "pin": 13 })));
            edges.push(edge(&source, "value", &target, "value"));
        }

        runtime.update_flow(FlowUpdate { nodes, edges });
        assert_produces_work(
            "fanin/inject",
            &runtime.inject_event("sensor0", "value", ComponentValue::Number(1.0)),
        );

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::new("inject_into_aggregator", filler),
            &filler,
            |b, _| {
                let mut tick = 0.0f64;
                b.iter(|| {
                    tick += 1.0;
                    black_box(runtime.inject_event(
                        black_box("sensor0"),
                        black_box("value"),
                        ComponentValue::Number(tick),
                    ))
                });
            },
        );
    }

    group.finish();
}

// ---------------------------------------------------------------------------
// 4. Cascade depth: one event through a chain of nodes.
// ---------------------------------------------------------------------------

/// A chain `src -> counter0 -> counter1 -> … -> led`. One injected value drains
/// the whole chain in a single turn, so this prices the per-event drain overhead
/// (the stale gate, the source echo, the route, the dispatch) multiplied by depth.
///
/// Counter is the link because `ComponentBase::set_value` emits **only when the
/// value changed**: a transform fed a steady input goes quiet after the first
/// event, and the chain would silently stop propagating partway down. A counter
/// moves on every input by construction, so every link fires on every iteration
/// and the benchmark measures the depth it claims to.
fn bench_cascade(c: &mut Criterion) {
    let mut group = c.benchmark_group("cascade");

    for depth in [1usize, 8, 32] {
        let mut runtime = FlowRuntime::new();
        seed_board(&mut runtime);

        let mut nodes = vec![node(
            "src",
            "Constant",
            json!({ "instance": "Constant", "value": 1.0 }),
        )];
        let mut edges = Vec::new();
        let mut previous = "src".to_string();

        for i in 0..depth {
            let id = format!("counter{i}");
            nodes.push(node(&id, "Counter", json!({ "instance": "Counter" })));
            edges.push(edge(&previous, "value", &id, "increment"));
            previous = id;
        }
        nodes.push(node("led", "Led", json!({ "instance": "Led", "pin": 13 })));
        edges.push(edge(&previous, "value", "led", "value"));

        runtime.update_flow(FlowUpdate { nodes, edges });
        // A value the settled chain has not already seen, so the warm-up actually
        // propagates (`update_flow` drains the Constant's own initial emit).
        let warmup = runtime.inject_event("src", "value", ComponentValue::Number(9_999.0));
        assert_produces_work("cascade/drain", &warmup);
        assert!(
            warmup.component_events.len() > depth,
            "cascade depth {depth}: only {} events drained — the chain is broken, \
             so the benchmark would not be measuring depth at all",
            warmup.component_events.len(),
        );

        group.throughput(Throughput::Elements(depth as u64 + 1));
        group.bench_with_input(BenchmarkId::new("drain_chain", depth), &depth, |b, _| {
            let mut tick = 0.0f64;
            b.iter(|| {
                tick += 1.0;
                black_box(runtime.inject_event(
                    black_box("src"),
                    black_box("value"),
                    ComponentValue::Number(tick),
                ))
            });
        });
    }

    group.finish();
}

criterion_group!(benches, bench_inbound, bench_wake, bench_snapshot_fanin, bench_cascade);
criterion_main!(benches);
