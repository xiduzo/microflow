//! Tests for the stored-value-sync invariant.
//!
//! Every component's stored `value()` must stay in sync with the values it
//! emits. The executor's `process_event` is responsible for updating the
//! source component's stored value before routing to downstream targets.
//! This ensures `collect_input_values` (used by aggregating nodes like
//! Calculate and Gate) always sees the latest emitted value.

use app_lib::runtime::base::{BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue};
use app_lib::runtime::{
    Calculate, CalculateConfig, CalculateFunction, Constant, ConstantConfig, FlowEdge, FlowExecutor,
    Gate, GateConfig, RangeMap, RangeMapConfig, Smooth, SmoothConfig, Compare, CompareConfig,
    CompareValidator,
};
use std::sync::Arc;
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn edge(source: &str, source_handle: &str, target: &str, target_handle: &str) -> FlowEdge {
    FlowEdge {
        id: None,
        source: source.to_string(),
        source_handle: source_handle.to_string(),
        target: target.to_string(),
        target_handle: target_handle.to_string(),
    }
}

fn event(source: &str, handle: &str, value: ComponentValue) -> ComponentEvent {
    ComponentEvent {
        source: Arc::from(source),
        source_handle: Arc::from(handle),
        value,
        edge_id: None,
        sequence: 0,
    }
}

/// A minimal "generator" mock that emits from outside (simulating a background
/// thread) without updating its own stored value — exactly like Interval and
/// Oscillator do.
struct ThreadEmitter {
    base: ComponentBase,
}

impl ThreadEmitter {
    fn new(id: &str) -> Self {
        Self {
            base: ComponentBase::new(id.to_string(), ComponentValue::Number(0.0)),
        }
    }
}

impl Component for ThreadEmitter {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, v: ComponentValue) { self.base.value = v; }
    fn component_type(&self) -> &'static str { "ThreadEmitter" }
    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), app_lib::RuntimeError> { Ok(()) }
    fn call_method(&mut self, _method: &str, _args: ComponentValue) -> Result<(), app_lib::RuntimeError> { Ok(()) }
    fn destroy(&mut self) {}
    fn event_sender(&self) -> Option<mpsc::UnboundedSender<ComponentEvent>> {
        self.base.event_sender.clone()
    }
    fn set_event_sender(&mut self, sender: mpsc::UnboundedSender<ComponentEvent>) {
        self.base.event_sender = Some(sender);
    }
}

/// A simple sink that stores whatever it receives via `call_method`.
struct Sink {
    base: ComponentBase,
}

impl Sink {
    fn new(id: &str) -> Self {
        Self { base: ComponentBase::new(id.to_string(), ComponentValue::Number(0.0)) }
    }
}

impl Component for Sink {
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, v: ComponentValue) { self.base.value = v; }
    fn component_type(&self) -> &'static str { "Sink" }
    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), app_lib::RuntimeError> { Ok(()) }
    fn call_method(&mut self, _method: &str, args: ComponentValue) -> Result<(), app_lib::RuntimeError> {
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
// Executor stored-value-sync tests
// ---------------------------------------------------------------------------

/// The executor must update the source component's stored value when
/// processing an event, so that `collect_input_values` sees the latest value.
#[test]
fn test_executor_syncs_source_stored_value_on_event() {
    let mut executor = FlowExecutor::new();

    executor.add_component("emitter", Box::new(ThreadEmitter::new("emitter")), serde_json::Value::Null);
    executor.add_component("sink", Box::new(Sink::new("sink")), serde_json::Value::Null);
    executor.set_edges(vec![edge("emitter", "value", "sink", "value")]);

    // Emitter's stored value starts at 0
    assert_eq!(executor.get_component("emitter").unwrap().value(), ComponentValue::Number(0.0));

    // Simulate the emitter firing an event with value 42 (like Interval does from a thread)
    executor.process_event(event("emitter", "value", ComponentValue::Number(42.0)));

    // The executor should have updated the emitter's stored value
    assert_eq!(
        executor.get_component("emitter").unwrap().value(),
        ComponentValue::Number(42.0),
        "Executor must sync source component's stored value with emitted event value"
    );
}

/// Repeated events from the same source must keep the stored value up to date.
#[test]
fn test_executor_syncs_stored_value_across_multiple_events() {
    let mut executor = FlowExecutor::new();

    executor.add_component("emitter", Box::new(ThreadEmitter::new("emitter")), serde_json::Value::Null);
    executor.add_component("sink", Box::new(Sink::new("sink")), serde_json::Value::Null);
    executor.set_edges(vec![edge("emitter", "value", "sink", "value")]);

    for i in 1..=5 {
        let val = f64::from(i) * 100.0;
        executor.process_event(event("emitter", "value", ComponentValue::Number(val)));
        assert_eq!(
            executor.get_component("emitter").unwrap().value(),
            ComponentValue::Number(val),
        );
    }
}

/// Stale events must NOT update the stored value.
#[test]
fn test_stale_event_does_not_update_stored_value() {
    let mut executor = FlowExecutor::new();
    executor.set_current_sequence(10);

    executor.add_component("emitter", Box::new(ThreadEmitter::new("emitter")), serde_json::Value::Null);
    executor.add_component("sink", Box::new(Sink::new("sink")), serde_json::Value::Null);
    executor.set_edges(vec![edge("emitter", "value", "sink", "value")]);

    let stale = ComponentEvent {
        source: Arc::from("emitter"),
        source_handle: Arc::from("value"),
        value: ComponentValue::Number(999.0),
        edge_id: None,
        sequence: 3, // older than current_sequence=10
    };
    executor.process_event(stale);

    assert_eq!(
        executor.get_component("emitter").unwrap().value(),
        ComponentValue::Number(0.0),
        "Stale events must not update stored value"
    );
}

// ---------------------------------------------------------------------------
// Aggregating node tests (collect_input_values correctness)
// ---------------------------------------------------------------------------

/// Interval -> Calculate (min) with Constant should use the actual interval
/// value, not the stale stored default.
/// This is the exact scenario from the original bug report.
#[test]
fn test_calculate_min_with_thread_emitter_and_constant() {
    let mut executor = FlowExecutor::new();

    // Constant(255) and a thread emitter (simulating Interval) both feed into Calculate(min)
    executor.add_component("constant", Box::new(Constant::new("constant".into(), ConstantConfig { value: 255.0 })), serde_json::Value::Null);
    executor.add_component("interval", Box::new(ThreadEmitter::new("interval")), serde_json::Value::Null);
    executor.add_component("calc", Box::new(Calculate::new("calc".into(), CalculateConfig { function: CalculateFunction::Min })), serde_json::Value::Null);
    executor.add_component("sink", Box::new(Sink::new("sink")), serde_json::Value::Null);

    executor.set_edges(vec![
        edge("constant", "value", "calc", "value"),
        edge("interval", "event", "calc", "value"),
        edge("calc", "value", "sink", "value"),
    ]);

    // Simulate interval tick with elapsed=5005ms
    executor.process_event(event("interval", "event", ComponentValue::Number(5005.0)));

    // Calculate(min) should compute min(255, 5005) = 255, not min(255, 0)
    assert_eq!(
        executor.get_component("calc").unwrap().value(),
        ComponentValue::Number(255.0),
        "Calculate(min) must use the actual event value (5005), not the stale default (0)"
    );
}

/// Calculate(add) should sum all input values correctly when one source is a
/// thread emitter.
#[test]
fn test_calculate_add_with_thread_emitter() {
    let mut executor = FlowExecutor::new();

    executor.add_component("constant", Box::new(Constant::new("constant".into(), ConstantConfig { value: 10.0 })), serde_json::Value::Null);
    executor.add_component("emitter", Box::new(ThreadEmitter::new("emitter")), serde_json::Value::Null);
    executor.add_component("calc", Box::new(Calculate::new("calc".into(), CalculateConfig::default())), serde_json::Value::Null); // default = Add
    executor.add_component("sink", Box::new(Sink::new("sink")), serde_json::Value::Null);

    executor.set_edges(vec![
        edge("constant", "value", "calc", "value"),
        edge("emitter", "event", "calc", "value"),
        edge("calc", "value", "sink", "value"),
    ]);

    executor.process_event(event("emitter", "event", ComponentValue::Number(20.0)));

    // add(10, 20) = 30
    assert_eq!(
        executor.get_component("calc").unwrap().value(),
        ComponentValue::Number(30.0),
    );
}

// ---------------------------------------------------------------------------
// Calculate emit test (the original bug: Calculate didn't emit downstream)
// ---------------------------------------------------------------------------

/// Calculate must emit its result downstream after processing.
/// Before the fix, Calculate called `set_value` but never emitted, so
/// downstream nodes were never reached.
#[test]
fn test_calculate_emits_downstream() {
    let mut executor = FlowExecutor::new();
    let (tx, mut rx) = mpsc::unbounded_channel::<ComponentEvent>();

    let mut calc = Calculate::new("calc".into(), CalculateConfig::default());
    calc.set_event_sender(tx);
    executor.add_component("calc", Box::new(calc), serde_json::Value::Null);
    executor.add_component("sink", Box::new(Sink::new("sink")), serde_json::Value::Null);

    executor.set_edges(vec![
        edge("calc", "value", "sink", "value"),
    ]);

    // Directly call the calculate component's method
    if let Some(c) = executor.get_component_mut("calc") {
        c.call_method("value", ComponentValue::Array(vec![
            ComponentValue::Number(3.0),
            ComponentValue::Number(7.0),
        ])).unwrap();
    }

    // Calculate should have emitted a "value" event
    let emitted = rx.try_recv();
    assert!(emitted.is_ok(), "Calculate must emit an event after processing");
    let evt = emitted.unwrap();
    assert_eq!(evt.value, ComponentValue::Number(10.0)); // 3 + 7
}

// ---------------------------------------------------------------------------
// Smooth transformation: set_value auto-emits, verify propagation
// ---------------------------------------------------------------------------

/// Smooth calls `set_value` which auto-emits "value". Verify the stored value
/// is correct after processing.
#[test]
fn test_smooth_updates_stored_value() {
    let mut executor = FlowExecutor::new();
    let (tx, _rx) = mpsc::unbounded_channel::<ComponentEvent>();

    let mut smooth = Smooth::new("smooth".into(), SmoothConfig::default());
    smooth.set_event_sender(tx);
    executor.add_component("smooth", Box::new(smooth), serde_json::Value::Null);

    if let Some(c) = executor.get_component_mut("smooth") {
        c.call_method("value", ComponentValue::Number(100.0)).unwrap();
    }

    let val = executor.get_component("smooth").unwrap().value();
    match val {
        ComponentValue::Number(n) => assert!(n > 0.0, "Smooth should have updated its value from 0"),
        _ => panic!("Expected Number value from Smooth"),
    }
}

// ---------------------------------------------------------------------------
// Gate transformation: emits on named handles after set_value
// ---------------------------------------------------------------------------

/// Gate must update stored value AND emit after processing.
#[test]
fn test_gate_emits_and_updates_value() {
    let mut executor = FlowExecutor::new();
    let (tx, mut rx) = mpsc::unbounded_channel::<ComponentEvent>();

    let mut gate = Gate::new("gate".into(), GateConfig::default()); // default = And
    gate.set_event_sender(tx);
    executor.add_component("gate", Box::new(gate), serde_json::Value::Null);

    if let Some(c) = executor.get_component_mut("gate") {
        c.call_method("value", ComponentValue::Array(vec![
            ComponentValue::Bool(true),
            ComponentValue::Bool(true),
        ])).unwrap();
    }

    // Gate(And) with [true, true] -> true
    assert_eq!(
        executor.get_component("gate").unwrap().value(),
        ComponentValue::Bool(true),
    );

    // Should have emitted on "true" handle
    let emitted = rx.try_recv();
    assert!(emitted.is_ok(), "Gate must emit after processing");
}

// ---------------------------------------------------------------------------
// End-to-end: thread emitter -> aggregating node -> sink
// ---------------------------------------------------------------------------

/// Full pipeline: two thread emitters feed into Calculate(add), result goes to sink.
/// Both emitters fire at different times. Stored values must stay in sync.
#[test]
fn test_full_pipeline_two_emitters_to_calculate_to_sink() {
    let mut executor = FlowExecutor::new();
    let (tx, _rx) = mpsc::unbounded_channel::<ComponentEvent>();

    let mut calc = Calculate::new("calc".into(), CalculateConfig::default());
    calc.set_event_sender(tx);

    executor.add_component("em1", Box::new(ThreadEmitter::new("em1")), serde_json::Value::Null);
    executor.add_component("em2", Box::new(ThreadEmitter::new("em2")), serde_json::Value::Null);
    executor.add_component("calc", Box::new(calc), serde_json::Value::Null);
    executor.add_component("sink", Box::new(Sink::new("sink")), serde_json::Value::Null);

    executor.set_edges(vec![
        edge("em1", "value", "calc", "value"),
        edge("em2", "value", "calc", "value"),
        edge("calc", "value", "sink", "value"),
    ]);

    // em1 fires with 100
    executor.process_event(event("em1", "value", ComponentValue::Number(100.0)));
    // At this point: em1 stored=100, em2 stored=0 (default), calc = add(100, 0) = 100
    assert_eq!(executor.get_component("em1").unwrap().value(), ComponentValue::Number(100.0));
    assert_eq!(executor.get_component("calc").unwrap().value(), ComponentValue::Number(100.0));

    // em2 fires with 50
    executor.process_event(event("em2", "value", ComponentValue::Number(50.0)));
    // Now: em1 stored=100, em2 stored=50, calc = add(100, 50) = 150
    assert_eq!(executor.get_component("em2").unwrap().value(), ComponentValue::Number(50.0));
    assert_eq!(executor.get_component("calc").unwrap().value(), ComponentValue::Number(150.0));

    // em1 fires again with 200
    executor.process_event(event("em1", "value", ComponentValue::Number(200.0)));
    // Now: em1 stored=200, em2 stored=50, calc = add(200, 50) = 250
    assert_eq!(executor.get_component("em1").unwrap().value(), ComponentValue::Number(200.0));
    assert_eq!(executor.get_component("calc").unwrap().value(), ComponentValue::Number(250.0));
}

// ---------------------------------------------------------------------------
// Compare transformation: emits on named handles
// ---------------------------------------------------------------------------

#[test]
fn test_compare_emits_and_updates_value() {
    let mut executor = FlowExecutor::new();
    let (tx, mut rx) = mpsc::unbounded_channel::<ComponentEvent>();

    let mut compare = Compare::new("cmp".into(), CompareConfig {
        validator: CompareValidator::Number,
        sub_validator: "greater than".to_string(),
        number: 50.0,
        ..CompareConfig::default()
    });
    compare.set_event_sender(tx);
    executor.add_component("cmp", Box::new(compare), serde_json::Value::Null);

    if let Some(c) = executor.get_component_mut("cmp") {
        c.call_method("value", ComponentValue::Number(100.0)).unwrap();
    }

    // 100 > 50 = true
    assert_eq!(
        executor.get_component("cmp").unwrap().value(),
        ComponentValue::Bool(true),
    );

    let emitted = rx.try_recv();
    assert!(emitted.is_ok(), "Compare must emit after processing");
}

// ---------------------------------------------------------------------------
// RangeMap transformation: emits with custom value on "to" handle
// ---------------------------------------------------------------------------

#[test]
fn test_range_map_emits_mapped_value() {
    let mut executor = FlowExecutor::new();
    let (tx, mut rx) = mpsc::unbounded_channel::<ComponentEvent>();

    let mut range_map = RangeMap::new("rm".into(), RangeMapConfig::default());
    range_map.set_event_sender(tx);
    executor.add_component("rm", Box::new(range_map), serde_json::Value::Null);

    if let Some(c) = executor.get_component_mut("rm") {
        c.call_method("value", ComponentValue::Number(512.0)).unwrap();
    }

    // RangeMap's set_value auto-emits "value" first, then explicitly emits on "to"
    let first = rx.try_recv();
    assert!(first.is_ok(), "RangeMap must emit after processing");

    // The "to" handle event comes second
    let second = rx.try_recv();
    assert!(second.is_ok(), "RangeMap must emit on 'to' handle");
    assert_eq!(second.unwrap().source_handle.as_ref(), "to");
}
