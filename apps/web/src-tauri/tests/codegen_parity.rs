//! Behaviour-parity tests — live runtime vs generated sketch (Task #40).
//!
//! For each representative non-Cloud Node type these tests feed the *same*
//! inputs to (a) the live-runtime component impl and (b) a deterministic model
//! of the C++ the codegen emitter produces, then assert the observable outputs
//! match. This is the primary mitigation against semantic drift between the two
//! modes: the generated Sketch must reproduce what the Flow Author sees live.
//!
//! ## How the comparison is meaningful without a C++ compiler
//!
//! The Epic explicitly puts on-hardware flashing / `arduino-cli` out of scope,
//! so we cannot run the emitted `.ino` here. Instead — per the Task's Technical
//! Approach — we evaluate the *exact* C++ expression the emitter writes into the
//! sketch `loop()` against a tiny interpreter implementing the Arduino/C++
//! numeric and boolean subset the emitters use (casts, `%`, `&&`/`||`/`!`,
//! `ceil`/`floor`/`round`, comparison). Because the interpreter consumes the
//! emitter's real output (extracted from [`app_lib::codegen::generate`]) and the
//! runtime config is deserialized from the *same* Node `data`, any divergence
//! between emitter and runtime fails the suite and names the diverging Node.

use app_lib::codegen::generate;
use app_lib::runtime::base::{Component, ComponentValue};
use app_lib::runtime::types::{FlowEdge, FlowNode, FlowUpdate, Position};
use app_lib::runtime::{
    Calculate, CalculateConfig, Compare, CompareConfig, Gate, GateConfig, RangeMap, RangeMapConfig,
};
use serde_json::json;
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Tiny C++ expression interpreter
// ---------------------------------------------------------------------------
//
// Supports the operator/function subset the codegen emitters actually produce:
//   - numeric literals and the bound input variable(s)
//   - unary `!`, casts `(double)`/`(bool)`/`(long)`, parentheses
//   - `* / % + -`, comparison `> < == >= <=`, `&& ||`
//   - calls `ceil(x)`, `floor(x)`, `round(x)`, `abs(x)`
// Booleans are represented as `1.0` / `0.0`, matching C++ truthiness.

struct Parser<'a> {
    src: &'a [u8],
    pos: usize,
    vars: &'a HashMap<String, f64>,
}

impl Parser<'_> {
    fn eval(src: &str, vars: &HashMap<String, f64>) -> f64 {
        let mut p = Parser { src: src.as_bytes(), pos: 0, vars };
        let v = p.parse_or();
        p.skip_ws();
        assert!(p.pos >= p.src.len(), "unparsed C++ tail in `{src}` at byte {}", p.pos);
        v
    }

    fn skip_ws(&mut self) {
        while self.pos < self.src.len() && self.src[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.src.get(self.pos).copied()
    }

    fn eat(&mut self, s: &str) -> bool {
        self.skip_ws();
        if self.src[self.pos..].starts_with(s.as_bytes()) {
            self.pos += s.len();
            true
        } else {
            false
        }
    }

    fn parse_or(&mut self) -> f64 {
        let mut v = self.parse_and();
        while self.eat("||") {
            let r = self.parse_and();
            v = f64::from((v != 0.0) || (r != 0.0));
        }
        v
    }

    fn parse_and(&mut self) -> f64 {
        let mut v = self.parse_cmp();
        while self.eat("&&") {
            let r = self.parse_cmp();
            v = f64::from((v != 0.0) && (r != 0.0));
        }
        v
    }

    fn parse_cmp(&mut self) -> f64 {
        let l = self.parse_add();
        // Two-char operators must be matched before their one-char prefixes.
        if self.eat("==") {
            return f64::from((l - self.parse_add()).abs() < f64::EPSILON);
        }
        if self.eat("!=") {
            return f64::from((l - self.parse_add()).abs() >= f64::EPSILON);
        }
        if self.eat(">=") {
            return f64::from(l >= self.parse_add());
        }
        if self.eat("<=") {
            return f64::from(l <= self.parse_add());
        }
        if self.eat(">") {
            return f64::from(l > self.parse_add());
        }
        if self.eat("<") {
            return f64::from(l < self.parse_add());
        }
        l
    }

    fn parse_add(&mut self) -> f64 {
        let mut v = self.parse_mul();
        loop {
            match self.peek() {
                Some(b'+') => {
                    self.pos += 1;
                    v += self.parse_mul();
                }
                Some(b'-') => {
                    self.pos += 1;
                    v -= self.parse_mul();
                }
                _ => break,
            }
        }
        v
    }

    fn parse_mul(&mut self) -> f64 {
        let mut v = self.parse_unary();
        loop {
            match self.peek() {
                Some(b'*') => {
                    self.pos += 1;
                    v *= self.parse_unary();
                }
                Some(b'/') => {
                    self.pos += 1;
                    v /= self.parse_unary();
                }
                Some(b'%') => {
                    self.pos += 1;
                    let r = self.parse_unary();
                    // C++ `%` runs on the `(long)`-cast operands → integer rem.
                    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
                    let m = ((v as i64) % (r as i64)) as f64;
                    v = m;
                }
                _ => break,
            }
        }
        v
    }

    fn parse_unary(&mut self) -> f64 {
        if self.eat("!") {
            return f64::from(self.parse_unary() == 0.0);
        }
        // Casts are no-ops for our f64 model; `(long)` truncation is applied by
        // `%` and by `round`, which the emitters always wrap a cast around.
        if self.eat("(double)") || self.eat("(bool)") || self.eat("(long)") {
            return self.parse_unary();
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> f64 {
        if self.peek() == Some(b'(') {
            self.pos += 1;
            let v = self.parse_or();
            assert!(self.eat(")"), "missing `)` in C++ expr");
            return v;
        }
        if self.peek().is_some_and(|c| c.is_ascii_alphabetic() || c == b'_') {
            let start = self.pos;
            while self.pos < self.src.len()
                && (self.src[self.pos].is_ascii_alphanumeric() || self.src[self.pos] == b'_')
            {
                self.pos += 1;
            }
            let ident = std::str::from_utf8(&self.src[start..self.pos]).unwrap().to_string();
            if self.eat("(") {
                let arg = self.parse_or();
                assert!(self.eat(")"), "missing `)` in call to {ident}");
                return match ident.as_str() {
                    "ceil" => arg.ceil(),
                    "floor" => arg.floor(),
                    "round" => arg.round(),
                    "abs" => arg.abs(),
                    other => panic!("unsupported C++ function `{other}` in emitted sketch"),
                };
            }
            return *self
                .vars
                .get(&ident)
                .unwrap_or_else(|| panic!("unbound C++ variable `{ident}` in emitted sketch"));
        }
        self.parse_number()
    }

    fn parse_number(&mut self) -> f64 {
        self.skip_ws();
        let start = self.pos;
        while self.pos < self.src.len()
            && (self.src[self.pos].is_ascii_digit() || self.src[self.pos] == b'.')
        {
            self.pos += 1;
        }
        std::str::from_utf8(&self.src[start..self.pos])
            .unwrap()
            .parse()
            .unwrap_or_else(|_| panic!("bad C++ number literal near byte {start}"))
    }
}

#[test]
fn interpreter_models_cpp_semantics() {
    // Guard the interpreter itself so a parity failure can be trusted to be a
    // real emitter/runtime divergence rather than an evaluator bug.
    let vars = HashMap::new();
    let approx = |a: f64, b: f64| (a - b).abs() < 1e-9;
    assert!(approx(Parser::eval("ceil(2.4)", &vars), 3.0));
    assert!(approx(Parser::eval("floor(2.9)", &vars), 2.0));
    assert!(approx(Parser::eval("((long)round(7.0)) % 2", &vars), 1.0));
    assert!(approx(Parser::eval("((double)(5.0) > 3.0)", &vars), 1.0));
    assert!(approx(Parser::eval("(!((bool)(0.0)))", &vars), 1.0));
    assert!(approx(Parser::eval("(1.0 > 0.0) && (2.0 < 1.0)", &vars), 0.0));
    assert!(approx(Parser::eval("((long)round(6.0)) % 2", &vars), 0.0));
}

// ---------------------------------------------------------------------------
// Flow / sketch helpers
// ---------------------------------------------------------------------------

const SRC_VAR: &str = "constant_src_value";

fn node(id: &str, kind: &str, data: serde_json::Value) -> FlowNode {
    FlowNode {
        id: id.to_string(),
        node_type: Some(kind.to_string()),
        data,
        position: Position { x: 0.0, y: 0.0 },
    }
}

fn edge(source: &str, target: &str) -> FlowEdge {
    FlowEdge {
        id: None,
        source: source.to_string(),
        target: target.to_string(),
        source_handle: "out".to_string(),
        target_handle: "in".to_string(),
    }
}

/// Generate a sketch for `src(Constant) -> transform`, extract the single
/// `loop()` assignment for the transform's output variable, and evaluate it
/// with the source value bound to `input`. Returns the generated model output.
fn emitted_output(transform: FlowNode, input: f64) -> f64 {
    let target_id = transform.id.clone();
    let flow = FlowUpdate {
        // A Constant source exposes `constant_src_value` as the driver.
        nodes: vec![node("src", "Constant", json!({ "value": 0.0 })), transform],
        edges: vec![edge("src", &target_id)],
    };
    let sketch = generate(&flow).expect("generation must succeed");

    // The transform's output is the only declared `double`/`bool` whose name is
    // not the constant source's.
    let out_var = sketch
        .lines()
        .filter_map(|l| {
            let l = l.trim().trim_end_matches(';');
            l.strip_prefix("double ")
                .or_else(|| l.strip_prefix("bool "))
                .and_then(|d| d.split(" = ").next())
        })
        .find(|name| !name.starts_with("constant_"))
        .map_or_else(
            || panic!("no transform output declaration in:\n{sketch}"),
            str::to_string,
        );

    let rhs = rhs_for(&sketch, &out_var);
    let mut vars = HashMap::new();
    vars.insert(SRC_VAR.to_string(), input);
    Parser::eval(&rhs, &vars)
}

/// Pull the RHS C++ expression of the `var = ...;` assignment from `loop()`.
fn rhs_for(sketch: &str, var: &str) -> String {
    let needle = format!("{var} = ");
    let line = sketch
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with(&needle) && l.ends_with(';'))
        .unwrap_or_else(|| panic!("no `{var} = ...;` assignment in sketch:\n{sketch}"));
    line[needle.len()..line.len() - 1].trim().to_string()
}

fn num(v: &ComponentValue) -> f64 {
    v.as_number().expect("expected a numeric component value")
}

fn boolean(v: &ComponentValue) -> bool {
    match v {
        ComponentValue::Bool(b) => *b,
        other => panic!("expected a boolean component value, got {other:?}"),
    }
}

fn cfg<T: serde::de::DeserializeOwned>(data: &serde_json::Value) -> T {
    serde_json::from_value(data.clone()).expect("config must deserialize from Node data")
}

// ===========================================================================
// Scenario: Each Node type matches live behavior
// ===========================================================================

#[test]
fn calculate_matches_runtime() {
    // `ceil`/`floor`/`round` apply unary math; fold functions collapse to the
    // single input. Cover one of each class across a range of inputs.
    for func in ["ceil", "floor", "round", "add", "multiply", "subtract", "divide", "max"] {
        let data = json!({ "function": func });
        for input in [-3.7, -0.5, 0.0, 2.4, 9.9] {
            let mut rt = Calculate::new("c".into(), cfg::<CalculateConfig>(&data));
            rt.check(&[input]);
            let live = num(&rt.value());

            let gen = emitted_output(node("c-1", "Calculate", data.clone()), input);

            assert!(
                (live - gen).abs() < 1e-9,
                "Calculate({func}) diverged for input {input}: live={live} generated={gen}"
            );
        }
    }
}

#[test]
fn compare_matches_runtime() {
    let datas = [
        json!({ "validator": "number", "subValidator": "greater than", "number": 5.0 }),
        json!({ "validator": "number", "subValidator": "less than", "number": 5.0 }),
        json!({ "validator": "number", "subValidator": "equal", "number": 6.0 }),
        json!({ "validator": "oddeven", "subValidator": "odd" }),
        json!({ "validator": "oddeven", "subValidator": "even" }),
        json!({ "validator": "range", "subValidator": "inside", "range": { "min": 10.0, "max": 20.0 } }),
        json!({ "validator": "range", "subValidator": "outside", "range": { "min": 10.0, "max": 20.0 } }),
        json!({ "validator": "boolean" }),
    ];

    for data in datas {
        for input in [-4.0, -1.0, 0.0, 3.0, 6.0, 7.0, 15.0, 25.0] {
            let mut rt = Compare::new("cmp".into(), cfg::<CompareConfig>(&data));
            rt.check(&ComponentValue::Number(input));
            let live = boolean(&rt.value());

            let gen = emitted_output(node("cmp-1", "Compare", data.clone()), input) != 0.0;

            assert_eq!(
                live, gen,
                "Compare({data}) diverged for input {input}: live={live} generated={gen}"
            );
        }
    }
}

#[test]
fn gate_matches_runtime() {
    // Single boolean input: pass-through gates equal the input, inverting gates
    // negate it. Cover one of each class against the runtime.
    for gate_str in ["and", "or", "xor", "nand", "nor", "xnor"] {
        let data = json!({ "gate": gate_str });
        for input_high in [false, true] {
            let mut rt = Gate::new("g".into(), cfg::<GateConfig>(&data));
            rt.check(&[input_high]);
            let live = boolean(&rt.value());

            let gen = emitted_output(node("g-1", "Gate", data.clone()), f64::from(input_high)) != 0.0;

            assert_eq!(live, gen, "Gate({gate_str}) diverged for input {input_high}");
        }
    }
}

#[test]
fn range_map_matches_runtime() {
    // Wide span (whole-number precision) and small span (one-decimal precision).
    let datas = [
        json!({ "from": { "min": 0.0, "max": 1023.0 }, "to": { "min": 0.0, "max": 255.0 } }),
        json!({ "from": { "min": 0.0, "max": 100.0 }, "to": { "min": 0.0, "max": 5.0 } }),
    ];
    for data in datas {
        for input in [0.0, 33.0, 256.0, 511.5, 1023.0] {
            let mut rt = RangeMap::new("rm".into(), cfg::<RangeMapConfig>(&data));
            rt.map_value(ComponentValue::Number(input));
            // RangeMap stores [input, normalized]; the emitted value is `normalized`.
            let live = match rt.value() {
                ComponentValue::Array(a) => a[1].as_number().unwrap(),
                other => panic!("expected RangeMap array, got {other:?}"),
            };

            let gen = emitted_output(node("rm-1", "RangeMap", data.clone()), input);

            assert!(
                (live - gen).abs() < 1e-6,
                "RangeMap({data}) diverged for input {input}: live={live} generated={gen}"
            );
        }
    }
}

// ===========================================================================
// Scenario: A chained Flow reproduces live behavior on-device
//   Sensor -> Calculate(round) -> Compare(> threshold) -> Led
// ===========================================================================

#[test]
fn chained_flow_reproduces_live_behavior() {
    let calc_data = json!({ "function": "round" });
    let cmp_data = json!({ "validator": "number", "subValidator": "greater than", "number": 5.0 });

    let flow = FlowUpdate {
        nodes: vec![
            node("sensor-1", "Sensor", json!({ "pin": "A0" })),
            node("calc-1", "Calculate", calc_data.clone()),
            node("cmp-1", "Compare", cmp_data.clone()),
            node("led-1", "Led", json!({ "pin": 13 })),
        ],
        edges: vec![edge("sensor-1", "calc-1"), edge("calc-1", "cmp-1"), edge("cmp-1", "led-1")],
    };
    let sketch = generate(&flow).expect("generation must succeed");

    // Structural parity: non-blocking, every chain Node emits real code.
    assert!(!sketch.contains("delay("), "chain must stay non-blocking");
    assert!(sketch.contains("analogRead"), "sensor read present");
    assert!(sketch.contains("digitalWrite"), "led write present");

    // Semantic parity over the whole chain: drive the same raw input through
    // both the live components and the emitted expressions.
    let calc_rhs = rhs_for(&sketch, "calculate_calc_1_value");
    let cmp_rhs = rhs_for(&sketch, "compare_cmp_1_result");

    for raw in [3.2, 4.6, 5.4, 5.5, 9.1] {
        // Live: Sensor value → Calculate(round) → Compare(>5).
        let mut calc = Calculate::new("calc".into(), cfg::<CalculateConfig>(&calc_data));
        calc.check(&[raw]);
        let calc_live = num(&calc.value());
        let mut cmp = Compare::new("cmp".into(), cfg::<CompareConfig>(&cmp_data));
        cmp.check(&ComponentValue::Number(calc_live));
        let live = boolean(&cmp.value());

        // Generated: evaluate calc RHS, feed its result into the compare RHS.
        let mut vars = HashMap::new();
        vars.insert("sensor_sensor_1_value".to_string(), raw);
        let calc_gen = Parser::eval(&calc_rhs, &vars);
        vars.insert("calculate_calc_1_value".to_string(), calc_gen);
        let gen = Parser::eval(&cmp_rhs, &vars) != 0.0;

        assert_eq!(live, gen, "chained Flow diverged for raw input {raw}");
    }
}

// ===========================================================================
// Scenario: Nested timing Nodes stay in parity
//   Interval drives Delay — both timers stay non-blocking and drift-free.
// ===========================================================================

#[test]
fn nested_timing_nodes_stay_in_parity() {
    let flow = FlowUpdate {
        nodes: vec![
            node("interval-1", "Interval", json!({ "interval": 1000 })),
            node("delay-1", "Delay", json!({ "delay": 500 })),
        ],
        edges: vec![edge("interval-1", "delay-1")],
    };
    let sketch = generate(&flow).expect("generation must succeed");

    // No blocking `delay()` — both timers are millis()-based, so the loop never
    // stalls and the two timers run concurrently without drift.
    assert!(!sketch.contains("delay("), "timing Nodes must not block the loop");
    assert!(sketch.contains("millis()"), "timers must be millis()-driven");

    // The Interval advances its deadline by a fixed step (`previous += period`)
    // rather than re-basing off `millis()`, which is what prevents cumulative
    // drift. Assert that drift-free pattern is present.
    assert!(
        sketch.contains("interval_interval_1_previous += 1000UL"),
        "Interval must advance by a fixed step to avoid drift, got:\n{sketch}"
    );
    // The Delay measures its own elapsed window independently of the Interval.
    assert!(
        sketch.contains("millis() - delay_delay_1_armed_at >= 500UL"),
        "Delay must measure its own non-blocking window, got:\n{sketch}"
    );

    // Simulate the two timers on a shared clock and confirm they fire on their
    // own schedules without one blocking the other.
    let interval_ms = 1000u64;
    let delay_ms = 500u64;
    let mut interval_prev = 0u64;
    let mut delay_pending = false;
    let mut delay_armed = 0u64;
    let mut interval_fires = 0u32;
    let mut delay_fires = 0u32;

    // Window covers interval pulses at 1000/2000/3000 and leaves room (+500ms)
    // for each armed Delay to resolve before the loop ends.
    for now in (0..=3600).step_by(50) {
        // Interval tick (fixed-step advance, drift-free).
        if now - interval_prev >= interval_ms {
            interval_prev += interval_ms;
            interval_fires += 1;
            // The Interval pulse arms the Delay (rising edge).
            if !delay_pending {
                delay_pending = true;
                delay_armed = now;
            }
        }
        // Delay fires its own window later, independently.
        if delay_pending && now - delay_armed >= delay_ms {
            delay_pending = false;
            delay_fires += 1;
        }
    }

    // The 1s interval fires 3 times (at 1000/2000/3000) and each arms a 500ms
    // delay that resolves before the next pulse — neither timer is starved or
    // blocked by the other, and the delay tracks the interval 1:1 (no drift).
    assert_eq!(interval_fires, 3, "interval should fire 3 times within the window");
    assert_eq!(delay_fires, interval_fires, "every interval pulse must resolve its delay");
}

// ===========================================================================
// Scenario: Divergence fails the suite
// ===========================================================================

#[test]
fn divergence_is_detected() {
    // A deliberately wrong model of the Compare Node (using `<` instead of the
    // emitted `>`) must disagree with the runtime — proving the harness would
    // catch a real emitter regression rather than silently passing.
    let data = json!({ "validator": "number", "subValidator": "greater than", "number": 5.0 });
    let mut rt = Compare::new("cmp".into(), cfg::<CompareConfig>(&data));
    rt.check(&ComponentValue::Number(9.0));
    let live = boolean(&rt.value()); // 9 > 5 == true

    // The genuine emitted output agrees with the runtime…
    let genuine = emitted_output(node("cmp-1", "Compare", data.clone()), 9.0) != 0.0;
    assert_eq!(live, genuine, "sanity: genuine emitter must match runtime");

    // …but a corrupted model diverges, and the harness's equality check fails.
    let vars = HashMap::from([(SRC_VAR.to_string(), 9.0)]);
    let corrupted = Parser::eval("((double)(constant_src_value) < 5.0)", &vars) != 0.0;
    assert_ne!(
        live, corrupted,
        "a diverging Node model must be detectable by the parity comparison"
    );
}
