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

    /// Coerce to a C++ `bool` expression, mirroring `ComponentValue::as_bool`:
    /// numbers are truthy when non-zero, strings when non-empty.
    #[must_use]
    pub fn as_bool(&self) -> String {
        let c = &self.code;
        match self.ty {
            CppType::Bool => format!("({c})"),
            CppType::Double => format!("(({c}) != 0.0)"),
            CppType::Str => format!("(({c}).length() > 0)"),
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
        }
    }
}

/// How a pulse-consuming port detects that a level source "fired", mirroring
/// when the runtime twin would have emitted on that handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detector {
    /// Fire on any change of the numeric value — the shape of `value`-style
    /// handles, which the runtime emits on every stored-value update (a
    /// Button's `value` fires on press *and* release).
    Change,
    /// Fire only on the falsey→truthy transition — the shape of `true` /
    /// `false`-style handles, which the runtime emits only when the state
    /// enters that side.
    RisingEdge,
}

/// What a source Node exposes on one emit handle: the value expression plus
/// how its emissions map onto loop iterations — either an explicit *fired*
/// expression (event-shaped handles like Delay `event`, Interval `event`,
/// Trigger `bang`: true only on the emitting tick) or a [`Detector`] that
/// pulse-consuming ports synthesize over the value (see [`bind_pulses`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceExpr {
    /// The typed value expression downstream code reads.
    pub value: CppExpr,
    /// C++ `bool` expression, true only on the tick the source fired.
    pub fired: Option<String>,
    /// Synthesized-detector shape when `fired` is absent.
    pub detector: Detector,
}

impl SourceExpr {
    /// A level-valued source whose runtime twin emits on every value change.
    #[must_use]
    pub fn level(value: CppExpr) -> Self {
        Self { value, fired: None, detector: Detector::Change }
    }

    /// A level-valued source whose runtime twin fires only when the
    /// expression turns truthy (`true`/`false` state handles).
    #[must_use]
    pub fn rising(value: CppExpr) -> Self {
        Self { value, fired: None, detector: Detector::RisingEdge }
    }

    /// An event-valued source: `fired` is true exactly on the emission tick.
    #[must_use]
    pub fn event(value: CppExpr, fired: impl Into<String>) -> Self {
        Self { value, fired: Some(fired.into()), detector: Detector::Change }
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

/// Bind `sources` as pulses: event-shaped sources contribute their own fired
/// expression; level sources get a synthesized detector over their value —
/// per the source's [`Detector`], so a `value`-handle source fires on every
/// change (both button edges, every new sample) while a `true`/`false`-handle
/// source fires only when its expression turns truthy, exactly when the
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
        match source.detector {
            Detector::RisingEdge => {
                binding.declarations.push(format!("bool {prev} = false;"));
                binding.loop_lines.push(format!("bool {now} = {};", source.value.as_bool()));
                binding
                    .loop_lines
                    .push(format!("bool {fired} = {now} && !{prev};"));
            }
            Detector::Change => {
                binding.declarations.push(format!("double {prev} = 0.0;"));
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

    #[test]
    fn inputs_group_sources_per_port_in_order() {
        let mut inputs = NodeInputs::default();
        inputs.add("value", SourceExpr::level(CppExpr::number("a")));
        inputs.add("value", SourceExpr::level(CppExpr::number("b")));
        inputs.add("toggle", SourceExpr::level(CppExpr::boolean("c")));

        assert_eq!(inputs.on("value").len(), 2);
        assert_eq!(inputs.on("value")[0].value.code, "a");
        assert_eq!(inputs.first("toggle").unwrap().value.code, "c");
        assert!(inputs.on("unwired").is_empty());
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
    fn rising_sources_synthesize_a_rising_edge_detector() {
        // A `true`/`false`-handle source fires only when its expression turns
        // truthy — the runtime emits those handles on entry to that side.
        let sources = [SourceExpr::rising(CppExpr::boolean("btn"))];
        let b = bind_pulses("led_l1_true", &sources);
        assert_eq!(b.declarations, ["bool led_l1_true_prev0 = false;"]);
        assert!(b.loop_lines.iter().any(|l| l.contains("&& !led_l1_true_prev0")));
        assert_eq!(b.any_fired().unwrap(), "(led_l1_true_fired0)");
    }

    #[test]
    fn pulse_binding_reuses_event_sources_fired_expression() {
        let sources = [SourceExpr::event(CppExpr::number("delay_d_value"), "delay_d_fired")];
        let b = bind_pulses("x", &sources);
        assert!(b.declarations.is_empty(), "event sources need no tracker");
        assert!(b.loop_lines.is_empty());
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
