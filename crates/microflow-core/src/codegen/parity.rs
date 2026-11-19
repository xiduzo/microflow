//! Interpret↔emit parity guards.
//!
//! A Node's live runtime (`nodes/<node>/runtime.rs`) and its emitter
//! (`nodes/<node>/codegen.rs`) are two implementations of the same Node
//! semantics. The shared config (`nodes/<node>/config.rs`, see `crate::nodes`)
//! makes them share a Node's fields + defaults, and the
//! handle-aware wiring model (`codegen/wire.rs`) gives codegen the same
//! port/emit routing the runtime router uses — but the *behavior* is still
//! written twice.
//!
//! These tests pin every node type to an explicit, EXHAUSTIVE classification
//! (see `classify` at the bottom): each registered type either carries a
//! behavioural parity case — feed inputs, assert the emitted C++ encodes the
//! same transform the runtime applies — or an exemption naming, in one line,
//! why no value transform exists to compare. Per-config enums (operations,
//! waveforms, validators, …) are matched without a wildcard arm, so a newly
//! added variant won't compile until it is categorized here, and a newly
//! registered node type fails the registry-driven guard until classified —
//! forcing a conscious "emit it, or record the limitation" decision. They are
//! the CI replacement for the prose docstrings that previously kept the two
//! sides in sync by hand — the kind of hand-sync that let the Smooth
//! attenuation invert silently (commit `e1e1eb9`).

#[cfg(test)]
mod tests {
    use crate::codegen::wire::{CppExpr, NodeInputs, SourceExpr};
    use crate::flow::{FlowNode, Position};
    use serde_json::json;

    fn node(node_type: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: "p".to_string(),
            node_type: Some(node_type.to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    /// Two numeric sources wired into one port — the shape that exercises a
    /// fold's multi-input path.
    fn two_inputs(port: &str) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add(port, SourceExpr::level(CppExpr::number("a")));
        inputs.add(port, SourceExpr::level(CppExpr::number("b")));
        inputs
    }

    /// One source wired into one port — the shape most single-driver Nodes see.
    fn input(port: &str, expr: CppExpr) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add(port, SourceExpr::level(expr));
        inputs
    }

    // ---- Pulse wiring: boot + text-change semantics ----------------------

    /// A sketch for `flow` on the ESP32, unwrapped (these flows fit it).
    fn sketch(flow: &crate::flow::FlowUpdate) -> String {
        let target = crate::codegen::board::target_by_id("esp32").expect("esp32 is supported");
        crate::codegen::generate(flow, &target)
            .expect("generation should succeed")
            .sketch
            .expect("flow fits the esp32")
    }

    fn flow_edge(
        source: &str,
        source_handle: &str,
        target: &str,
        target_handle: &str,
    ) -> crate::flow::FlowEdge {
        crate::flow::FlowEdge {
            id: None,
            source: source.to_string(),
            target: target.to_string(),
            source_handle: source_handle.to_string(),
            target_handle: target_handle.to_string(),
        }
    }

    fn id_node(id: &str, node_type: &str, data: serde_json::Value) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some(node_type.to_string()),
            data,
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    /// The runtime's `Constant::on_start` emits its value once at boot —
    /// an explicit `emit`, so a 0 as well — and a Constant wired into a
    /// Counter's `increment` port increments it once. On-device the Constant
    /// is an event on its first tick, whatever its value
    /// (`tests/boolean_sketch.rs` runs both).
    #[test]
    fn constant_boot_emit_fires_a_pulse_port_once_on_the_first_tick() {
        let flow = crate::flow::FlowUpdate {
            nodes: vec![
                id_node("c-1", "Constant", json!({ "value": 0.0 })),
                id_node("ctr-1", "Counter", json!({})),
            ],
            edges: vec![flow_edge("c-1", "value", "ctr-1", "increment")],
        };
        let s = sketch(&flow);
        assert!(s.contains("constant_c_1_fired = !constant_c_1_started;"), "fires on the first tick:\n{s}");
        assert!(
            s.contains("if (constant_c_1_fired) { counter_ctr_1_count += 1.0; }"),
            "increment gated on the Constant's tick:\n{s}"
        );
    }

    /// The runtime delivers the Llm's response text to any wired port when it
    /// arrives. On-device the response is an Arduino `String`, so the pulse
    /// detector must compare the String itself — the numeric projection of
    /// text is a constant and would never fire (the pre-fix silent-dead-code
    /// bug).
    #[test]
    fn llm_response_into_a_pulse_port_fires_on_text_change() {
        let flow = crate::flow::FlowUpdate {
            nodes: vec![
                id_node("llm-1", "Llm", json!({ "prompt": "p" })),
                id_node("ctr-1", "Counter", json!({})),
            ],
            edges: vec![flow_edge("llm-1", "value", "ctr-1", "increment")],
        };
        let s = sketch(&flow);
        assert!(
            s.contains("String counter_ctr_1_increment_prev0 = \"\";"),
            "String tracker for the text source:\n{s}"
        );
        assert!(
            s.contains("counter_ctr_1_increment_now0 = (llm_llm_1_value)"),
            "compares the response text itself:\n{s}"
        );
        assert!(
            s.contains("if (counter_ctr_1_increment_fired0) { counter_ctr_1_count += 1.0; }"),
            "a new response increments the counter:\n{s}"
        );
    }

    // ---- Calculate: 11 arithmetic functions ------------------------------

    /// EXHAUSTIVE over `CalculateFunction`: the C++ token each variant's fold
    /// must contain when two inputs are wired. Add a variant → this won't
    /// compile until you name its emitted token.
    fn calculate_token(f: crate::nodes::calculate::config::CalculateFunction) -> &'static str {
        use crate::nodes::calculate::config::CalculateFunction::{
            Add, Ceil, Divide, Floor, Max, Min, Modulo, Multiply, Pow, Round, Subtract,
        };
        match f {
            Add => " + ",
            Subtract => " - ",
            Multiply => " * ",
            Divide => ") / ",
            Modulo => "fmod(",
            Max => "fmax(",
            Min => "fmin(",
            Pow => "pow(",
            Ceil => "ceil(",
            Floor => "floor(",
            Round => "round(",
        }
    }

    #[test]
    fn calculate_emit_covers_every_function() {
        use crate::nodes::calculate::config::CalculateFunction as F;
        // (wire-name, variant). Wire names are the serde `rename_all="lowercase"`
        // forms — feeding them re-checks the runtime↔wire mapping too.
        let all = [
            ("add", F::Add),
            ("subtract", F::Subtract),
            ("multiply", F::Multiply),
            ("divide", F::Divide),
            ("modulo", F::Modulo),
            ("max", F::Max),
            ("min", F::Min),
            ("pow", F::Pow),
            ("ceil", F::Ceil),
            ("floor", F::Floor),
            ("round", F::Round),
        ];
        for (wire, variant) in all {
            let e = crate::nodes::calculate::codegen::emit(
                &node("Calculate", json!({ "function": wire })),
                &two_inputs("value"),
            ).unwrap();
            let body = e.loop_body.join("\n");
            let token = calculate_token(variant);
            assert!(
                body.contains(token),
                "Calculate `{wire}` must emit its fold (`{token}`), got: {body}"
            );
            assert!(body.contains("(a)"), "Calculate `{wire}` must read its inputs: {body}");
        }
    }

    // ---- Gate: 6 boolean gates -------------------------------------------

    /// EXHAUSTIVE over `GateType`: the truthy-count comparison each gate emits
    /// over two wired inputs, transcribing the runtime's `passes_gate`.
    fn gate_comparison(g: crate::nodes::gate::config::GateType) -> &'static str {
        use crate::nodes::gate::config::GateType::{And, Nand, Nor, Or, Xnor, Xor};
        match g {
            And => "== 2",
            Nand => "!= 2",
            Or => "> 0",
            Nor => "== 0",
            Xor => "== 1",
            Xnor => "!= 1",
        }
    }

    #[test]
    fn gate_emit_covers_every_gate() {
        use crate::nodes::gate::config::GateType as G;
        let all = [
            ("and", G::And),
            ("nand", G::Nand),
            ("or", G::Or),
            ("xor", G::Xor),
            ("nor", G::Nor),
            ("xnor", G::Xnor),
        ];
        for (wire, variant) in all {
            let e = crate::nodes::gate::codegen::emit(
                &node("Gate", json!({ "gate": wire })),
                &two_inputs("value"),
            ).unwrap();
            let body = e.loop_body.join("\n");
            assert!(
                body.contains("true_count"),
                "Gate `{wire}` must count truthy inputs, got: {body}"
            );
            let cmp = gate_comparison(variant);
            assert!(
                body.contains(cmp),
                "Gate `{wire}` must compare the count (`{cmp}`), got: {body}"
            );
        }
    }

    // ---- Counter: 4 ports, all bound by the handle-aware wiring ----------

    /// Runtime `Counter` accepts four ports; the handle-aware wiring model
    /// emits all of them. Gated on `runtime` because `Component::ports()`
    /// lives there. A new/renamed port hits the `other =>` arm and fails
    /// until classified.
    #[cfg(feature = "runtime")]
    #[test]
    fn counter_ports_classified_for_codegen() {
        use crate::nodes::counter::runtime::Counter;
        use crate::runtime::Component;

        // (port, the C++ action its binding must emit).
        let expected_action = |port: &str| match port {
            "increment" => "+= 1.0",
            "decrement" => "-= 1.0",
            "reset" => "= 0.0",
            "set" => "counter_p_count = ",
            other => panic!(
                "Counter port `{other}` is unclassified for codegen parity — bind it in \
                 nodes/counter/codegen.rs and name its emitted action here."
            ),
        };

        for &port in Counter::ports() {
            let mut inputs = NodeInputs::default();
            let expr = if port == "set" { CppExpr::number("v") } else { CppExpr::boolean("v") };
            inputs.add(port, SourceExpr::level(expr));
            let e = crate::nodes::counter::codegen::emit(&node("Counter", json!({})), &inputs);
            let body = e.loop_body.join("\n");
            let action = expected_action(port);
            assert!(
                body.contains(action),
                "Counter port `{port}` must emit `{action}`, got: {body}"
            );
        }
    }

    // ---- Compare: 5 validators -------------------------------------------

    /// EXHAUSTIVE over `CompareValidator`: the comparison token each variant
    /// must emit for a wired numeric input (number=5, range 1..9 fixed),
    /// transcribing the runtime's `compare` dispatch.
    fn compare_token(v: crate::nodes::compare::config::CompareValidator) -> &'static str {
        use crate::nodes::compare::config::CompareValidator::{Boolean, Number, OddEven, Range, Text};
        match v {
            Boolean => "!= 0.0",
            // Equality within the one tolerance both sides use.
            Number => "fabs(((double)(a)) - 5.0) < 0.0000000000000002220446049250313",
            OddEven => "% 2) == 0",
            Range => "> 1.0 && ",
            // Text predicates have no on-device string model; the runtime's
            // empty-match default is `false`, and the emitter emits exactly that.
            Text => "= false;",
        }
    }

    #[test]
    fn compare_emit_covers_every_validator() {
        use crate::nodes::compare::config::CompareValidator as V;
        let all = [
            ("boolean", V::Boolean),
            ("number", V::Number),
            ("oddEven", V::OddEven),
            ("range", V::Range),
            ("text", V::Text),
        ];
        for (wire, variant) in all {
            let e = crate::nodes::compare::codegen::emit(
                &node(
                    "Compare",
                    json!({ "validator": wire, "number": 5.0, "range": { "min": 1.0, "max": 9.0 } }),
                ),
                &input("value", CppExpr::number("a")),
            ).unwrap();
            let body = e.loop_body.join("\n");
            let token = compare_token(variant);
            assert!(
                body.contains(token),
                "Compare `{wire}` must emit its comparison (`{token}`), got: {body}"
            );
        }
    }

    // ---- Smooth: 2 smoothing types ---------------------------------------

    /// EXHAUSTIVE over `SmoothType`: the arithmetic each variant must emit,
    /// transcribing the runtime's `result = (1 - a) * value + a * previous`
    /// (attenuation fixed at 0.9) and the rolling-window mean.
    fn smooth_token(t: crate::nodes::smooth::config::SmoothType) -> &'static str {
        use crate::nodes::smooth::config::SmoothType::{MovingAverage, Smooth};
        match t {
            Smooth => "(1.0 - 0.9) * ",
            MovingAverage => "_sum / ",
        }
    }

    #[test]
    fn smooth_emit_covers_every_type() {
        use crate::nodes::smooth::config::SmoothType as S;
        let all = [("smooth", S::Smooth), ("movingAverage", S::MovingAverage)];
        for (wire, variant) in all {
            let e = crate::nodes::smooth::codegen::emit(
                &node("Smooth", json!({ "type": wire, "attenuation": 0.9, "windowSize": 4 })),
                &input("value", CppExpr::number("a")),
            ).unwrap();
            let body = e.loop_body.join("\n");
            let token = smooth_token(variant);
            assert!(
                body.contains(token),
                "Smooth `{wire}` must emit its transform (`{token}`), got: {body}"
            );
        }
    }

    // ---- Oscillator: 7 waveforms -----------------------------------------

    /// EXHAUSTIVE over `Waveform`: the sampling math each variant must emit
    /// (amplitude fixed at 2.5), the port of the runtime's `calculate_waveform`.
    fn waveform_token(w: crate::nodes::oscillator::config::Waveform) -> &'static str {
        use crate::nodes::oscillator::config::Waveform::{
            Perlin, Random, RandomWalk, Sawtooth, Sinus, Square, Triangle,
        };
        match w {
            Sinus => "sin(",
            Square => "? 2.5 : -(2.5)",
            Sawtooth => "(2.0 / ",
            Triangle => "(4.0 / ",
            Random => "random(0, 10000)",
            RandomWalk => "(a + (b - a) * f)",
            Perlin => "(2.0 / 3.0)",
        }
    }

    #[test]
    fn oscillator_emit_covers_every_waveform() {
        use crate::nodes::oscillator::config::Waveform as W;
        let all = [
            ("sinus", W::Sinus),
            ("square", W::Square),
            ("sawtooth", W::Sawtooth),
            ("triangle", W::Triangle),
            ("random", W::Random),
            ("randomwalk", W::RandomWalk),
            ("perlin", W::Perlin),
        ];
        for (wire, variant) in all {
            let e = crate::nodes::oscillator::codegen::emit(
                &node("Oscillator", json!({ "waveform": wire, "amplitude": 2.5 })),
                &NodeInputs::default(),
            ).unwrap();
            let body = e.loop_body.join("\n");
            let token = waveform_token(variant);
            assert!(
                body.contains(token),
                "Oscillator `{wire}` must emit its waveform math (`{token}`), got: {body}"
            );
        }
    }

    // ---- Midi: in/out × note/cc ------------------------------------------

    /// Both directions and both modes must transcribe the runtime's semantics:
    /// in-note filters note-on/off out of the shared pump; in-cc latches the
    /// configured control; out-note maps truthy→NoteOn / falsy→NoteOff; out-cc
    /// clamps and sends a control change on the configured control/channel.
    #[test]
    fn midi_emit_covers_both_directions_and_modes() {
        use crate::codegen::wire::SourceExpr;

        let in_note = crate::nodes::midi::codegen::emit(
            &node("Midi", json!({ "direction": "in", "mode": "note", "channel": 3 })),
            &NodeInputs::default(),
        ).unwrap();
        let body = in_note.loop_body.join("\n");
        assert!(body.contains("midi_rx_channel == 3"), "in-note channel filter: {body}");
        assert!(body.contains("0x90") && body.contains("0x80"), "in-note on/off: {body}");

        let in_cc = crate::nodes::midi::codegen::emit(
            &node("Midi", json!({ "direction": "in", "mode": "cc", "control": 7 })),
            &NodeInputs::default(),
        ).unwrap();
        assert!(
            in_cc.loop_body.join("\n").contains("0xB0 && midi_rx_data1 == 7"),
            "in-cc latches its control"
        );

        let mut send = NodeInputs::default();
        send.add("send", SourceExpr::level(CppExpr::number("v")));
        let out_note = crate::nodes::midi::codegen::emit(
            &node("Midi", json!({ "direction": "out", "mode": "note", "note": 64, "velocity": 90 })),
            &send,
        ).unwrap();
        let body = out_note.loop_body.join("\n");
        assert!(body.contains("sendNoteOn(64, 90,"), "out-note on: {body}");
        assert!(body.contains("sendNoteOff(64, 0,"), "out-note off: {body}");

        let out_cc = crate::nodes::midi::codegen::emit(
            &node("Midi", json!({ "direction": "out", "mode": "cc", "control": 7 })),
            &send,
        ).unwrap();
        assert!(
            out_cc.loop_body.join("\n").contains("sendControlChange(7, (byte)constrain"),
            "out-cc clamps + sends its control"
        );
    }

    // ---- Trigger: 2 behaviours -------------------------------------------

    /// EXHAUSTIVE over `TriggerBehaviour`: the direction comparison each
    /// variant must emit, transcribing `value_changes_in_correct_direction`.
    fn behaviour_token(b: crate::nodes::trigger::config::TriggerBehaviour) -> &'static str {
        use crate::nodes::trigger::config::TriggerBehaviour::{Decreasing, Increasing};
        match b {
            Increasing => "_direction = trigger_",
            Decreasing => "_direction = !(trigger_",
        }
    }

    #[test]
    fn trigger_emit_covers_every_behaviour() {
        use crate::nodes::trigger::config::TriggerBehaviour as B;
        let all = [("increasing", B::Increasing), ("decreasing", B::Decreasing)];
        for (wire, variant) in all {
            let e = crate::nodes::trigger::codegen::emit(
                &node("Trigger", json!({ "behaviour": wire, "threshold": 7.5 })),
                &input("value", CppExpr::number("a")),
            ).unwrap();
            let body = e.loop_body.join("\n");
            let token = behaviour_token(variant);
            assert!(
                body.contains(token),
                "Trigger `{wire}` must emit its direction check (`{token}`), got: {body}"
            );
            assert!(
                body.contains(">= 7.5"),
                "Trigger `{wire}` must compare against the configured threshold: {body}"
            );
        }
    }

    // ---- RangeMap / Delay / Interval / Constant / Function ---------------

    /// The runtime's linear remap plus its span-dependent rounding precision.
    #[test]
    fn range_map_emits_the_runtime_remap() {
        let e = crate::nodes::range_map::codegen::emit(
            &node(
                "RangeMap",
                json!({ "from": { "min": 0.0, "max": 100.0 }, "to": { "min": 0.0, "max": 255.0 } }),
            ),
            &input("value", CppExpr::number("a")),
        ).unwrap();
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("* (255.0 - 0.0) / (100.0 - 0.0)"),
            "RangeMap must emit the runtime's linear remap, got: {body}"
        );
        assert!(
            body.contains("round(") && body.contains("/ 1.0"),
            "output spans > 10 round to whole numbers, got: {body}"
        );
        let e = crate::nodes::range_map::codegen::emit(
            &node("RangeMap", json!({ "to": { "min": 0.0, "max": 5.0 } })),
            &input("value", CppExpr::number("a")),
        ).unwrap();
        assert!(
            e.loop_body.iter().any(|l| l.contains("/ 10.0")),
            "output spans <= 10 keep one decimal place"
        );
    }

    /// The configured delay drives the non-blocking deadline; the stored value
    /// is re-emitted on fire, like the runtime's delayed `event`. And the
    /// Sketch holds as many pending triggers as the runtime does — the
    /// config's `capacity`, which is what tells queue from debounce.
    #[test]
    fn delay_plumbs_config_into_the_deadline() {
        use crate::nodes::delay::config::DelayConfig;
        for forget_previous in [false, true] {
            let data = json!({ "delay": 750, "forgetPrevious": forget_previous });
            let capacity = crate::config::resolve::<DelayConfig>(&data).unwrap().capacity();
            let e = crate::nodes::delay::codegen::emit(
                &node("Delay", data),
                &input("trigger", CppExpr::boolean("v")),
            ).unwrap();
            let body = e.loop_body.join("\n");
            assert!(
                body.contains("millis() - ") && body.contains(">= 750UL"),
                "Delay must fire on a non-blocking elapsed-time compare, got: {body}"
            );
            assert!(
                body.contains("delay_p_value = delay_p_stored"),
                "Delay must re-emit the stored value on fire, got: {body}"
            );
            let slots = if capacity == 1 {
                "double delay_p_stored = 0.0;".to_string()
            } else {
                format!("double delay_p_stored[{capacity}];")
            };
            assert!(
                e.declarations.contains(&slots),
                "Delay must hold {capacity} pending trigger(s), got: {:?}",
                e.declarations
            );
        }
    }

    /// The configured interval drives the tick (clamped to the runtime's 16ms
    /// minimum); the payload is the elapsed time since the start window.
    #[test]
    fn interval_plumbs_config_into_the_tick() {
        let e = crate::nodes::interval::codegen::emit(
            &node("Interval", json!({ "interval": 500 })),
            &NodeInputs::default(),
        ).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains(">= 500UL"), "configured interval drives the tick: {body}");
        assert!(
            body.contains("(double)(millis() - interval_p_start)"),
            "payload is elapsed ms since the start window, like `now - started_at`: {body}"
        );
        let e = crate::nodes::interval::codegen::emit(
            &node("Interval", json!({ "interval": 1 })),
            &NodeInputs::default(),
        ).unwrap();
        assert!(
            e.loop_body.iter().any(|l| l.contains(">= 16UL")),
            "intervals below the runtime minimum clamp to 16ms"
        );
    }

    /// The configured value lands verbatim in the declaration; the only loop
    /// work is its one emission, on the first tick.
    #[test]
    fn constant_emits_the_configured_value() {
        let e = crate::nodes::constant::codegen::emit(&node("Constant", json!({ "value": 42.0 }))).unwrap();
        assert!(e.declarations.iter().any(|d| d.contains("= 42.0;")));
        assert_eq!(e.loop_body, ["constant_p_fired = !constant_p_started;", "constant_p_started = true;"]);
    }

    /// The JS expression subset translates into the same arithmetic; anything
    /// outside it emits an explicit note and leaves the runtime's 0.0 initial
    /// value — never guessed-at C++.
    #[test]
    fn function_emits_only_the_supported_subset() {
        let e = crate::nodes::function::codegen::emit(
            &node("Function", json!({ "code": "return input * 2;" })),
            &input("trigger", CppExpr::number("a")),
        ).unwrap();
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("(a)") && body.contains("* 2"),
            "translated JS must read its wired input and keep the arithmetic: {body}"
        );
        let e = crate::nodes::function::codegen::emit(
            &node("Function", json!({ "code": "while (input) {}" })),
            &NodeInputs::default(),
        ).unwrap();
        assert!(e.loop_body.is_empty(), "unsupported JS must not emit loop code");
        assert!(
            e.declarations.iter().any(|d| d.contains("// unsupported")),
            "unsupported JS is noted, value stays 0.0"
        );
    }

    // ---- Outputs: value-mapping transforms -------------------------------

    /// Led `value` applies the runtime's `as_u8` clamp and tracks `is_on` by
    /// the runtime's rule for the pin (`analog_write_lights_from`): from 1 on
    /// a PWM pin, from 128 on one without. Also covers Vibration, which shares
    /// the Led implementation on both sides.
    #[test]
    fn led_value_port_applies_the_runtime_brightness_clamp() {
        let uno = crate::codegen::board::target_by_id("uno").expect("uno is supported");
        for (pin, has_pwm) in [(9, true), (13, false)] {
            let e = crate::nodes::led::codegen::emit(
                &node("Led", json!({ "pin": pin })),
                &input("value", CppExpr::number("a")),
                &uno,
            ).unwrap();
            let body = e.loop_body.join("\n");
            assert!(
                body.contains("constrain((double)(a), 0.0, 255.0)"),
                "Led `value` must clamp like `ComponentValue::as_u8`: {body}"
            );
            assert!(body.contains("analogWrite("), "Led `value` is a PWM write: {body}");
            let lit_from = crate::firmata::analog_write_lights_from(Some(has_pwm));
            assert!(
                body.contains(&format!("_brightness >= {lit_from};")),
                "Led on pin {pin} must track the runtime's is_on: {body}"
            );
        }
    }

    /// EXHAUSTIVE over `RelayType`: the digital level "open" writes,
    /// transcribing the runtime's NO/NC inversion.
    fn relay_open_level(t: crate::nodes::relay::config::RelayType) -> &'static str {
        use crate::nodes::relay::config::RelayType::{NC, NO};
        match t {
            NO => "HIGH",
            NC => "LOW",
        }
    }

    #[test]
    fn relay_emit_covers_every_type() {
        use crate::nodes::relay::config::RelayType as R;
        let all = [("NO", R::NO), ("NC", R::NC)];
        for (wire, variant) in all {
            let e = crate::nodes::relay::codegen::emit(
                &node("Relay", json!({ "type": wire })),
                &input("true", CppExpr::boolean("a")),
            ).unwrap();
            let body = e.loop_body.join("\n");
            let level = relay_open_level(variant);
            assert!(
                body.contains(&format!("digitalWrite(relay_p_pin, {level}); relay_p_open = true")),
                "Relay `{wire}` open must write {level}, got: {body}"
            );
        }
    }

    /// EXHAUSTIVE over `ServoType`: the write each variant derives from a
    /// wired `value` — the standard clamp vs. the continuous dead-zone map.
    fn servo_token(t: crate::nodes::servo::config::ServoType) -> &'static str {
        use crate::nodes::servo::config::ServoType::{Continuous, Standard};
        match t {
            Standard => "(int)constrain(",
            Continuous => "? 90 : ",
        }
    }

    #[test]
    fn servo_emit_covers_every_type() {
        use crate::nodes::servo::config::ServoType as S;
        let uno = crate::codegen::board::target_by_id("uno").expect("uno is supported");
        let all = [("standard", S::Standard), ("continuous", S::Continuous)];
        for (wire, variant) in all {
            let e = crate::nodes::servo::codegen::emit(
                &node("Servo", json!({ "type": wire, "range": { "min": 10, "max": 170 } })),
                &input("value", CppExpr::number("a")),
                &uno,
            ).unwrap();
            let body = e.loop_body.join("\n");
            let token = servo_token(variant);
            assert!(
                body.contains(token),
                "Servo `{wire}` must emit its value mapping (`{token}`), got: {body}"
            );
        }
        // The standard clamp uses the configured range bounds.
        let e = crate::nodes::servo::codegen::emit(
            &node("Servo", json!({ "range": { "min": 10, "max": 170 } })),
            &input("value", CppExpr::number("a")),
            &uno,
        ).unwrap();
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("(double)10") && body.contains("(double)170"),
            "Servo clamp must use the configured range: {body}"
        );
    }

    /// Rgb reproduces the runtime's `channel * alpha` intensity math: alpha is
    /// a 0..=100 percent clamped to 0..=1, and common-anode inverts the write.
    #[test]
    fn rgb_emit_applies_the_runtime_color_math() {
        let mut inputs = NodeInputs::default();
        inputs.add("red", SourceExpr::level(CppExpr::number("a")));
        inputs.add("alpha", SourceExpr::level(CppExpr::number("b")));
        let e = crate::nodes::rgb::codegen::emit(&node("Rgb", json!({})), &inputs).unwrap();
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("/ 100.0, 0.0, 1.0)"),
            "alpha percent must clamp to 0..=1 intensity: {body}"
        );
        assert!(body.contains("* rgb_p_a"), "channels must scale by alpha: {body}");
        let e = crate::nodes::rgb::codegen::emit(
            &node("Rgb", json!({ "isAnode": true })),
            &input("red", CppExpr::number("a")),
        ).unwrap();
        assert!(
            e.loop_body.iter().any(|l| l.contains("(255 - ")),
            "common-anode inverts the written level"
        );
    }

    /// Pixel `value` selects a preset with the runtime's hex parsing and
    /// index clamp (`index.min(len - 1)`).
    #[test]
    fn pixel_value_selects_a_clamped_preset() {
        let e = crate::nodes::pixel::codegen::emit(
            &node("Pixel", json!({ "length": 4, "presets": [["#ff0000"], ["#0000ff"]] })),
            &input("value", CppExpr::number("a")),
        ).unwrap();
        let decls = e.declarations.join("\n");
        assert!(
            decls.contains("0xFF0000") && decls.contains("0x0000FF"),
            "presets must bake the runtime's parsed hex colors: {decls}"
        );
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("constrain(round(") && body.contains("0.0, 1.0)"),
            "the index must clamp to the preset list like the runtime: {body}"
        );
        assert!(body.contains("setPixelColor"), "the preset must reach the strip: {body}");
    }

    /// Matrix `value` selects a shape with the runtime's binary-row slicing
    /// and index clamp.
    #[test]
    fn matrix_value_selects_a_clamped_shape() {
        let e = crate::nodes::matrix::codegen::emit(
            &node("Matrix", json!({ "shapes": [["10000001"], ["11111111"]] })),
            &input("value", CppExpr::number("a")),
        ).unwrap();
        let decls = e.declarations.join("\n");
        assert!(
            decls.contains("0x81") && decls.contains("0xFF"),
            "shapes must bake the runtime's binary-row bytes: {decls}"
        );
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("constrain(round(") && body.contains("setRow("),
            "the clamped index must drive the row writes: {body}"
        );
    }

    /// EXHAUSTIVE over `StepperInterface`: the `AccelStepper` constructor
    /// each variant must emit, transcribing the runtime's `CMD_CONFIG` — the
    /// same interface constant, pin count, and pin order it sends over
    /// Firmata (driver = step/dir; two-/four-wire = motor pins 1–2 / 1–4).
    /// Whole-step only: the runtime never sets Firmata's half-step bits, so
    /// `FULL2WIRE`/`FULL4WIRE`, never the `HALF*` variants.
    fn stepper_interface_token(i: crate::nodes::stepper::config::StepperInterface) -> &'static str {
        use crate::nodes::stepper::config::StepperInterface::{Driver, FourWire, TwoWire};
        match i {
            Driver => "(AccelStepper::DRIVER, 11, 12)",
            TwoWire => "(AccelStepper::FULL2WIRE, 21, 22)",
            FourWire => "(AccelStepper::FULL4WIRE, 21, 22, 23, 24)",
        }
    }

    #[test]
    fn stepper_emit_covers_every_interface() {
        use crate::nodes::stepper::config::StepperInterface as I;
        let all = [("driver", I::Driver), ("two_wire", I::TwoWire), ("four_wire", I::FourWire)];
        for (wire, variant) in all {
            let e = crate::nodes::stepper::codegen::emit(
                &node(
                    "Stepper",
                    json!({
                        "interface": wire,
                        "stepPin": 11, "dirPin": 12,
                        "motorPin1": 21, "motorPin2": 22, "motorPin3": 23, "motorPin4": 24,
                    }),
                ),
                &input("value", CppExpr::number("a")),
            ).unwrap();
            let decls = e.declarations.join("\n");
            let token = stepper_interface_token(variant);
            assert!(
                decls.contains(token),
                "Stepper `{wire}` must construct `{token}`, got: {decls}"
            );
            // The runtime skips zero-step samples; the emitted move must too.
            let body = e.loop_body.join("\n");
            assert!(
                body.contains("!= 0") && body.contains(".move("),
                "Stepper `value` is a zero-skipping relative move: {body}"
            );
        }
        let e = crate::nodes::stepper::codegen::emit(
            &node("Stepper", json!({})),
            &input("to", CppExpr::number("a")),
        ).unwrap();
        assert!(
            e.loop_body.iter().any(|l| l.contains(".moveTo((long)")),
            "Stepper `to` is an absolute target, like CMD_TO"
        );
    }

    /// EXHAUSTIVE over `PiezoType`: buzz maps to the built-in `tone(...)`;
    /// song playback is host-only and emits an explicit note (the trigger
    /// still buzzes the base frequency).
    fn piezo_token(t: crate::nodes::piezo::config::PiezoType) -> &'static str {
        use crate::nodes::piezo::config::PiezoType::{Buzz, Song};
        match t {
            Buzz => "tone(piezo_p_pin, 880, 250)",
            Song => "song playback",
        }
    }

    #[test]
    fn piezo_emit_covers_every_type() {
        use crate::nodes::piezo::config::PiezoType as P;
        let all = [("buzz", P::Buzz), ("song", P::Song)];
        for (wire, variant) in all {
            let e = crate::nodes::piezo::codegen::emit(
                &node("Piezo", json!({ "type": wire, "frequency": 880, "duration": 250 })),
                &input("trigger", CppExpr::boolean("a")),
            ).unwrap();
            let text = [e.declarations.join("\n"), e.loop_body.join("\n")].join("\n");
            let token = piezo_token(variant);
            assert!(
                text.contains(token),
                "Piezo `{wire}` must emit `{token}`, got: {text}"
            );
        }
    }

    // ---- I2cDevice: 3 output formats -------------------------------------

    /// EXHAUSTIVE over `OutputFormat`, driven by the SHARED decode descriptor
    /// (`OutputFormat::decode`, the one the runtime interprets via
    /// `fold_bytes`): the token the emitted fold must carry per descriptor.
    /// Raw has no on-device byte-array value model, so it folds like
    /// `UnsignedInt` — the closest single-value approximation, recorded here.
    fn i2c_format_token(f: crate::nodes::i2c_device::config::OutputFormat) -> &'static str {
        use crate::nodes::i2c_device::config::ByteDecode;
        match f.decode() {
            ByteDecode::Raw | ByteDecode::Fold { sign_extend: false } => "<< 8",
            ByteDecode::Fold { sign_extend: true } => "= -1",
        }
    }

    #[test]
    fn i2c_emit_covers_every_output_format() {
        use crate::nodes::i2c_device::config::OutputFormat as F;
        let all = [("raw", F::Raw), ("unsigned_int", F::UnsignedInt), ("signed_int", F::SignedInt)];
        for (wire, variant) in all {
            let e = crate::nodes::i2c_device::codegen::emit(
                &node("I2cDevice", json!({ "output": wire })),
                &NodeInputs::default(),
            ).unwrap();
            let body = e.loop_body.join("\n");
            let token = i2c_format_token(variant);
            assert!(
                body.contains(token),
                "I2cDevice `{wire}` must emit its decode (`{token}`), got: {body}"
            );
        }
        // The signed fold sign-extends from the MSB, like the runtime.
        let e = crate::nodes::i2c_device::codegen::emit(
            &node("I2cDevice", json!({ "output": "signed_int" })),
            &NodeInputs::default(),
        ).unwrap();
        assert!(
            e.loop_body.iter().any(|l| l.contains("& 0x80")),
            "signed decode must test the sign bit of the first byte"
        );
        // The fold cap is part of the descriptor: `fold_bytes` ignores bytes
        // past `FOLD_BYTE_CAP`, so a longer read must guard the emitted fold
        // too (unguarded, the 32-bit `long` kept the LAST 4 bytes instead).
        let cap = crate::nodes::i2c_device::config::OutputFormat::FOLD_BYTE_CAP;
        let e = crate::nodes::i2c_device::codegen::emit(
            &node("I2cDevice", json!({ "output": "unsigned_int", "readLength": cap + 2 })),
            &NodeInputs::default(),
        ).unwrap();
        assert!(
            e.loop_body.iter().any(|l| l.contains(&format!("< {cap}) {{"))),
            "reads past the shared FOLD_BYTE_CAP must cap the fold like the runtime"
        );
    }

    // ---- Inputs with a read transform: Button, Switch --------------------

    /// A pull-up Button reads active-low; the emitted state inverts the raw
    /// read so "pressed = true" matches the runtime.
    #[test]
    fn button_emit_covers_the_pullup_inversion() {
        let e = crate::nodes::button::codegen::emit(&node("Button", json!({ "isPullup": true }))).unwrap();
        assert!(e.setup.iter().any(|s| s.contains("INPUT_PULLUP")));
        assert!(
            e.loop_body.iter().any(|l| l.contains("== LOW")),
            "pull-up reads are active-low and must invert"
        );
        let e = crate::nodes::button::codegen::emit(&node("Button", json!({}))).unwrap();
        assert!(
            e.loop_body.iter().any(|l| l.contains("== HIGH")),
            "plain INPUT reads HIGH on press"
        );
    }

    /// Every controller's conversion to centimetres reaches the sketch, with
    /// the runtime's constants (`ProximityConfig::ranging`, EXHAUSTIVE over
    /// `Ranging`), and the distance moves only by more than `MIN_MOVE_CM`.
    #[test]
    fn proximity_emits_its_controllers_conversion() {
        use crate::codegen::emit::cpp_double;
        use crate::nodes::proximity::config::{ProximityConfig, Ranging, MIN_MOVE_CM};
        let uno = crate::codegen::board::target_by_id("uno").expect("uno is supported");
        for controller in ["GP2Y0A21YK", "GP2Y0A02YK0F", "HCSR04", "GP2Y0A710K0F"] {
            let data = json!({ "controller": controller });
            let ranging = crate::config::resolve::<ProximityConfig>(&data).unwrap().ranging();
            let e = crate::nodes::proximity::codegen::emit(&node("Proximity", data), &uno).unwrap();
            let body = e.loop_body.join("\n");
            let constants = match ranging {
                Ranging::Infrared { scale, offset, near, far } => [scale, offset, near, far],
                Ranging::Linear { numerator, denominator, near, far } => [numerator, denominator, near, far],
            };
            for constant in constants {
                assert!(body.contains(&cpp_double(constant)), "`{controller}` must emit {constant}: {body}");
            }
            assert!(body.contains(&format!("> {})", cpp_double(MIN_MOVE_CM))), "`{controller}`: {body}");
        }
    }

    /// A Sensor's value moves only by its `threshold`, as the runtime's does.
    #[test]
    fn sensor_moves_its_value_by_its_threshold() {
        let uno = crate::codegen::board::target_by_id("uno").expect("uno is supported");
        let e = crate::nodes::sensor::codegen::emit(&node("Sensor", json!({ "threshold": 7 })), &uno).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains(") >= 7)"), "{body}");
    }

    /// EXHAUSTIVE over `SwitchType`: the read comparison per contact type,
    /// transcribing the runtime's NO/NC inversion.
    fn switch_read_token(t: crate::nodes::switch::config::SwitchType) -> &'static str {
        use crate::nodes::switch::config::SwitchType::{NC, NO};
        match t {
            NO => "== LOW",
            NC => "== HIGH",
        }
    }

    #[test]
    fn switch_emit_covers_every_type() {
        use crate::nodes::switch::config::SwitchType as S;
        let all = [("NO", S::NO), ("NC", S::NC)];
        for (wire, variant) in all {
            let e = crate::nodes::switch::codegen::emit(&node("Switch", json!({ "type": wire }))).unwrap();
            let body = e.loop_body.join("\n");
            let token = switch_read_token(variant);
            assert!(
                body.contains(token),
                "Switch `{wire}` must read `{token}`, got: {body}"
            );
        }
    }

    /// The live Switch closes on the same level the sketch reads as closed,
    /// and both on the level the Switch docs give (NC: HIGH is active). The
    /// sketch used to read every type the other way round.
    #[cfg(feature = "runtime")]
    #[test]
    fn switch_runtime_closes_on_the_level_the_sketch_reads() {
        use crate::firmata::sim::rig::{node as rig_node, SimRig};
        use crate::firmata::sim::{BoardLayout, SimBoard};
        use crate::runtime::ComponentValue;
        for (wire, closed_on_high) in [("NO", false), ("NC", true)] {
            let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
            rig.apply_flow(vec![rig_node("sw", "Switch", json!({ "pin": 2, "type": wire }))], vec![]);
            // Drive the line LOW, then HIGH: the second edge must be reported,
            // so an absent report cannot pass for "open".
            rig.advance(100);
            rig.board.drive_pin(2, false);
            rig.pump();
            rig.advance(100);
            rig.take_events();
            rig.board.drive_pin(2, true);
            rig.pump();
            let Some(&ComponentValue::Bool(live_closed)) = rig.last_value("sw") else {
                panic!("live Switch `{wire}` reported nothing for LOW -> HIGH: {:?}", rig.events());
            };
            assert_eq!(live_closed, closed_on_high, "live Switch `{wire}` with the line HIGH");

            let e = crate::nodes::switch::codegen::emit(&node("Switch", json!({ "type": wire }))).unwrap();
            let sketch_closed = e.loop_body.join("\n").contains("== HIGH");
            assert_eq!(sketch_closed, live_closed, "sketch and live agree for `{wire}`");
        }
    }

    /// An Mqtt node's stored `direction` means the same live and in the
    /// sketch: exactly `"publish"` publishes, anything else — a missing
    /// direction, `"Subscribe"`, an empty one — subscribes, as the editor
    /// draws it. The sketch used to subscribe where the runtime did nothing.
    #[cfg(feature = "runtime")]
    #[test]
    fn an_mqtt_direction_means_the_same_to_both_halves() {
        use crate::runtime::cloud::test_support::with_test_ctx;
        use crate::runtime::ComponentValue;

        let registry = crate::runtime::ComponentRegistry::new();
        let stored = [Some(json!("publish")), Some(json!("subscribe")), Some(json!("Subscribe")), Some(json!("Publish")), Some(json!("")), None];
        for direction in stored {
            let mut data = json!({ "brokerId": "b", "topic": "t" });
            if let Some(direction) = direction {
                data["direction"] = direction;
            }
            let mut live = registry.create("p", "Mqtt", &data).expect("an Mqtt node builds");
            let live_subscribes = !live.subscriber_wiring().is_empty();
            let live_publishes =
                with_test_ctx("p", |ctx| live.dispatch("trigger", ComponentValue::Number(1.0), ctx)).is_ok();

            let e = emission("Mqtt", &data, Some("trigger"));
            let sketch_subscribes = e.declarations.join("\n").contains(".subscribe(");
            let sketch_publishes = e.loop_body.join("\n").contains(".publish(");

            assert_eq!((sketch_subscribes, sketch_publishes), (live_subscribes, live_publishes), "{data}");
            assert_ne!(live_subscribes, live_publishes, "{data}: one or the other");
            let publishes = data["direction"] == "publish";
            assert_eq!(live_publishes, publishes, "{data}");
        }
    }

    // ---- Unreadable settings: one fact for both halves -------------------

    /// The registered node types whose Arduino export reads no settings, so a
    /// `data` the live runtime cannot read still exports. Every other type
    /// must refuse to export what the runtime refuses to build.
    #[cfg(feature = "runtime")]
    fn exports_without_reading_settings(node_type: &str) -> Option<&'static str> {
        match node_type {
            "Counter" => Some("has no settings"),
            "Monitor" => Some("its broker details come from the credentials surface, not its config"),
            "Note" | "Pn532" | "Music" => Some("no Arduino emitter — exported as a placeholder comment"),
            _ => None,
        }
    }

    /// Interpret and emit read a Node's `data` through the same resolution
    /// (`crate::config::resolve`), so they agree on what is unreadable: the
    /// live registry reports it as a build failure (Node health), sketch
    /// generation as an error naming the Node — for every registered type,
    /// driven from the live registry so a new node cannot skip it.
    #[cfg(feature = "runtime")]
    #[test]
    fn settings_the_runtime_cannot_read_refuse_the_sketch_too() {
        use crate::codegen::validate::ProblemSeverity;
        use crate::runtime::RuntimeError;

        let registry = crate::runtime::ComponentRegistry::new();
        let target = crate::codegen::board::target_by_id("esp32").expect("esp32 is supported");
        let unreadable = json!("not an object");
        let mut names: Vec<&String> = registry.declared().keys().collect();
        names.sort();
        for name in names {
            let live = registry.create("p", name, &unreadable).err();
            assert!(
                matches!(live, Some(RuntimeError::ConfigDeserialize { .. })),
                "the runtime must refuse to build `{name}`, got {live:?}"
            );

            let flow = crate::flow::FlowUpdate { nodes: vec![node(name, unreadable.clone())], edges: vec![] };
            let outcome = crate::codegen::generate(&flow, &target).expect("generation never errors");
            let errors: Vec<_> =
                outcome.problems.iter().filter(|p| p.severity == ProblemSeverity::Error).collect();
            if let Some(why) = exports_without_reading_settings(name) {
                assert!(outcome.sketch.is_some() && errors.is_empty(), "`{name}` ({why}): {errors:?}");
                continue;
            }
            assert_eq!(outcome.sketch, None, "`{name}` must not be exported on substituted defaults");
            assert_eq!(errors.len(), 1, "`{name}`: {:?}", outcome.problems);
            assert_eq!((errors[0].node_id.as_str(), errors[0].node_type.as_str()), ("p", name.as_str()));
            assert!(
                errors[0].message.contains("its settings could not be read"),
                "`{name}`: {}",
                errors[0].message
            );
        }
    }

    /// An analog reader's pin is resolved once, in its config, so the two
    /// halves cannot place it differently: a label that names no pin is
    /// unreadable for both, and a readable one lands on the same board pin.
    #[cfg(feature = "runtime")]
    #[test]
    fn an_analog_readers_pin_means_the_same_to_both_halves() {
        use crate::firmata::sim::rig::{node as rig_node, SimRig};
        use crate::firmata::sim::{BoardLayout, SimBoard};
        use crate::firmata::MODE_ANALOG;

        let registry = crate::runtime::ComponentRegistry::new();
        let uno = crate::codegen::board::target_by_id("uno").expect("uno is supported");
        for kind in ["Sensor", "Potentiometer", "Proximity"] {
            let unreadable = json!({ "pin": "banana" });
            assert!(registry.create("p", kind, &unreadable).is_err(), "live `{kind}` must not run");
            let flow = crate::flow::FlowUpdate { nodes: vec![node(kind, unreadable)], edges: vec![] };
            let outcome = crate::codegen::generate(&flow, &uno).unwrap();
            assert_eq!(outcome.sketch, None, "`{kind}` must not be exported on A0");
            assert!(
                outcome.problems[0].message.ends_with("its settings could not be read (pin: invalid pin: banana)"),
                "{:?}",
                outcome.problems
            );

            // A1 is pin 15 on the Uno, live and in the sketch.
            let mut rig = SimRig::connect(SimBoard::new(BoardLayout::uno()));
            rig.apply_flow(vec![rig_node("p", kind, json!({ "pin": "A1" }))], vec![]);
            assert_eq!(rig.board.pin(15).mode(), Some(MODE_ANALOG), "live `{kind}`");
            let flow = crate::flow::FlowUpdate { nodes: vec![node(kind, json!({ "pin": "A1" }))], edges: vec![] };
            let s = crate::codegen::generate(&flow, &uno).unwrap().sketch.expect("fits the uno");
            assert!(s.contains("_pin = 15; // A1"), "sketch `{kind}`:\n{s}");
        }
    }

    // ---- The wire interface: both halves honour what is declared, and only that

    /// Every registered node type with its declared Ports and Emits, by name.
    #[cfg(feature = "runtime")]
    fn declared() -> Vec<(String, &'static [&'static str], &'static [&'static str])> {
        let registry = crate::runtime::ComponentRegistry::new();
        let mut all: Vec<_> =
            registry.declared().iter().map(|(name, (ports, emits))| (name.clone(), *ports, *emits)).collect();
        all.sort();
        assert!(!all.is_empty(), "the registry must declare its node types");
        all
    }

    /// The settings a type is checked under: its defaults, then the settings
    /// that give it other Ports and Emits (an Mqtt node publishes or
    /// subscribes) — the Rust twin of the `variants` in the editor's Handle
    /// Rules.
    #[cfg(feature = "runtime")]
    fn settings(node_type: &str) -> Vec<serde_json::Value> {
        let mut all = vec![json!({})];
        match node_type {
            "Mqtt" => all.push(json!({ "direction": "publish" })),
            "Midi" => all.push(json!({ "direction": "out" })),
            "Servo" => all.push(json!({ "type": "continuous" })),
            _ => {}
        }
        all
    }

    /// A type whose component takes a Port under any name the Author gives it
    /// (a `{{variable}}`): no closed list holds its Ports.
    #[cfg(feature = "runtime")]
    fn has_open_ports(node_type: &str) -> bool {
        matches!(node_type, "Function" | "Llm")
    }

    /// The one declared Port no edge delivers: the Runtime Host dispatches a
    /// key press on it, and a board has no keyboard.
    #[cfg(feature = "runtime")]
    fn host_delivered(node_type: &str, port: &str) -> bool {
        (node_type, port) == ("Hotkey", "key_event")
    }

    /// The types exported as a placeholder comment, whatever is wired to them.
    #[cfg(feature = "runtime")]
    fn has_no_emitter(node_type: &str) -> bool {
        matches!(node_type, "Note" | "Pn532" | "Music")
    }

    /// What the emitter writes for one `node_type` Node with a number wired
    /// into `port`, or with nothing wired.
    #[cfg(feature = "runtime")]
    fn emission(
        node_type: &str,
        data: &serde_json::Value,
        port: Option<&str>,
    ) -> crate::codegen::emit::NodeEmission {
        let target = crate::codegen::board::target_by_id("esp32").expect("esp32 is supported");
        let inputs = port.map_or_else(NodeInputs::default, |port| input(port, CppExpr::number("src")));
        let flow = crate::flow::FlowUpdate { nodes: vec![node(node_type, data.clone())], edges: vec![] };
        let outputs = super::super::Outputs::new(&flow);
        super::super::emit_node(&flow.nodes[0], &inputs, &target, None, &outputs)
            .unwrap_or_else(|e| panic!("`{node_type}` with {data} must be readable: {e}"))
    }

    /// `emission` without its `// note:` lines: the C++ that runs.
    #[cfg(feature = "runtime")]
    fn code(mut emission: crate::codegen::emit::NodeEmission) -> crate::codegen::emit::NodeEmission {
        emission.declarations.retain(|line| !line.trim_start().starts_with("// note:"));
        emission
    }

    /// Every Port a component declares reaches its sketch: an edge into it
    /// either generates code or is refused in so many words (a `// note:`).
    /// A Port that changes nothing in the sketch is one the emitter does not
    /// know — bind it in `nodes/<node>/codegen.rs`, or note why the board
    /// cannot do it. Driven from the live registry, so a new Port cannot skip
    /// it.
    #[cfg(feature = "runtime")]
    #[test]
    fn every_declared_port_reaches_the_sketch_or_is_refused_in_it() {
        let mut silent = Vec::new();
        for (name, ports, _) in declared() {
            if has_no_emitter(&name) {
                continue;
            }
            for &port in ports {
                if host_delivered(&name, port) {
                    continue;
                }
                let reaches = settings(&name)
                    .iter()
                    .any(|data| emission(&name, data, Some(port)) != emission(&name, data, None));
                if !reaches {
                    silent.push(format!("{name}.{port}"));
                }
            }
        }
        assert!(silent.is_empty(), "declared Ports the sketch neither honours nor refuses: {silent:?}");
    }

    /// The sketch honours no Port a component does not declare: an edge into
    /// one generates no code, at most a `// note:`. The names tried are every
    /// Port any component declares, so a Port taken off one component's
    /// `ports()` and left in its emitter fails here.
    #[cfg(feature = "runtime")]
    #[test]
    fn the_sketch_honours_no_port_a_component_does_not_declare() {
        let all = declared();
        let names: std::collections::BTreeSet<&str> =
            all.iter().flat_map(|(_, ports, _)| ports.iter().copied()).chain(["read"]).collect();
        let mut honoured = Vec::new();
        for (name, ports, _) in &all {
            if has_open_ports(name) {
                continue;
            }
            for &port in names.iter().filter(|port| !ports.contains(port)) {
                for data in settings(name) {
                    if code(emission(name, &data, Some(port))) != code(emission(name, &data, None)) {
                        honoured.push(format!("{name}.{port} with {data}"));
                    }
                }
            }
        }
        assert!(honoured.is_empty(), "undeclared Ports the sketch honours: {honoured:?}");
    }

    /// Only an Emit a component declares has an on-device value: an edge out
    /// of any other handle is noted in the sketch as carrying nothing.
    #[cfg(feature = "runtime")]
    #[test]
    fn only_a_declared_emit_has_an_on_device_value() {
        let all = declared();
        let names: std::collections::BTreeSet<&str> =
            all.iter().flat_map(|(_, _, emits)| emits.iter().copied()).collect();
        let mut undeclared = Vec::new();
        for (name, _, emits) in &all {
            for &handle in names.iter().filter(|handle| !emits.contains(handle)) {
                for data in settings(name) {
                    if on_device_value(name, &data, handle).is_some() {
                        undeclared.push(format!("{name}.{handle} with {data}"));
                    }
                    if super::super::no_value_reason(name, handle).is_some() {
                        undeclared.push(format!("{name}.{handle} is refused, but not declared"));
                    }
                }
            }
        }
        assert!(undeclared.is_empty(), "undeclared Emits the sketch gives a value: {undeclared:?}");
    }

    /// What a `node_type` Node with `data` hands on to an edge out of
    /// `handle`, in a Flow where a Constant feeds each of its declared Ports.
    #[cfg(feature = "runtime")]
    fn on_device_value(
        node_type: &str,
        data: &serde_json::Value,
        handle: &str,
    ) -> Option<crate::codegen::wire::SourceExpr> {
        let registry = crate::runtime::ComponentRegistry::new();
        let ports = registry.declared().get(node_type).map_or(&[][..], |(ports, _)| *ports);
        let mut nodes = vec![node(node_type, data.clone())];
        let mut edges = Vec::new();
        for (i, port) in ports.iter().enumerate() {
            let feed = format!("feed-{i}");
            nodes.push(id_node(&feed, "Constant", json!({ "value": 1.0 })));
            edges.push(flow_edge(&feed, "value", "p", port));
        }
        let flow = crate::flow::FlowUpdate { nodes, edges };
        super::super::Outputs::new(&flow).of(&flow.nodes[0], handle)
    }

    /// Every Emit a component declares has an on-device value, under some of
    /// the settings its Handle Rules know, or is refused in so many words: on
    /// the reasoned list `codegen::no_value_reason`, whose reason the sketch's
    /// note gives. A declared Emit with neither — a new node's output, or one
    /// the emitter forgot — fails here, so "works live, does nothing once
    /// uploaded" cannot ship silently. And an Emit on the refusal list must
    /// truly have no value under some settings, so the list cannot go stale.
    /// Driven from the live registry.
    #[cfg(feature = "runtime")]
    #[test]
    fn every_declared_emit_has_an_on_device_value_or_a_reasoned_refusal() {
        let mut silent = Vec::new();
        let mut stale = Vec::new();
        for (name, _, emits) in declared() {
            for &handle in emits {
                let valued: Vec<bool> =
                    settings(&name).iter().map(|data| on_device_value(&name, data, handle).is_some()).collect();
                match super::super::no_value_reason(&name, handle) {
                    None if !valued.contains(&true) => silent.push(format!("{name}.{handle}")),
                    Some(_) if !valued.contains(&false) => stale.push(format!("{name}.{handle}")),
                    _ => {}
                }
            }
        }
        assert!(silent.is_empty(), "declared Emits with no on-device value and no reason given: {silent:?}");
        assert!(stale.is_empty(), "refused Emits that do have an on-device value: {stale:?}");
    }

    /// What the live component of `node_type` with `data` emits for each of
    /// two identical dispatches of `input` on `port`: `(first, second)`, each
    /// a list of `(handle, value carried, whether that value is the node's own
    /// stored value after the dispatch)`. `None` when the component refuses
    /// the input.
    #[cfg(feature = "runtime")]
    #[allow(clippy::type_complexity)]
    fn live_emissions(
        node_type: &str,
        data: &serde_json::Value,
        port: &str,
        input: &crate::runtime::ComponentValue,
    ) -> Option<(Vec<(String, crate::runtime::ComponentValue, bool)>, Vec<(String, crate::runtime::ComponentValue, bool)>)>
    {
        use crate::runtime::cloud::test_support::with_test_ctx;
        use crate::runtime::EventSink;

        let registry = crate::runtime::ComponentRegistry::new();
        let mut component = registry.create("p", node_type, data).ok()?;
        let sink = EventSink::default();
        component.set_sink(sink.clone());
        let mut once = || {
            with_test_ctx("p", |ctx| component.dispatch(port, input.clone(), ctx)).ok()?;
            let stored = component.value();
            Some(
                sink.borrow_mut()
                    .drain(..)
                    .map(|e| (e.source_handle.to_string(), e.value.clone(), e.value == stored))
                    .collect::<Vec<_>>(),
            )
        };
        let first = once()?;
        let second = once()?;
        Some((first, second))
    }

    /// The inputs the guards below send each Port: a number and a boolean,
    /// each truthy and falsy, so a boolean Node shows both its sides.
    #[cfg(feature = "runtime")]
    fn guard_inputs() -> [crate::runtime::ComponentValue; 4] {
        use crate::runtime::ComponentValue::{Bool, Number};
        [Number(1.0), Number(0.0), Bool(true), Bool(false)]
    }

    /// An Emit the live Node sends again when the same value reaches it again,
    /// carrying what it carried the first time, is an **event** in the sketch:
    /// it fires each time its Node runs. A change detector over its value
    /// would see nothing the second time. (A Compare's `true` on each check
    /// that passes; a `RangeMap`'s `to` on each value it maps.) Driven from the
    /// live registry, over every declared Port of every Node — but for a Port
    /// the sketch refuses (an `I2cDevice`'s `write`), whose input never runs
    /// on the board.
    #[cfg(feature = "runtime")]
    #[test]
    fn an_emit_the_live_node_repeats_for_a_repeated_input_is_an_event_in_the_sketch() {
        let mut levels = std::collections::BTreeSet::new();
        for (name, ports, _) in declared() {
            if has_no_emitter(&name) {
                continue;
            }
            for &port in ports {
                for data in settings(&name) {
                    if code(emission(&name, &data, Some(port))) == code(emission(&name, &data, None)) {
                        continue;
                    }
                    for input in guard_inputs() {
                        let Some((first, second)) = live_emissions(&name, &data, port, &input) else { continue };
                        for (handle, value, _) in &second {
                            let repeated = first.iter().any(|(h, v, _)| h == handle && v == value);
                            let on_device = on_device_value(&name, &data, handle);
                            if repeated && on_device.is_some_and(|s| s.fired.is_none()) {
                                levels.insert(format!("{name}.{handle} (sent again on `{port}` with {data})"));
                            }
                        }
                    }
                }
            }
        }
        assert!(levels.is_empty(), "Emits the live Node repeats but the sketch fires only on a change: {levels:?}");
    }

    /// An Emit that carries the live Node's own value — a boolean Node's
    /// `true` and `false`, a Pixel's `event` — carries the same on-device
    /// value as its `value` Emit: `false` carries the result, `false`, not
    /// its negation. Driven from the live registry, over every declared Port.
    #[cfg(feature = "runtime")]
    #[test]
    fn an_emit_that_carries_the_nodes_value_carries_the_same_value_in_the_sketch() {
        let mut differ = std::collections::BTreeSet::new();
        for (name, ports, emits) in declared() {
            if has_no_emitter(&name) || !emits.contains(&"value") {
                continue;
            }
            for &port in ports {
                for data in settings(&name) {
                    let Some(value) = on_device_value(&name, &data, "value") else { continue };
                    for input in guard_inputs() {
                        let Some((first, second)) = live_emissions(&name, &data, port, &input) else { continue };
                        for (handle, _, own) in first.iter().chain(&second) {
                            let Some(carried) = on_device_value(&name, &data, handle) else { continue };
                            if *own && carried.value != value.value {
                                differ.insert(format!(
                                    "{name}.{handle} carries `{}`, its `value` `{}`",
                                    carried.value.code, value.value.code
                                ));
                            }
                        }
                    }
                }
            }
        }
        assert!(differ.is_empty(), "Emits that carry the Node's value but not in the sketch: {differ:?}");
    }

    /// The live runtime takes every Port a component declares, under some
    /// settings, and refuses every other name: an edge into a handle the
    /// component does not declare shows on the Node as a rejected input. A
    /// `dispatch` arm left behind for a Port that is no longer declared fails
    /// here.
    #[cfg(feature = "runtime")]
    #[test]
    fn the_runtime_takes_its_declared_ports_and_refuses_any_other() {
        use crate::runtime::cloud::test_support::with_test_ctx;
        use crate::runtime::ComponentValue;

        let registry = crate::runtime::ComponentRegistry::new();
        let all = declared();
        let names: std::collections::BTreeSet<&str> =
            all.iter().flat_map(|(_, ports, _)| ports.iter().copied()).chain(["read"]).collect();
        let dispatch = |name: &str, data: &serde_json::Value, port: &str| {
            let mut component = registry
                .create("p", name, data)
                .unwrap_or_else(|e| panic!("`{name}` with {data} must build: {e}"));
            with_test_ctx("p", |ctx| component.dispatch(port, ComponentValue::Number(1.0), ctx))
        };

        let mut wrong = Vec::new();
        for (name, ports, _) in &all {
            for &port in *ports {
                if !settings(name).iter().any(|data| dispatch(name, data, port).is_ok()) {
                    wrong.push(format!("{name} refuses its declared Port `{port}`"));
                }
            }
            if has_open_ports(name) {
                continue;
            }
            for &port in names.iter().filter(|port| !ports.contains(port)) {
                for data in settings(name) {
                    if dispatch(name, &data, port).is_ok() {
                        wrong.push(format!("{name} with {data} takes `{port}`, which it does not declare"));
                    }
                }
            }
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    // ---- The exhaustive per-node classification --------------------------

    /// A node type's interpret↔emit parity status: a behavioural case that
    /// feeds inputs and asserts the emitted C++ encodes the runtime's
    /// transform, or a conscious exemption naming why none exists.
    #[cfg(feature = "runtime")]
    enum Parity {
        Case(fn()),
        Exempt(&'static str),
    }

    /// EXHAUSTIVE over every name the live `ComponentRegistry` registers (the
    /// guard below drives this from `declared()`): a newly registered node
    /// type hits the `other =>` arm and fails until the author adds a
    /// behavioural case above or records an exemption here — in one place, so
    /// the emit-or-explain decision is always conscious.
    #[cfg(feature = "runtime")]
    fn classify(node_type: &str) -> Parity {
        use Parity::{Case, Exempt};
        match node_type {
            // transformation
            "Calculate" => Case(calculate_emit_covers_every_function),
            "Compare" => Case(compare_emit_covers_every_validator),
            "Gate" => Case(gate_emit_covers_every_gate),
            "RangeMap" => Case(range_map_emits_the_runtime_remap),
            "Smooth" => Case(smooth_emit_covers_every_type),
            "Function" => Case(function_emits_only_the_supported_subset),
            // control / generator
            "Counter" => Case(counter_ports_classified_for_codegen),
            "Delay" => Case(delay_plumbs_config_into_the_deadline),
            "Trigger" => Case(trigger_emit_covers_every_behaviour),
            "Constant" => Case(constant_emits_the_configured_value),
            "Interval" => Case(interval_plumbs_config_into_the_tick),
            "Oscillator" => Case(oscillator_emit_covers_every_waveform),
            // output (Vibration shares the Led impl on both sides)
            "Led" | "Vibration" => Case(led_value_port_applies_the_runtime_brightness_clamp),
            "Relay" => Case(relay_emit_covers_every_type),
            "Servo" => Case(servo_emit_covers_every_type),
            "Rgb" => Case(rgb_emit_applies_the_runtime_color_math),
            "Pixel" => Case(pixel_value_selects_a_clamped_preset),
            "Matrix" => Case(matrix_value_selects_a_clamped_shape),
            "Stepper" => Case(stepper_emit_covers_every_interface),
            "Piezo" => Case(piezo_emit_covers_every_type),
            // input
            "I2cDevice" => Case(i2c_emit_covers_every_output_format),
            "Button" => Case(button_emit_covers_the_pullup_inversion),
            "Switch" => Case(switch_emit_covers_every_type),
            "Motion" => Exempt("plain digitalRead-HIGH into a state variable — no value transform"),
            "Hotkey" => Exempt("host-keyboard source; on-device the state stays false by design"),
            "Pn532" => Exempt("no Arduino emitter yet — falls through to the placeholder comment"),
            // Analog readers (Sensor backs the specialised aliases).
            "Sensor" | "Force" | "HallEffect" | "Ldr" | "Potentiometer" | "Tilt" => {
                Case(sensor_moves_its_value_by_its_threshold)
            }
            "Proximity" => Case(proximity_emits_its_controllers_conversion),
            "Note" => Exempt("canvas annotation — no ports, no emits, no device behaviour"),
            "Midi" => Case(midi_emit_covers_both_directions_and_modes),
            "Music" => Exempt(
                "host audio playback (a file on the laptop) — no device equivalent; the \
                 Arduino export omits it",
            ),
            // cloud
            "Monitor" | "Mqtt" | "Figma" | "Llm" => Exempt(
                "network transport side-effect; bring-up and topic plumbing are pinned by \
                 the emitter's own tests. Values do NOT all cross unchanged: a number is \
                 sent as Arduino's String(double) (two decimals) and a received payload \
                 parsed with toFloat(), where the runtime writes and reads JSON values",
            ),
            other => panic!(
                "node type `{other}` has no interpret↔emit parity classification — add a \
                 behavioural case or a one-line exemption in codegen/parity.rs::classify."
            ),
        }
    }

    /// Drive `classify` from the live registry so the classification can
    /// never lag reality: registering a node type (ADR-0007's catalog set)
    /// makes this test reach its `classify` arm — or the panic.
    #[cfg(feature = "runtime")]
    #[test]
    fn every_registered_node_type_is_classified() {
        let registry = crate::runtime::ComponentRegistry::new();
        let mut names: Vec<&String> = registry.declared().keys().collect();
        names.sort();
        assert!(!names.is_empty(), "the registry must declare its node types");
        for name in names {
            match classify(name) {
                Parity::Case(case) => case(),
                Parity::Exempt(reason) => assert!(!reason.is_empty(), "{reason:?}"),
            }
        }
    }
}
