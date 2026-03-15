//! Benchmarks for flow event routing performance.
//!
//! Measures the throughput of [`FlowExecutor::process_event`] with varying
//! numbers of components and edges to track regression over time.

use app_lib::runtime::{ComponentEvent, ComponentValue, FlowEdge, FlowExecutor};
use app_lib::runtime::base::{BoardHandle, Component, ComponentBase};
use criterion::{black_box, criterion_group, criterion_main, Criterion};
use std::sync::Arc;
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Minimal zero-cost mock component
// ---------------------------------------------------------------------------

struct BenchComponent {
    base: ComponentBase,
}

impl BenchComponent {
    fn new(id: &str) -> Self {
        Self {
            base: ComponentBase::new(id.to_string(), ComponentValue::Number(0.0)),
        }
    }
}

impl Component for BenchComponent {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, v: ComponentValue) { self.base.value = v; }
    fn component_type(&self) -> &'static str { "Bench" }
    fn initialize(&mut self, _: Arc<BoardHandle>) -> Result<(), String> { Ok(()) }
    fn call_method(&mut self, _method: &str, args: ComponentValue) -> Result<(), String> {
        self.base.value = args;
        Ok(())
    }
    fn destroy(&mut self) {}
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> {
        self.base.event_sender.clone()
    }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) {
        self.base.event_sender = Some(sender);
    }
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

fn make_executor(component_count: usize) -> (FlowExecutor, ComponentEvent) {
    let mut executor = FlowExecutor::new();

    // One source component
    executor.add_component("source", Box::new(BenchComponent::new("source")));

    // N target components each connected to the source
    let mut edges = Vec::with_capacity(component_count);
    for i in 0..component_count {
        let id = format!("target-{i}");
        executor.add_component(&id.clone(), Box::new(BenchComponent::new(&id)));
        edges.push(FlowEdge {
            id: None,
            source: "source".to_string(),
            source_handle: "out".to_string(),
            target: id,
            target_handle: "in".to_string(),
        });
    }
    executor.set_edges(edges);

    let event = ComponentEvent {
        source: Arc::from("source"),
        source_handle: Arc::from("out"),
        value: ComponentValue::Number(1.0),
        edge_id: None,
        sequence: 0,
    };

    (executor, event)
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

fn bench_route_event_10_targets(c: &mut Criterion) {
    let (mut executor, event) = make_executor(10);
    c.bench_function("route_event_10_targets", |b| {
        b.iter(|| executor.process_event(black_box(event.clone())));
    });
}

fn bench_route_event_100_targets(c: &mut Criterion) {
    let (mut executor, event) = make_executor(100);
    c.bench_function("route_event_100_targets", |b| {
        b.iter(|| executor.process_event(black_box(event.clone())));
    });
}

fn bench_route_event_no_targets(c: &mut Criterion) {
    let (mut executor, event) = make_executor(0);
    c.bench_function("route_event_no_targets", |b| {
        b.iter(|| executor.process_event(black_box(event.clone())));
    });
}

fn bench_stale_event_discard(c: &mut Criterion) {
    let (mut executor, _) = make_executor(10);
    executor.set_current_sequence(100);

    let stale_event = ComponentEvent {
        source: Arc::from("source"),
        source_handle: Arc::from("out"),
        value: ComponentValue::Number(1.0),
        edge_id: None,
        sequence: 1, // older than current_sequence
    };

    c.bench_function("stale_event_discard", |b| {
        b.iter(|| executor.process_event(black_box(stale_event.clone())));
    });
}

criterion_group!(
    benches,
    bench_route_event_no_targets,
    bench_route_event_10_targets,
    bench_route_event_100_targets,
    bench_stale_event_discard,
);
criterion_main!(benches);
