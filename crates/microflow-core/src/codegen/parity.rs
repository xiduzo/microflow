//! Interpret↔emit parity guards.
//!
//! The live runtime (`runtime/`) and the codegen emitters (`codegen/`) are two
//! implementations of the same Node semantics. The config single-source work
//! (see `crate::config`) makes them share a Node's fields + defaults, and the
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

    // ---- Calculate: 11 arithmetic functions ------------------------------

    /// EXHAUSTIVE over `CalculateFunction`: the C++ token each variant's fold
    /// must contain when two inputs are wired. Add a variant → this won't
    /// compile until you name its emitted token.
    fn calculate_token(f: crate::config::calculate::CalculateFunction) -> &'static str {
        use crate::config::calculate::CalculateFunction::{
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
        use crate::config::calculate::CalculateFunction as F;
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
            let e = crate::codegen::transformation::calculate::emit(
                &node("Calculate", json!({ "function": wire })),
                &two_inputs("value"),
            );
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
    fn gate_comparison(g: crate::config::gate::GateType) -> &'static str {
        use crate::config::gate::GateType::{And, Nand, Nor, Or, Xnor, Xor};
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
        use crate::config::gate::GateType as G;
        let all = [
            ("and", G::And),
            ("nand", G::Nand),
            ("or", G::Or),
            ("xor", G::Xor),
            ("nor", G::Nor),
            ("xnor", G::Xnor),
        ];
        for (wire, variant) in all {
            let e = crate::codegen::transformation::gate::emit(
                &node("Gate", json!({ "gate": wire })),
                &two_inputs("value"),
            );
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
        use crate::runtime::{control::counter::Counter, Component};

        // (port, the C++ action its binding must emit).
        let expected_action = |port: &str| match port {
            "increment" => "+= 1.0",
            "decrement" => "-= 1.0",
            "reset" => "= 0.0",
            "set" => "counter_p_count = ",
            other => panic!(
                "Counter port `{other}` is unclassified for codegen parity — bind it in \
                 codegen/control/counter.rs and name its emitted action here."
            ),
        };

        for &port in Counter::ports() {
            let mut inputs = NodeInputs::default();
            let expr = if port == "set" { CppExpr::number("v") } else { CppExpr::boolean("v") };
            inputs.add(port, SourceExpr::level(expr));
            let e = crate::codegen::control::counter::emit(&node("Counter", json!({})), &inputs);
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
    fn compare_token(v: crate::config::compare::CompareValidator) -> &'static str {
        use crate::config::compare::CompareValidator::{Boolean, Number, OddEven, Range, Text};
        match v {
            Boolean => "!= 0.0",
            Number => "== 5.0",
            OddEven => "% 2) == 0",
            Range => "> 1.0 && ",
            // Text predicates have no on-device string model; the runtime's
            // empty-match default is `false`, and the emitter emits exactly that.
            Text => "= false;",
        }
    }

    #[test]
    fn compare_emit_covers_every_validator() {
        use crate::config::compare::CompareValidator as V;
        let all = [
            ("boolean", V::Boolean),
            ("number", V::Number),
            ("oddeven", V::OddEven),
            ("range", V::Range),
            ("text", V::Text),
        ];
        for (wire, variant) in all {
            let e = crate::codegen::transformation::compare::emit(
                &node(
                    "Compare",
                    json!({ "validator": wire, "number": 5.0, "range": { "min": 1.0, "max": 9.0 } }),
                ),
                &input("value", CppExpr::number("a")),
            );
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
    fn smooth_token(t: crate::config::smooth::SmoothType) -> &'static str {
        use crate::config::smooth::SmoothType::{MovingAverage, Smooth};
        match t {
            Smooth => "(1.0 - 0.9) * ",
            MovingAverage => "_sum / ",
        }
    }

    #[test]
    fn smooth_emit_covers_every_type() {
        use crate::config::smooth::SmoothType as S;
        let all = [("smooth", S::Smooth), ("movingAverage", S::MovingAverage)];
        for (wire, variant) in all {
            let e = crate::codegen::transformation::smooth::emit(
                &node("Smooth", json!({ "type": wire, "attenuation": 0.9, "windowSize": 4 })),
                &input("value", CppExpr::number("a")),
            );
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
    fn waveform_token(w: crate::config::oscillator::Waveform) -> &'static str {
        use crate::config::oscillator::Waveform::{
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
        use crate::config::oscillator::Waveform as W;
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
            let e = crate::codegen::generator::oscillator::emit(
                &node("Oscillator", json!({ "waveform": wire, "amplitude": 2.5 })),
                &NodeInputs::default(),
            );
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

        let in_note = crate::codegen::cloud::midi::emit(
            &node("Midi", json!({ "direction": "in", "mode": "note", "channel": 3 })),
            &NodeInputs::default(),
        );
        let body = in_note.loop_body.join("\n");
        assert!(body.contains("midi_rx_channel == 3"), "in-note channel filter: {body}");
        assert!(body.contains("0x90") && body.contains("0x80"), "in-note on/off: {body}");

        let in_cc = crate::codegen::cloud::midi::emit(
            &node("Midi", json!({ "direction": "in", "mode": "cc", "control": 7 })),
            &NodeInputs::default(),
        );
        assert!(
            in_cc.loop_body.join("\n").contains("0xB0 && midi_rx_data1 == 7"),
            "in-cc latches its control"
        );

        let mut send = NodeInputs::default();
        send.add("send", SourceExpr::level(CppExpr::number("v")));
        let out_note = crate::codegen::cloud::midi::emit(
            &node("Midi", json!({ "direction": "out", "mode": "note", "note": 64, "velocity": 90 })),
            &send,
        );
        let body = out_note.loop_body.join("\n");
        assert!(body.contains("sendNoteOn(64, 90,"), "out-note on: {body}");
        assert!(body.contains("sendNoteOff(64, 0,"), "out-note off: {body}");

        let out_cc = crate::codegen::cloud::midi::emit(
            &node("Midi", json!({ "direction": "out", "mode": "cc", "control": 7 })),
            &send,
        );
        assert!(
            out_cc.loop_body.join("\n").contains("sendControlChange(7, (byte)constrain"),
            "out-cc clamps + sends its control"
        );
    }

    // ---- Trigger: 2 behaviours -------------------------------------------

    /// EXHAUSTIVE over `TriggerBehaviour`: the direction comparison each
    /// variant must emit, transcribing `value_changes_in_correct_direction`.
    fn behaviour_token(b: crate::config::trigger::TriggerBehaviour) -> &'static str {
        use crate::config::trigger::TriggerBehaviour::{Decreasing, Increasing};
        match b {
            Increasing => "_diff > 0.0",
            Decreasing => "_diff <= 0.0",
        }
    }

    #[test]
    fn trigger_emit_covers_every_behaviour() {
        use crate::config::trigger::TriggerBehaviour as B;
        let all = [("increasing", B::Increasing), ("decreasing", B::Decreasing)];
        for (wire, variant) in all {
            let e = crate::codegen::control::trigger::emit(
                &node("Trigger", json!({ "behaviour": wire, "threshold": 7.5 })),
                &input("value", CppExpr::number("a")),
            );
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
        let e = crate::codegen::transformation::range_map::emit(
            &node(
                "RangeMap",
                json!({ "from": { "min": 0.0, "max": 100.0 }, "to": { "min": 0.0, "max": 255.0 } }),
            ),
            &input("value", CppExpr::number("a")),
        );
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("* (255.0 - 0.0) / (100.0 - 0.0)"),
            "RangeMap must emit the runtime's linear remap, got: {body}"
        );
        assert!(
            body.contains("round(") && body.contains("/ 1.0"),
            "output spans > 10 round to whole numbers, got: {body}"
        );
        let e = crate::codegen::transformation::range_map::emit(
            &node("RangeMap", json!({ "to": { "min": 0.0, "max": 5.0 } })),
            &input("value", CppExpr::number("a")),
        );
        assert!(
            e.loop_body.iter().any(|l| l.contains("/ 10.0")),
            "output spans <= 10 keep one decimal place"
        );
    }

    /// The configured delay drives the non-blocking deadline; the stored value
    /// is re-emitted on fire, like the runtime's delayed `event`.
    #[test]
    fn delay_plumbs_config_into_the_deadline() {
        let e = crate::codegen::control::delay::emit(
            &node("Delay", json!({ "delay": 750 })),
            &input("trigger", CppExpr::boolean("v")),
        );
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("millis() - ") && body.contains(">= 750UL"),
            "Delay must fire on a non-blocking elapsed-time compare, got: {body}"
        );
        assert!(
            body.contains("delay_p_value = delay_p_stored"),
            "Delay must re-emit the stored value on fire, got: {body}"
        );
    }

    /// The configured interval drives the tick (clamped to the runtime's 16ms
    /// minimum); the payload is the elapsed time since the start window.
    #[test]
    fn interval_plumbs_config_into_the_tick() {
        let e = crate::codegen::control::interval::emit(
            &node("Interval", json!({ "interval": 500 })),
            &NodeInputs::default(),
        );
        let body = e.loop_body.join("\n");
        assert!(body.contains(">= 500UL"), "configured interval drives the tick: {body}");
        assert!(
            body.contains("(double)(millis() - interval_p_start)"),
            "payload is elapsed ms since the start window, like `now - started_at`: {body}"
        );
        let e = crate::codegen::control::interval::emit(
            &node("Interval", json!({ "interval": 1 })),
            &NodeInputs::default(),
        );
        assert!(
            e.loop_body.iter().any(|l| l.contains(">= 16UL")),
            "intervals below the runtime minimum clamp to 16ms"
        );
    }

    /// The configured value lands verbatim in the declaration; no loop work.
    #[test]
    fn constant_emits_the_configured_value() {
        let e = crate::codegen::control::constant::emit(&node("Constant", json!({ "value": 42.0 })));
        assert!(e.declarations.iter().any(|d| d.contains("= 42.0;")));
        assert!(e.loop_body.is_empty(), "a Constant does no per-loop work");
    }

    /// The JS expression subset translates into the same arithmetic; anything
    /// outside it emits an explicit note and leaves the runtime's 0.0 initial
    /// value — never guessed-at C++.
    #[test]
    fn function_emits_only_the_supported_subset() {
        let e = crate::codegen::transformation::function::emit(
            &node("Function", json!({ "code": "return input * 2;" })),
            &input("trigger", CppExpr::number("a")),
        );
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("(a)") && body.contains("* 2"),
            "translated JS must read its wired input and keep the arithmetic: {body}"
        );
        let e = crate::codegen::transformation::function::emit(
            &node("Function", json!({ "code": "while (input) {}" })),
            &NodeInputs::default(),
        );
        assert!(e.loop_body.is_empty(), "unsupported JS must not emit loop code");
        assert!(
            e.declarations.iter().any(|d| d.contains("// unsupported")),
            "unsupported JS is noted, value stays 0.0"
        );
    }

    // ---- Outputs: value-mapping transforms -------------------------------

    /// Led `value` applies the runtime's `as_u8` clamp and tracks `is_on`.
    /// Also covers Vibration, which shares the Led implementation on both sides.
    #[test]
    fn led_value_port_applies_the_runtime_brightness_clamp() {
        let e = crate::codegen::output::led::emit(
            &node("Led", json!({})),
            &input("value", CppExpr::number("a")),
        );
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("constrain((double)(a), 0.0, 255.0)"),
            "Led `value` must clamp like `ComponentValue::as_u8`: {body}"
        );
        assert!(body.contains("analogWrite("), "Led `value` is a PWM write: {body}");
        assert!(body.contains("> 0;"), "Led must track the runtime's is_on: {body}");
    }

    /// EXHAUSTIVE over `RelayType`: the digital level "open" writes,
    /// transcribing the runtime's NO/NC inversion.
    fn relay_open_level(t: crate::config::relay::RelayType) -> &'static str {
        use crate::config::relay::RelayType::{NC, NO};
        match t {
            NO => "HIGH",
            NC => "LOW",
        }
    }

    #[test]
    fn relay_emit_covers_every_type() {
        use crate::config::relay::RelayType as R;
        let all = [("NO", R::NO), ("NC", R::NC)];
        for (wire, variant) in all {
            let e = crate::codegen::output::relay::emit(
                &node("Relay", json!({ "type": wire })),
                &input("true", CppExpr::boolean("a")),
            );
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
    fn servo_token(t: crate::config::servo::ServoType) -> &'static str {
        use crate::config::servo::ServoType::{Continuous, Standard};
        match t {
            Standard => "(int)constrain(",
            Continuous => "? 90 : ",
        }
    }

    #[test]
    fn servo_emit_covers_every_type() {
        use crate::config::servo::ServoType as S;
        let uno = crate::codegen::board::target_by_id("uno").expect("uno is supported");
        let all = [("standard", S::Standard), ("continuous", S::Continuous)];
        for (wire, variant) in all {
            let e = crate::codegen::output::servo::emit(
                &node("Servo", json!({ "type": wire, "range": { "min": 10, "max": 170 } })),
                &input("value", CppExpr::number("a")),
                &uno,
            );
            let body = e.loop_body.join("\n");
            let token = servo_token(variant);
            assert!(
                body.contains(token),
                "Servo `{wire}` must emit its value mapping (`{token}`), got: {body}"
            );
        }
        // The standard clamp uses the configured range bounds.
        let e = crate::codegen::output::servo::emit(
            &node("Servo", json!({ "range": { "min": 10, "max": 170 } })),
            &input("value", CppExpr::number("a")),
            &uno,
        );
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
        let e = crate::codegen::output::rgb::emit(&node("Rgb", json!({})), &inputs);
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("/ 100.0, 0.0, 1.0)"),
            "alpha percent must clamp to 0..=1 intensity: {body}"
        );
        assert!(body.contains("* rgb_p_a"), "channels must scale by alpha: {body}");
        let e = crate::codegen::output::rgb::emit(
            &node("Rgb", json!({ "isAnode": true })),
            &input("red", CppExpr::number("a")),
        );
        assert!(
            e.loop_body.iter().any(|l| l.contains("(255 - ")),
            "common-anode inverts the written level"
        );
    }

    /// Pixel `value` selects a preset with the runtime's hex parsing and
    /// index clamp (`index.min(len - 1)`).
    #[test]
    fn pixel_value_selects_a_clamped_preset() {
        let e = crate::codegen::output::pixel::emit(
            &node("Pixel", json!({ "length": 4, "presets": [["#ff0000"], ["#0000ff"]] })),
            &input("value", CppExpr::number("a")),
        );
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
        let e = crate::codegen::output::matrix::emit(
            &node("Matrix", json!({ "shapes": [["10000001"], ["11111111"]] })),
            &input("value", CppExpr::number("a")),
        );
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
    fn stepper_interface_token(i: crate::config::stepper::StepperInterface) -> &'static str {
        use crate::config::stepper::StepperInterface::{Driver, FourWire, TwoWire};
        match i {
            Driver => "(AccelStepper::DRIVER, 11, 12)",
            TwoWire => "(AccelStepper::FULL2WIRE, 21, 22)",
            FourWire => "(AccelStepper::FULL4WIRE, 21, 22, 23, 24)",
        }
    }

    #[test]
    fn stepper_emit_covers_every_interface() {
        use crate::config::stepper::StepperInterface as I;
        let all = [("driver", I::Driver), ("two_wire", I::TwoWire), ("four_wire", I::FourWire)];
        for (wire, variant) in all {
            let e = crate::codegen::output::stepper::emit(
                &node(
                    "Stepper",
                    json!({
                        "interface": wire,
                        "stepPin": 11, "dirPin": 12,
                        "motorPin1": 21, "motorPin2": 22, "motorPin3": 23, "motorPin4": 24,
                    }),
                ),
                &input("value", CppExpr::number("a")),
            );
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
        let e = crate::codegen::output::stepper::emit(
            &node("Stepper", json!({})),
            &input("to", CppExpr::number("a")),
        );
        assert!(
            e.loop_body.iter().any(|l| l.contains(".moveTo((long)")),
            "Stepper `to` is an absolute target, like CMD_TO"
        );
    }

    /// EXHAUSTIVE over `PiezoType`: buzz maps to the built-in `tone(...)`;
    /// song playback is host-only and emits an explicit note (the trigger
    /// still buzzes the base frequency).
    fn piezo_token(t: crate::config::piezo::PiezoType) -> &'static str {
        use crate::config::piezo::PiezoType::{Buzz, Song};
        match t {
            Buzz => "tone(piezo_p_pin, 880, 250)",
            Song => "song playback",
        }
    }

    #[test]
    fn piezo_emit_covers_every_type() {
        use crate::config::piezo::PiezoType as P;
        let all = [("buzz", P::Buzz), ("song", P::Song)];
        for (wire, variant) in all {
            let e = crate::codegen::output::piezo::emit(
                &node("Piezo", json!({ "type": wire, "frequency": 880, "duration": 250 })),
                &input("trigger", CppExpr::boolean("a")),
            );
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
    fn i2c_format_token(f: crate::config::i2c_device::OutputFormat) -> &'static str {
        use crate::config::i2c_device::ByteDecode;
        match f.decode() {
            ByteDecode::Raw | ByteDecode::Fold { sign_extend: false } => "<< 8",
            ByteDecode::Fold { sign_extend: true } => "= -1",
        }
    }

    #[test]
    fn i2c_emit_covers_every_output_format() {
        use crate::config::i2c_device::OutputFormat as F;
        let all = [("raw", F::Raw), ("unsigned_int", F::UnsignedInt), ("signed_int", F::SignedInt)];
        for (wire, variant) in all {
            let e = crate::codegen::input::i2c_device::emit(
                &node("I2cDevice", json!({ "output": wire })),
                &NodeInputs::default(),
            );
            let body = e.loop_body.join("\n");
            let token = i2c_format_token(variant);
            assert!(
                body.contains(token),
                "I2cDevice `{wire}` must emit its decode (`{token}`), got: {body}"
            );
        }
        // The signed fold sign-extends from the MSB, like the runtime.
        let e = crate::codegen::input::i2c_device::emit(
            &node("I2cDevice", json!({ "output": "signed_int" })),
            &NodeInputs::default(),
        );
        assert!(
            e.loop_body.iter().any(|l| l.contains("& 0x80")),
            "signed decode must test the sign bit of the first byte"
        );
        // The fold cap is part of the descriptor: `fold_bytes` ignores bytes
        // past `FOLD_BYTE_CAP`, so a longer read must guard the emitted fold
        // too (unguarded, the 32-bit `long` kept the LAST 4 bytes instead).
        let cap = crate::config::i2c_device::OutputFormat::FOLD_BYTE_CAP;
        let e = crate::codegen::input::i2c_device::emit(
            &node("I2cDevice", json!({ "output": "unsigned_int", "readLength": cap + 2 })),
            &NodeInputs::default(),
        );
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
        let e = crate::codegen::input::button::emit(&node("Button", json!({ "isPullup": true })));
        assert!(e.setup.iter().any(|s| s.contains("INPUT_PULLUP")));
        assert!(
            e.loop_body.iter().any(|l| l.contains("== LOW")),
            "pull-up reads are active-low and must invert"
        );
        let e = crate::codegen::input::button::emit(&node("Button", json!({})));
        assert!(
            e.loop_body.iter().any(|l| l.contains("== HIGH")),
            "plain INPUT reads HIGH on press"
        );
    }

    /// EXHAUSTIVE over `SwitchType`: the read comparison per contact type,
    /// transcribing the runtime's NO/NC inversion.
    fn switch_read_token(t: crate::config::switch::SwitchType) -> &'static str {
        use crate::config::switch::SwitchType::{NC, NO};
        match t {
            NO => "== HIGH",
            NC => "== LOW",
        }
    }

    #[test]
    fn switch_emit_covers_every_type() {
        use crate::config::switch::SwitchType as S;
        let all = [("NO", S::NO), ("NC", S::NC)];
        for (wire, variant) in all {
            let e = crate::codegen::input::switch::emit(&node("Switch", json!({ "type": wire })));
            let body = e.loop_body.join("\n");
            let token = switch_read_token(variant);
            assert!(
                body.contains(token),
                "Switch `{wire}` must read `{token}`, got: {body}"
            );
        }
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
            // Plain analogRead sources (Sensor backs the specialised aliases;
            // Proximity has its own impl with the same read semantics).
            "Sensor" | "Force" | "HallEffect" | "Ldr" | "Potentiometer" | "Tilt" | "Proximity" => {
                Exempt("plain analogRead into a state variable — no value transform")
            }
            "Midi" => Case(midi_emit_covers_both_directions_and_modes),
            // cloud
            "Monitor" | "Mqtt" | "Figma" | "Llm" => Exempt(
                "network transport side-effect — values cross unchanged; bring-up and \
                 topic plumbing are pinned by the emitter's own tests",
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
                Parity::Exempt(reason) => assert!(!reason.is_empty()),
            }
        }
    }
}
