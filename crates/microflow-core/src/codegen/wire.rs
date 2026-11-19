//! Typed, handle-aware wiring model for the Sketch Generation context.
//!
//! The live runtime routes an event by `(source, source_handle)` and delivers
//! it to `(target, target_handle)` (see [`crate::runtime::router`] when the
//! `runtime` feature is on). Codegen mirrors that contract statically: every
//! edge is resolved to a [`SourceExpr`] — the C++ expression a source Node
//! exposes on one *specific* emit handle — and grouped per target *port*
//! (target handle) into a [`NodeInputs`]. Emitters bind their real ports by
//! name instead of receiving one anonymous "driver" expression, so an edge
//! into a Led's `toggle` port generates toggle logic, not a level write.
//!
//! Expressions are **typed** ([`CppType`]) and consumed through coercions that
//! mirror `ComponentValue`'s conversions (`as_bool` / `as_number` / `as_u8`),
//! so a `String`-valued source wired into a numeric port compiles to the same
//! fallback the runtime applies instead of producing uncompilable C++.
//!
//! Like everything in codegen this module is pure data + pure functions:
//! deterministic for identical input, no clock, no IO.

use std::collections::BTreeMap;

/// The C++ type a wired expression evaluates to.
///
/// `Str` is the Arduino `String` class — it has no implicit conversion to
/// `bool` or `double`, which is exactly why consumers must go through the
/// typed coercions below instead of C-style casts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CppType {
    /// A boolean expression (`bool`).
    Bool,
    /// A numeric expression (`double`, or an integral type that widens to it).
    Double,
    /// An Arduino `String` expression.
    Str,
    /// A colour or a list (`Rgba` / `Array` on the wire). It carries no
    /// number and no text: `as_number` is `None`, and a payload (an Mqtt
    /// publish, an Llm prompt variable) renders it as nothing. So the
    /// expression is not the value itself but its *version*, a `uint8_t` its
    /// producer moves on (never to 0) each time the value changes, exactly
    /// when the runtime twin emits it. A colour and a non-empty list are
    /// truthy. Version 0 is the plain number 0 an output holds before it
    /// shows anything (a cleared Matrix): falsy, and a number.
    Opaque,
}

/// A typed C++ expression a source Node exposes on one emit handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CppExpr {
    /// The raw C++ expression (a variable name or parenthesizable expression).
    pub code: String,
    /// The expression's C++ type, driving the coercions below.
    pub ty: CppType,
}

impl CppExpr {
    /// A boolean-typed expression.
    pub fn boolean(code: impl Into<String>) -> Self {
        Self { code: code.into(), ty: CppType::Bool }
    }

    /// A numeric (double-compatible) expression.
    pub fn number(code: impl Into<String>) -> Self {
        Self { code: code.into(), ty: CppType::Double }
    }

    /// An Arduino-`String`-typed expression.
    pub fn text(code: impl Into<String>) -> Self {
        Self { code: code.into(), ty: CppType::Str }
    }

    /// The version of a colour or a list (see [`CppType::Opaque`]).
    pub fn opaque(version: impl Into<String>) -> Self {
        Self { code: version.into(), ty: CppType::Opaque }
    }

    /// Whether the value carries a number, as `ComponentValue::as_number` is
    /// `Some`: a fold that drops what has none (Calculate) drops the rest.
    #[must_use]
    pub fn has_number(&self) -> bool {
        matches!(self.ty, CppType::Bool | CppType::Double)
    }

    /// The C++ type a copy of this value is stored in.
    #[must_use]
    pub fn storage_type(&self) -> &'static str {
        match self.ty {
            CppType::Bool => "bool",
            CppType::Double => "double",
            CppType::Str => "String",
            CppType::Opaque => "uint8_t",
        }
    }

    /// This value as a [`Self::storage_type`] expression, to store a copy.
    #[must_use]
    pub fn stored(&self) -> String {
        match self.ty {
            CppType::Bool => self.as_bool(),
            CppType::Double => self.as_double(),
            CppType::Str => self.as_string(),
            CppType::Opaque => format!("({})", self.code),
        }
    }

    /// The zero of [`Self::storage_type`]: `false`, `0.0`, the empty text, or
    /// the plain number 0 of a colour or a list.
    #[must_use]
    pub fn storage_zero(&self) -> &'static str {
        match self.ty {
            CppType::Bool => "false",
            CppType::Double => "0.0",
            CppType::Str => "\"\"",
            CppType::Opaque => "0",
        }
    }

    /// Coerce to a C++ `bool` expression, mirroring `ComponentValue::as_bool`:
    /// numbers are truthy when non-zero, strings when non-empty.
    #[must_use]
    pub fn as_bool(&self) -> String {
        let c = &self.code;
        match self.ty {
            CppType::Bool => format!("({c})"),
            CppType::Double => format!("(({c}) != 0.0)"),
            CppType::Str => format!("(({c}).length() > 0)"),
            CppType::Opaque => format!("(({c}) != 0)"),
        }
    }

    /// Coerce to a C++ `double` expression, mirroring
    /// `ComponentValue::as_number(..).unwrap_or(default)`: booleans map to
    /// `1.0` / `0.0`; strings carry no number, so they yield `default` — the
    /// same fallback the runtime applies at its dispatch sites.
    #[must_use]
    pub fn as_double_or(&self, default: &str) -> String {
        let c = &self.code;
        match self.ty {
            CppType::Bool => format!("(({c}) ? 1.0 : 0.0)"),
            CppType::Double => format!("((double)({c}))"),
            CppType::Str => format!("({default})"),
            CppType::Opaque => format!("((({c}) != 0) ? ({default}) : 0.0)"),
        }
    }

    /// [`Self::as_double_or`] with the runtime's usual `0.0` fallback.
    #[must_use]
    pub fn as_double(&self) -> String {
        self.as_double_or("0.0")
    }

    /// Coerce to a C++ `double` expression like [`Self::as_double`], but
    /// *parsing* string sources instead of defaulting — for the dispatch sites
    /// (e.g. `RangeMap::map_value`) that run their own `String → number` parse
    /// with a `0.0` fallback, which is what Arduino's `toFloat()` returns for
    /// unparseable text.
    #[must_use]
    pub fn as_double_parsing(&self) -> String {
        let c = &self.code;
        match self.ty {
            CppType::Str => format!("((double)(({c}).toFloat()))"),
            _ => self.as_double(),
        }
    }

    /// Coerce to a `uint8_t` expression, mirroring `ComponentValue::as_u8`
    /// (clamp to `0..=255`); strings yield `default` like `as_u8().unwrap_or`.
    #[must_use]
    pub fn as_u8_or(&self, default: u8) -> String {
        let c = &self.code;
        match self.ty {
            CppType::Bool => format!("(uint8_t)(({c}) ? 1 : 0)"),
            CppType::Double => {
                format!("(uint8_t)constrain((double)({c}), 0.0, 255.0)")
            }
            CppType::Str => format!("(uint8_t){default}"),
            CppType::Opaque => format!("(uint8_t)((({c}) != 0) ? {default} : 0)"),
        }
    }

    /// Coerce to an Arduino `String` expression (for payload formatting).
    #[must_use]
    pub fn as_string(&self) -> String {
        let c = &self.code;
        match self.ty {
            CppType::Str => format!("({c})"),
            CppType::Bool => format!("(({c}) ? String(\"true\") : String(\"false\"))"),
            CppType::Double => format!("String({c})"),
            CppType::Opaque => format!("((({c}) != 0) ? String(\"\") : String(0.0))"),
        }
    }
}

/// What a source Node exposes on one emit handle: the value it carries and
/// when it fires — the on-device twin of one live emission.
///
/// Two shapes, by how the live Node emits on that handle:
///
/// - An **event** carries an explicit *fired* expression, true on exactly the
///   loop iterations the live Node emits: once per emission, whatever it
///   carries. Every handle the live Node emits per input or per occurrence is
///   one: Compare and Gate `true`/`false` (each check), Button and Switch
///   `true`/`false`/`event` (each new level), Delay and Interval `event`,
///   Trigger `bang`, a Constant's one emission at the start.
/// - A **level** has no fired expression: the live Node emits it when its
///   value changes (`ComponentBase::set_value`), so a pulse-consuming port
///   synthesizes a change detector over the value (see [`bind_pulses`]).
///
/// Either way `value` is what the handle carries when it fires. A boolean
/// Node's handles all carry its state (`false` fires when the state is false,
/// and carries it), which is also what an aggregating Node (Gate, Calculate)
/// reads of it: the source's stored value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceExpr {
    /// The typed value expression downstream code reads.
    pub value: CppExpr,
    /// C++ `bool` expression, true only on the tick the source fired; `None`
    /// for a level, which fires when its value changes.
    pub fired: Option<String>,
    /// The C++ literal of the value the runtime twin holds before it first
    /// emits, where that is not the type's zero (a Servo starts centred). A
    /// change detector starts from it, so a source that has not moved does
    /// not fire on the first tick. `None`: the zero of the value's type.
    pub initial: Option<String>,
}

impl SourceExpr {
    /// A level-valued source whose runtime twin emits on every value change.
    #[must_use]
    pub fn level(value: CppExpr) -> Self {
        Self { value, fired: None, initial: None }
    }

    /// An event-valued source: `fired` is true exactly on the emission tick.
    #[must_use]
    pub fn event(value: CppExpr, fired: impl Into<String>) -> Self {
        Self { value, fired: Some(fired.into()), initial: None }
    }

    /// This source, whose runtime twin holds `initial` (a C++ literal of the
    /// value's type) before it first emits.
    #[must_use]
    pub fn starting_at(self, initial: impl Into<String>) -> Self {
        Self { initial: Some(initial.into()), ..self }
    }
}

/// Every wired input of one target Node, grouped by port (target handle) with
/// sources in deterministic order (the builder inserts them sorted by edge).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NodeInputs {
    by_port: BTreeMap<String, Vec<SourceExpr>>,
}

impl NodeInputs {
    /// Append a resolved source under `port`, preserving insertion order.
    pub fn add(&mut self, port: &str, source: SourceExpr) {
        self.by_port.entry(port.to_string()).or_default().push(source);
    }

    /// All sources wired into `port`, in deterministic order.
    #[must_use]
    pub fn on(&self, port: &str) -> &[SourceExpr] {
        self.by_port.get(port).map_or(&[], Vec::as_slice)
    }

    /// The first (deterministically ordered) source on `port`, if any.
    #[must_use]
    pub fn first(&self, port: &str) -> Option<&SourceExpr> {
        self.on(port).first()
    }

    /// The wired port names, sorted. Emitters use this to surface an explicit
    /// comment for ports they cannot generate rather than dropping them.
    pub fn ports(&self) -> impl Iterator<Item = &str> {
        self.by_port.keys().map(String::as_str)
    }

    /// True when nothing is wired into the Node.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.by_port.is_empty()
    }
}

/// The C++ fragments a pulse binding contributes: persistent edge-tracking
/// declarations, per-tick detector lines, and one fired-expression per source.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PulseBinding {
    /// Module-level declarations (previous-state trackers).
    pub declarations: Vec<String>,
    /// Per-tick detector statements; must run before the fired expressions
    /// are read, once per loop iteration.
    pub loop_lines: Vec<String>,
    /// One C++ `bool` expression per source, true only on its firing tick.
    pub fired: Vec<String>,
}

impl PulseBinding {
    /// A single expression that is true when *any* source fired this tick, or
    /// `None` when the binding has no sources.
    #[must_use]
    pub fn any_fired(&self) -> Option<String> {
        if self.fired.is_empty() {
            None
        } else {
            Some(format!("({})", self.fired.join(" || ")))
        }
    }
}

/// Bind `sources` as pulses: an event contributes its own fired expression; a
/// level gets a synthesized change detector over its value, so it fires on
/// every change (both button edges, every new sample), exactly when the
/// runtime twin would have emitted. A constant level never re-fires, so a
/// sustained level counts once. `prefix` must be unique per (node, port) — it
/// namespaces the tracker variables.
#[must_use]
pub fn bind_pulses(prefix: &str, sources: &[SourceExpr]) -> PulseBinding {
    let mut binding = PulseBinding::default();
    for (i, source) in sources.iter().enumerate() {
        if let Some(fired) = &source.fired {
            binding.fired.push(fired.clone());
            continue;
        }
        let prev = format!("{prefix}_prev{i}");
        let now = format!("{prefix}_now{i}");
        let fired = format!("{prefix}_fired{i}");
        match source.value.ty {
            // A text source has no numeric projection (`as_double` is its
            // constant fallback), so the change detector compares the String
            // itself — otherwise a text-valued source (e.g. the Llm response)
            // could never fire a pulse port. The empty-string init mirrors the
            // numeric arm's 0.0: the runtime twin's initial stored value.
            CppType::Str => {
                let initial = source.initial.as_deref().unwrap_or("\"\"");
                binding.declarations.push(format!("String {prev} = {initial};"));
                binding
                    .loop_lines
                    .push(format!("String {now} = {};", source.value.as_string()));
                binding
                    .loop_lines
                    .push(format!("bool {fired} = ({now} != {prev});"));
            }
            // A colour or a list fires when its version moves.
            CppType::Opaque => {
                let initial = source.initial.as_deref().unwrap_or("0");
                binding.declarations.push(format!("uint8_t {prev} = {initial};"));
                binding.loop_lines.push(format!("uint8_t {now} = {};", source.value.code));
                binding
                    .loop_lines
                    .push(format!("bool {fired} = ({now} != {prev});"));
            }
            CppType::Bool | CppType::Double => {
                let initial = source.initial.as_deref().unwrap_or("0.0");
                binding.declarations.push(format!("double {prev} = {initial};"));
                binding
                    .loop_lines
                    .push(format!("double {now} = {};", source.value.as_double()));
                binding
                    .loop_lines
                    .push(format!("bool {fired} = ({now} != {prev});"));
            }
        }
        binding.loop_lines.push(format!("{prev} = {now};"));
        binding.fired.push(fired);
    }
    binding
}

/// A visible comment for a single-source port with more than one wired source:
/// the generated code deterministically follows the first source, and this
/// note keeps the dropped fan-in from disappearing silently. Returns `None`
/// when zero or one source is wired.
#[must_use]
pub fn extra_sources_note(port: &str, sources: &[SourceExpr]) -> Option<String> {
    if sources.len() <= 1 {
        return None;
    }
    Some(format!(
        "// note: {} additional source(s) wired into '{port}' are ignored — generated code follows the first source only",
        sources.len() - 1
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coercions_match_component_value_semantics() {
        let b = CppExpr::boolean("flag");
        let n = CppExpr::number("val");
        let s = CppExpr::text("txt");

        assert_eq!(b.as_bool(), "(flag)");
        assert_eq!(n.as_bool(), "((val) != 0.0)");
        assert_eq!(s.as_bool(), "((txt).length() > 0)");

        assert_eq!(b.as_double(), "((flag) ? 1.0 : 0.0)");
        assert_eq!(n.as_double(), "((double)(val))");
        // Strings carry no number: the runtime's unwrap_or default applies.
        assert_eq!(s.as_double_or("42.0"), "(42.0)");

        // as_u8 clamps like ComponentValue::as_u8.
        assert!(n.as_u8_or(255).contains("constrain"));
        assert_eq!(s.as_u8_or(255), "(uint8_t)255");
    }

    /// A colour or a list carries no number and no text, and is truthy —
    /// except at version 0, the plain number 0 a cleared Matrix holds.
    #[test]
    fn a_colour_or_a_list_coerces_like_component_value() {
        let o = CppExpr::opaque("rgb_v");
        assert_eq!(o.as_bool(), "((rgb_v) != 0)");
        assert_eq!(o.as_double_or("90.0"), "(((rgb_v) != 0) ? (90.0) : 0.0)");
        assert_eq!(o.as_u8_or(255), "(uint8_t)(((rgb_v) != 0) ? 255 : 0)");
        assert!(!o.has_number(), "dropped by a fold, like `as_number` = None");
        assert_eq!((o.storage_type(), o.storage_zero()), ("uint8_t", "0"));
    }

    /// A change detector starts from the value its source holds before it
    /// first emits, so a Servo that has not moved from its centre — or an Rgb
    /// still at its first colour — does not fire on the first tick.
    #[test]
    fn a_change_detector_starts_from_the_sources_initial_value() {
        let servo = [SourceExpr::level(CppExpr::number("servo_v")).starting_at("90.0")];
        assert_eq!(bind_pulses("c", &servo).declarations, ["double c_prev0 = 90.0;"]);
        let rgb = [SourceExpr::level(CppExpr::opaque("rgb_v")).starting_at("1")];
        let b = bind_pulses("c", &rgb);
        assert_eq!(b.declarations, ["uint8_t c_prev0 = 1;"]);
        assert!(b.loop_lines.contains(&"uint8_t c_now0 = rgb_v;".to_string()), "{:?}", b.loop_lines);
    }

    #[test]
    fn inputs_group_sources_per_port_in_order() {
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::level(CppExpr::number("a")));
        inputs.add("value", SourceExpr::level(CppExpr::number("b")));
        inputs.add("toggle", SourceExpr::level(CppExpr::boolean("c")));

        assert_eq!(inputs.on("value").len(), 2);
        assert_eq!(inputs.on("value")[0].value.code, "a");
        assert_eq!(inputs.first("toggle").unwrap().value.code, "c");
        assert!(inputs.on("unwired").is_empty(), "{:?}", inputs.on("unwired"));
        assert_eq!(inputs.ports().collect::<Vec<_>>(), ["toggle", "value"]);
    }

    #[test]
    fn level_sources_synthesize_a_change_detector() {
        // A `value`-handle source fires on every change — both button edges,
        // every new sample — mirroring the runtime's emit-on-update.
        let sources = [SourceExpr::level(CppExpr::number("sensor_v"))];
        let b = bind_pulses("counter_c_set", &sources);
        assert!(b.declarations[0].starts_with("double counter_c_set_prev0"));
        assert!(b.loop_lines.iter().any(|l| l.contains("!= counter_c_set_prev0")));
        assert_eq!(b.fired, ["counter_c_set_fired0"]);
    }

    #[test]
    fn bool_level_sources_fire_on_both_edges() {
        // A boolean level (a Button's `value`) fires each time it changes, as
        // the runtime emits `value` on each new state.
        let sources = [SourceExpr::level(CppExpr::boolean("btn"))];
        let b = bind_pulses("led_l1_value", &sources);
        assert_eq!(b.declarations, ["double led_l1_value_prev0 = 0.0;"]);
        assert!(
            b.loop_lines.iter().any(|l| l == "bool led_l1_value_fired0 = (led_l1_value_now0 != led_l1_value_prev0);"),
            "{:?}",
            b.loop_lines
        );
        assert_eq!(b.any_fired().unwrap(), "(led_l1_value_fired0)");
    }

    #[test]
    fn str_level_sources_synthesize_a_string_compare_detector() {
        // A text source coerced through as_double is a constant, so the change
        // detector must compare the String itself or the port never fires.
        let sources = [SourceExpr::level(CppExpr::text("llm_l_value"))];
        let b = bind_pulses("counter_c_inc", &sources);
        assert_eq!(b.declarations, ["String counter_c_inc_prev0 = \"\";"]);
        assert!(
            b.loop_lines.iter().any(|l| l == "String counter_c_inc_now0 = (llm_l_value);"),
            "compares the String value, got: {:?}",
            b.loop_lines
        );
        assert!(b
            .loop_lines
            .iter()
            .any(|l| l.contains("counter_c_inc_now0 != counter_c_inc_prev0")));
        assert_eq!(b.fired, ["counter_c_inc_fired0"]);
    }

    #[test]
    fn pulse_binding_reuses_event_sources_fired_expression() {
        let sources = [SourceExpr::event(CppExpr::number("delay_d_value"), "delay_d_fired")];
        let b = bind_pulses("x", &sources);
        assert!(b.declarations.is_empty(), "event sources need no tracker");
        assert!(b.loop_lines.is_empty(), "{:?}", b.loop_lines);
        assert_eq!(b.fired, ["delay_d_fired"]);
    }

    #[test]
    fn multiple_sources_or_together() {
        let sources = [
            SourceExpr::level(CppExpr::boolean("a")),
            SourceExpr::event(CppExpr::number("b"), "b_fired"),
        ];
        let b = bind_pulses("p", &sources);
        assert_eq!(b.fired.len(), 2);
        assert_eq!(b.any_fired().unwrap(), "(p_fired0 || b_fired)");
    }
}
