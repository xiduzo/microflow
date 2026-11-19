//! Function emitter — translates the user-authored JS of a Function Node into
//! C++ for the generated Sketch, the codegen mirror of
//! `nodes/function/runtime.rs`.
//!
//! The live Function Node evaluates arbitrary JavaScript via `boa_engine`. That
//! cannot be reproduced on a bare board, so this emitter translates a
//! deterministic **expression subset** and holds it to JavaScript's semantics,
//! not C++'s: `&&` / `||` hand on an operand, `%` keeps the dividend's sign
//! (`fmod`), `Math.round` rounds halves up, `NaN` is falsy, `===` between a
//! number and a boolean is `false`, and so on. Code outside the subset, or
//! whose result the board cannot hold the way the live Node does, is never
//! guessed at: the Node emits a clearly-marked `// unsupported` note, never
//! evaluates and never emits, and generation reports a warning naming the
//! reason ([`board_refusal`]).
//!
//! ## Supported subset
//!
//! The Node's `code` is a body of zero or more `const` / `let` / `var`
//! bindings and a `return`, separated by `;` or by a line break before the
//! next keyword (JavaScript's automatic semicolon insertion):
//!
//! ```js
//! const a = input * 2;
//! let b = a + 1
//! return b > 10 ? a : b;
//! ```
//!
//! Within an expression the subset allows:
//! - `input`, when it is a number or a boolean (not text, a colour or a list),
//!   and any name bound earlier in the body,
//! - decimal number literals (`5`, `2.5`, `.5`, `1e3`), `true` / `false`,
//! - arithmetic `+ - * / % **`, unary `- + !`,
//! - comparisons `> < >= <= == != === !==`,
//! - `&& ||`, a ternary `?:`, and parentheses,
//! - `Math.floor`, `ceil`, `round`, `abs`, `sqrt`, `pow`, `min`, `max`,
//! - the runtime builtins `toNumber`, `toBool`, `isValid` and `ensureRange`.
//!
//! The result must be a number on every input or a boolean on every input:
//! the board keeps one type, the live Node can hand on either.
//!
//! Everything else — loops, objects, strings, `{{var}}` template slots, other
//! calls and members — is unsupported. On AVR boards (the Uno) `double` is a
//! 32-bit float, so results agree with the live Node to about seven digits.
//!
//! Like every other emitter this is a pure function of the [`FlowNode`] and
//! what is wired into it: identical input always yields identical output.

use super::config::FunctionConfig;
use crate::codegen::emit::{cpp_double, NodeEmission, NodeToken};
use crate::codegen::wire::{extra_sources_note, CppExpr, CppType, NodeInputs, SourceExpr};
use crate::config::{resolve, UnreadableConfig};
use crate::flow::FlowNode;
use std::collections::{BTreeMap, BTreeSet};

/// The C++ variable holding this Function Node's latest emitted result.
#[must_use]
pub(crate) fn value_var(node: &FlowNode) -> String {
    format!("function_{}_value", node.id_token())
}

/// The prefix of every C++ name the Node declares.
fn prefix(node: &FlowNode) -> String {
    format!("function_{}", node.id_token())
}

/// True on the tick an evaluation moved the value (see [`emit`]).
fn changed_var(node: &FlowNode) -> String {
    format!("function_{}_changed", node.id_token())
}

/// What the Function Node exposes on `value`, fed by `input` (the first
/// source on `trigger` with an on-device value, if any): its result, in the
/// type the translated code returns, as an event on the ticks the live Node
/// emits — an evaluation whose result differs from the value it holds, as
/// `ComponentBase::set_value` decides (a `NaN` always differs; a first
/// boolean differs from the number 0 the live Node starts at).
#[must_use]
pub(crate) fn output(node: &FlowNode, input: Option<&SourceExpr>) -> SourceExpr {
    let var = value_var(node);
    let fired = format!("(function_{}_fired && {})", node.id_token(), changed_var(node));
    let returns_bool = resolve::<FunctionConfig>(&node.data)
        .ok()
        .and_then(|config| translate(&config.code, input.map(|s| &s.value), &prefix(node)).ok())
        .is_some_and(|t| t.result.ty == Ty::Bool);
    let value = if returns_bool { CppExpr::boolean(var) } else { CppExpr::number(var) };
    SourceExpr::event(value, fired)
}

/// Why the Function Node fed by `input` cannot run on the board, when it is
/// wired (an unwired Function evaluates nowhere, live or on the board) and its
/// settings can be read. `None` when the board runs it as the live Node does.
#[must_use]
pub(crate) fn board_refusal(node: &FlowNode, input: Option<&SourceExpr>) -> Option<String> {
    let input = input?;
    let config = resolve::<FunctionConfig>(&node.data).ok()?;
    translate(&config.code, Some(&input.value), &prefix(node)).err()
}

/// Emit C++ for a Function Node from its `trigger` port. The first wired
/// source feeds the Node's `input` (extra sources are noted). Like the live
/// Node, it evaluates on each tick that source fires and on no other
/// ([`NodeEmission::transform`]): with nothing wired in it never evaluates and
/// its value stays at `0.0`.
///
/// An evaluation computes the result into `function_<id>_next` and, as the
/// live `set_value` does, takes it as the Node's value and emits only when it
/// differs from the value held. When the code falls outside the supported
/// subset, a clearly-marked `// unsupported` note is emitted instead and the
/// Node never evaluates.
pub(crate) fn emit(node: &FlowNode, inputs: &NodeInputs) -> Result<NodeEmission, UnreadableConfig> {
    let token = node.id_token();
    let var = value_var(node);
    let changed = changed_var(node);
    let config = resolve::<FunctionConfig>(&node.data)?;
    let mut e = NodeEmission::default();

    let sources = inputs.on("trigger");
    let first = &sources[..sources.len().min(1)];
    let prefix = prefix(node);
    match translate(&config.code, first.first().map(|s| &s.value), &prefix) {
        Ok(t) => {
            let (storage, zero) = t.result.ty.storage();
            e.declarations.push(format!("{storage} {var} = {zero};"));
            e.declarations.push(format!("bool {changed} = false;"));
            let mut step: Vec<String> = t
                .bindings
                .iter()
                .map(|b| format!("{} {} = {};", b.ty.storage().0, b.local, b.cpp))
                .collect();
            step.push(format!("{storage} {prefix}_next = {};", t.result.cpp));
            if t.result.ty == Ty::Bool {
                // The live Node starts at the number 0: its first boolean is
                // a new value, whatever it is.
                let held = format!("{prefix}_held");
                e.declarations.push(format!("bool {held} = false;"));
                step.push(format!("{changed} = !{held} || ({prefix}_next != {var});"));
                step.push(format!("{held} = true;"));
            } else {
                step.push(format!("{changed} = ({prefix}_next != {var});"));
            }
            step.push(format!("if ({changed}) {{ {var} = {prefix}_next; }}"));
            e.shared_declarations.extend(t.helpers.iter().map(|h| h.definition().to_string()));
            e.transform(&prefix, first, step);
        }
        Err(reason) => {
            e.declarations.push(format!("double {var} = 0.0;"));
            e.declarations.push(format!("bool {changed} = false;"));
            e.declarations.push(format!(
                "// unsupported Function Node {token}: {} — no C++ emitted; it never evaluates and its value stays 0.0",
                crate::codegen::emit::cpp_comment_text(&reason)
            ));
            e.transform(&prefix, &[], Vec::new());
        }
    }
    if let Some(note) = extra_sources_note("trigger", sources) {
        e.declarations.push(note);
    }
    Ok(e)
}

// --- Types and values ---

/// The JavaScript type a translated expression has on every input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ty {
    /// A number, held in a C++ `double`.
    Num,
    /// A boolean, held in a C++ `bool`.
    Bool,
    /// A number on some inputs and a boolean on others (`x && y > 1`). Held
    /// in a `double` as the number the boolean converts to — which is all
    /// arithmetic, comparison, loose equality and truthiness see of it — but
    /// it cannot be returned, nor compared with `===`.
    Mixed,
}

impl Ty {
    /// The C++ storage type and its zero.
    fn storage(self) -> (&'static str, &'static str) {
        match self {
            Ty::Bool => ("bool", "false"),
            Ty::Num | Ty::Mixed => ("double", "0.0"),
        }
    }

    /// The type of a value that is `self` on some inputs and `other` on the rest.
    fn join(self, other: Ty) -> Ty {
        if self == other {
            self
        } else {
            Ty::Mixed
        }
    }
}

/// A translated expression: C++ source of its storage type, and its type.
#[derive(Debug, Clone)]
struct Js {
    cpp: String,
    ty: Ty,
}

impl Js {
    fn new(cpp: impl Into<String>, ty: Ty) -> Self {
        Self { cpp: cpp.into(), ty }
    }

    /// As a C++ `double`: JavaScript's `ToNumber` of a number or a boolean.
    fn num(&self) -> String {
        match self.ty {
            Ty::Bool => format!("(({}) ? 1.0 : 0.0)", self.cpp),
            Ty::Num | Ty::Mixed => self.cpp.clone(),
        }
    }
}

/// A C++ function the translation calls, defined once per Sketch
/// (`NodeEmission::shared_declarations`) where C++ differs from JavaScript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Helper {
    Truthy,
    Round,
    Min,
    Max,
    Pow,
    ToNumber,
    EnsureRange,
}

impl Helper {
    fn definition(self) -> &'static str {
        match self {
            Helper::Truthy => {
                "// JavaScript truthiness of a number: 0 and NaN are false.\n\
                 inline bool mf_js_truthy(double x) { return x != 0.0 && !isnan(x); }"
            }
            Helper::Round => {
                "// JavaScript Math.round: a half rounds up, toward +Infinity; -0.5 to -0.\n\
                 inline double mf_js_round(double x) {\n  \
                   if (isnan(x) || isinf(x)) { return x; }\n  \
                   double r = floor(x);\n  \
                   if (x - r >= 0.5) { r += 1.0; }\n  \
                   return (r == 0.0 && x < 0.0) ? -0.0 : r;\n\
                 }"
            }
            Helper::Min => {
                "// JavaScript Math.min: NaN if either is NaN, and -0 is less than 0.\n\
                 inline double mf_js_min(double a, double b) {\n  \
                   if (isnan(a) || isnan(b)) { return NAN; }\n  \
                   if (a == b) { return signbit(a) ? a : b; }\n  \
                   return a < b ? a : b;\n\
                 }"
            }
            Helper::Max => {
                "// JavaScript Math.max: NaN if either is NaN, and 0 is more than -0.\n\
                 inline double mf_js_max(double a, double b) {\n  \
                   if (isnan(a) || isnan(b)) { return NAN; }\n  \
                   if (a == b) { return signbit(a) ? b : a; }\n  \
                   return a > b ? a : b;\n\
                 }"
            }
            Helper::Pow => {
                "// JavaScript Math.pow / **: a NaN exponent, or 1 to an infinite one, is NaN.\n\
                 inline double mf_js_pow(double a, double b) {\n  \
                   if (isnan(b) || (isinf(b) && (a == 1.0 || a == -1.0))) { return NAN; }\n  \
                   return pow(a, b);\n\
                 }"
            }
            Helper::ToNumber => {
                "// The Function Node's toNumber(x, fallback): fallback for NaN.\n\
                 inline double mf_js_to_number(double x, double fallback) { return isnan(x) ? fallback : x; }"
            }
            Helper::EnsureRange => {
                "// The Function Node's ensureRange(x, min, max, fallback).\n\
                 inline double mf_js_ensure_range(double x, double lo, double hi, double fallback) {\n  \
                   return (isnan(x) || x < lo || x > hi) ? fallback : x;\n\
                 }"
            }
        }
    }
}

// --- Translation ---

/// A binding the step declares as a local, because the result reads it.
#[derive(Debug)]
struct Local {
    local: String,
    cpp: String,
    ty: Ty,
}

/// A translated body: the locals the result reads (in order), the result,
/// and the helpers they call.
#[derive(Debug)]
struct Translation {
    bindings: Vec<Local>,
    result: Js,
    helpers: BTreeSet<Helper>,
}

/// How a name is declared, for JavaScript's redeclaration rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decl {
    Param,
    Var,
    Lexical,
}

/// One bound name: what reading it yields, or why it cannot be read.
#[derive(Debug, Clone)]
struct Binding {
    name: String,
    value: Result<Js, String>,
    /// Index into the body's bindings (`None` for `input`).
    index: Option<usize>,
}

/// Names a binding may not take: JavaScript's reserved words, and the
/// builtins a call resolves by name.
const RESERVED: &[&str] = &[
    "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
    "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "function",
    "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "null",
    "package", "private", "protected", "public", "return", "static", "super", "switch", "this",
    "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield", "undefined",
    "NaN", "Infinity", "Math", "toNumber", "toBool", "toString", "isValid", "ensureRange",
    "oneOf",
];

/// Translate the Function Node's JS body, its `input` the wired source's
/// value (`None` when unwired), or return a human-readable reason the board
/// cannot run it as the live Node does. A binding the result reads becomes
/// the local `{prefix}_v{n}`.
fn translate(code: &str, input: Option<&CppExpr>, prefix: &str) -> Result<Translation, String> {
    let input_value = match input.map(|i| (i.ty, i)) {
        None => Ok(Js::new("0.0", Ty::Num)),
        Some((CppType::Double, i)) => Ok(Js::new(i.as_double(), Ty::Num)),
        Some((CppType::Bool, i)) => Ok(Js::new(i.as_bool(), Ty::Bool)),
        Some((CppType::Str, _)) => Err("its input is text, which the board does not run".to_string()),
        Some((CppType::Opaque, _)) => {
            Err("its input is a colour or a list, which the board does not run".to_string())
        }
    };
    let mut env = vec![Binding { name: "input".to_string(), value: input_value, index: None }];
    let mut declared: BTreeMap<String, Decl> = BTreeMap::from([("input".to_string(), Decl::Param)]);
    let mut locals: Vec<(Js, BTreeSet<usize>)> = Vec::new();
    let mut helpers = BTreeSet::new();
    let mut result: Option<(Js, BTreeSet<usize>)> = None;

    for stmt in split_statements(code)? {
        let stmt = stmt.trim();
        if let Some(rest) = strip_keyword(stmt, "return") {
            let leading = &rest[..rest.len() - rest.trim_start().len()];
            if rest.trim().is_empty() || leading.contains('\n') {
                return Err("`return` returns nothing (a line break after `return` ends it)".to_string());
            }
            let parsed = parse_expr(rest, &env, &mut helpers)?;
            // Code after the first `return` never runs, but must still be
            // valid: a syntax error anywhere stops the live Node.
            result.get_or_insert(parsed);
        } else if let Some((decl, name, value_src)) = parse_binding(stmt)? {
            match (declared.get(&name), decl) {
                (Some(_), Decl::Lexical) | (Some(Decl::Lexical), _) => {
                    return Err(format!("`{name}` is declared twice"));
                }
                _ => {}
            }
            declared.insert(name.clone(), decl);
            let value = parse_expr(&value_src, &env, &mut helpers)?;
            let index = locals.len();
            let local = Js::new(format!("{prefix}_v{index}"), value.0.ty);
            locals.push(value);
            env.push(Binding { name, value: Ok(local), index: Some(index) });
        } else {
            return Err(format!("unsupported statement `{}`", first_line(stmt)));
        }
    }

    let (result, deps) = result.ok_or_else(|| "the code has no `return` statement".to_string())?;
    if result.ty == Ty::Mixed {
        return Err(
            "it returns a number on some inputs and true/false on others, and the board keeps one type"
                .to_string(),
        );
    }
    // The locals the result reads, directly or through other locals.
    let mut needed = deps;
    for index in (0..locals.len()).rev() {
        if needed.contains(&index) {
            needed.extend(locals[index].1.iter().copied());
        }
    }
    let bindings = needed
        .iter()
        .map(|&i| Local { local: format!("{prefix}_v{i}"), cpp: locals[i].0.cpp.clone(), ty: locals[i].0.ty })
        .collect();
    Ok(Translation { bindings, result, helpers })
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or_default().trim()
}

/// `s` without its leading `word` keyword, when it starts with one.
fn strip_keyword<'a>(s: &'a str, word: &str) -> Option<&'a str> {
    let rest = s.strip_prefix(word)?;
    match rest.chars().next() {
        None => Some(rest),
        Some(c) if c.is_whitespace() || c == '(' || c == '!' || c == '-' || c == '+' => Some(rest),
        _ => None,
    }
}

/// Split the body into statements: on `;`, and on a line break before a
/// `return` / `const` / `let` / `var` (where JavaScript inserts the
/// semicolon), after stripping `//` line comments. Block comments and braces
/// are refused (a quick subset gate).
fn split_statements(code: &str) -> Result<Vec<String>, String> {
    let mut cleaned = String::new();
    for line in code.lines() {
        cleaned.push_str(line.find("//").map_or(line, |i| &line[..i]));
        cleaned.push('\n');
    }
    if cleaned.contains("/*") {
        return Err("block comments are not supported".to_string());
    }
    if cleaned.contains("{{") {
        return Err("`{{var}}` template slots are not supported".to_string());
    }
    if cleaned.contains('{') || cleaned.contains('}') {
        return Err("blocks, objects, and functions are not supported".to_string());
    }
    if cleaned.contains(['"', '\'', '`']) {
        return Err("text (string literals) is not supported".to_string());
    }
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut lines = cleaned.split('\n').peekable();
    while let Some(line) = lines.next() {
        for (i, part) in line.split(';').enumerate() {
            if i > 0 {
                statements.push(std::mem::take(&mut current));
            }
            current.push_str(part);
        }
        current.push('\n');
        let next_starts_statement = lines.peek().is_some_and(|next| {
            ["return", "const", "let", "var"]
                .iter()
                .any(|kw| strip_keyword(next.trim_start(), kw).is_some_and(|rest| !rest.is_empty()))
        });
        if next_starts_statement {
            statements.push(std::mem::take(&mut current));
        }
    }
    statements.push(current);
    Ok(statements.into_iter().filter(|s| !s.trim().is_empty()).collect())
}

/// Parse a `const` / `let` / `var` binding into (kind, name, value source).
/// `Ok(None)` when the statement is not a binding.
fn parse_binding(stmt: &str) -> Result<Option<(Decl, String, String)>, String> {
    let Some((decl, rest)) = [("const", Decl::Lexical), ("let", Decl::Lexical), ("var", Decl::Var)]
        .iter()
        .find_map(|(kw, decl)| strip_keyword(stmt, kw).filter(|r| r.starts_with(char::is_whitespace)).map(|r| (*decl, r)))
    else {
        return Ok(None);
    };
    let Some((name, value)) = rest.split_once('=') else {
        return Err(format!("unsupported statement `{}` (a binding needs a value)", first_line(stmt)));
    };
    let name = name.trim();
    if !is_identifier(name) {
        return Err(format!("unsupported binding `{}`", first_line(stmt)));
    }
    if RESERVED.contains(&name) {
        return Err(format!("`{name}` cannot be a variable name on the board"));
    }
    Ok(Some((decl, name.to_string(), value.trim().to_string())))
}

fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

// --- Expression parser (recursive descent over a token stream) ---

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Num(f64),
    Ident(String),
    Op(&'static str),
    LParen,
    RParen,
    Comma,
    Question,
    Colon,
}

/// Operators, longest first so `===` is not read as `==` then `=`.
const OPERATORS: &[&str] = &[
    "===", "!==", "**", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+", "-", "*", "/", "%",
    "<", ">", "!", "=", "&", "|",
];

fn tokenize(src: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = src.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c.is_whitespace() {
            i += 1;
        } else if c.is_ascii_digit() || (c == '.' && next.is_some_and(|n| n.is_ascii_digit())) {
            let (value, end) = number(&chars, i)?;
            tokens.push(Token::Num(value));
            i = end;
        } else if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '.') {
                i += 1;
            }
            tokens.push(Token::Ident(chars[start..i].iter().collect()));
        } else {
            let single = match c {
                '(' => Some(Token::LParen),
                ')' => Some(Token::RParen),
                ',' => Some(Token::Comma),
                '?' => Some(Token::Question),
                ':' => Some(Token::Colon),
                _ => None,
            };
            if let Some(token) = single {
                tokens.push(token);
                i += 1;
                continue;
            }
            let rest: String = chars[i..chars.len().min(i + 3)].iter().collect();
            let op = OPERATORS
                .iter()
                .find(|op| rest.starts_with(**op))
                .ok_or_else(|| format!("unsupported character `{c}` in expression"))?;
            if matches!(*op, "++" | "--") {
                return Err(format!("`{op}` (increment / decrement) is not supported"));
            }
            tokens.push(Token::Op(op));
            i += op.len();
        }
    }
    Ok(tokens)
}

/// Read the decimal number literal at `start`: its value and where it ends.
/// Refuses what JavaScript reads differently or not at all: a leading zero
/// (`010` is the legacy octal 8), hex / binary / octal prefixes, and a literal
/// run into a letter, a digit separator or a second point (`1.2.3`).
fn number(chars: &[char], start: usize) -> Result<(f64, usize), String> {
    let mut i = start;
    let digits = |i: &mut usize| {
        let from = *i;
        while *i < chars.len() && chars[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > from
    };
    if chars[i] == '0' && chars.get(i + 1).is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_') {
        let shown: String = chars[start..chars.len().min(start + 4)].iter().collect();
        if !chars.get(i + 1).is_some_and(|c| matches!(c, 'e' | 'E')) {
            return Err(format!("the number `{shown}…` is not a plain decimal (a leading 0 or a 0x / 0b / 0o prefix)"));
        }
    }
    digits(&mut i);
    if chars.get(i) == Some(&'.') {
        i += 1;
        digits(&mut i);
    }
    if chars.get(i).is_some_and(|c| matches!(c, 'e' | 'E')) {
        i += 1;
        if chars.get(i).is_some_and(|c| matches!(c, '+' | '-')) {
            i += 1;
        }
        if !digits(&mut i) {
            return Err("a number's exponent has no digits".to_string());
        }
    }
    let text: String = chars[start..i].iter().collect();
    if chars.get(i).is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.')) {
        return Err(format!("malformed number `{text}{}`", chars[i]));
    }
    let value = text.parse::<f64>().map_err(|e| format!("malformed number `{text}` ({e})"))?;
    Ok((value, i))
}

/// A C++ `double` literal for `value`.
fn cpp_number(value: f64) -> String {
    if value.is_infinite() {
        "INFINITY".to_string()
    } else {
        cpp_double(value)
    }
}

struct Parser<'a> {
    tokens: Vec<Token>,
    pos: usize,
    env: &'a [Binding],
    helpers: &'a mut BTreeSet<Helper>,
    /// The body's bindings the expression reads.
    deps: BTreeSet<usize>,
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn advance(&mut self) -> Option<Token> {
        let t = self.tokens.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    fn expect(&mut self, want: &Token) -> Result<(), String> {
        if self.peek() == Some(want) {
            self.pos += 1;
            Ok(())
        } else {
            Err(format!("expected {want:?} in expression"))
        }
    }

    /// JavaScript truthiness, as a C++ `bool`.
    fn truthy(&mut self, v: &Js) -> String {
        match v.ty {
            Ty::Bool => format!("({})", v.cpp),
            Ty::Num | Ty::Mixed => {
                self.helpers.insert(Helper::Truthy);
                format!("mf_js_truthy({})", v.cpp)
            }
        }
    }

    /// `cond ? a : b`, as JavaScript types it.
    fn choose(cond: &str, a: &Js, b: &Js) -> Js {
        match (a.ty, b.ty) {
            (Ty::Bool, Ty::Bool) | (Ty::Num, Ty::Num) => Js::new(format!("({cond} ? {} : {})", a.cpp, b.cpp), a.ty),
            _ => Js::new(format!("({cond} ? {} : {})", a.num(), b.num()), Ty::Mixed),
        }
    }

    // ternary := binary ('?' ternary ':' ternary)?
    fn parse_ternary(&mut self) -> Result<Js, String> {
        let cond = self.parse_binary(0)?;
        if self.peek() == Some(&Token::Question) {
            self.pos += 1;
            let then_branch = self.parse_ternary()?;
            self.expect(&Token::Colon)?;
            let else_branch = self.parse_ternary()?;
            let c = self.truthy(&cond);
            return Ok(Self::choose(&c, &then_branch, &else_branch));
        }
        Ok(cond)
    }

    /// Precedence climbing; `**` is right-associative and refuses a unary
    /// operand on its left (`-2 ** 2` is a JavaScript syntax error).
    fn parse_binary(&mut self, min_prec: u8) -> Result<Js, String> {
        let (mut lhs, mut bare_unary) = self.parse_unary()?;
        while let Some(&Token::Op(op)) = self.peek() {
            let Some(prec) = binary_prec(op) else { break };
            if prec < min_prec {
                break;
            }
            if op == "**" && bare_unary {
                return Err("a unary operator before `**` needs parentheses".to_string());
            }
            self.pos += 1;
            let rhs = self.parse_binary(if op == "**" { prec } else { prec + 1 })?;
            lhs = self.binary(op, &lhs, &rhs)?;
            bare_unary = false;
        }
        Ok(lhs)
    }

    fn binary(&mut self, op: &str, a: &Js, b: &Js) -> Result<Js, String> {
        let (lhs, rhs) = (a.num(), b.num());
        Ok(match op {
            "+" | "-" | "*" | "/" => Js::new(format!("({lhs} {op} {rhs})"), Ty::Num),
            "%" => Js::new(format!("fmod({lhs}, {rhs})"), Ty::Num),
            "**" => {
                self.helpers.insert(Helper::Pow);
                Js::new(format!("mf_js_pow({lhs}, {rhs})"), Ty::Num)
            }
            ">" | "<" | ">=" | "<=" | "==" | "!=" => Js::new(format!("({lhs} {op} {rhs})"), Ty::Bool),
            "===" | "!==" => {
                let same = op == "===";
                if a.ty == Ty::Mixed || b.ty == Ty::Mixed {
                    return Err(format!(
                        "`{op}` compares a value that is a number on some inputs and true/false on others"
                    ));
                }
                if a.ty == b.ty {
                    Js::new(format!("({lhs} {} {rhs})", if same { "==" } else { "!=" }), Ty::Bool)
                } else {
                    // A number is never strictly equal to a boolean.
                    Js::new(if same { "false" } else { "true" }, Ty::Bool)
                }
            }
            "&&" => {
                if (a.ty, b.ty) == (Ty::Bool, Ty::Bool) {
                    Js::new(format!("({} && {})", a.cpp, b.cpp), Ty::Bool)
                } else {
                    let cond = self.truthy(a);
                    Self::choose(&cond, b, a)
                }
            }
            "||" => {
                if (a.ty, b.ty) == (Ty::Bool, Ty::Bool) {
                    Js::new(format!("({} || {})", a.cpp, b.cpp), Ty::Bool)
                } else {
                    let cond = self.truthy(a);
                    Self::choose(&cond, a, b)
                }
            }
            other => return Err(format!("unsupported operator `{other}`")),
        })
    }

    /// A unary expression, and whether it is one (an operator applied).
    fn parse_unary(&mut self) -> Result<(Js, bool), String> {
        if let Some(&Token::Op(op @ ("-" | "+" | "!"))) = self.peek() {
            self.pos += 1;
            let (operand, _) = self.parse_unary()?;
            let v = match op {
                "-" => Js::new(format!("(-{})", operand.num()), Ty::Num),
                "+" => Js::new(operand.num(), Ty::Num),
                _ => Js::new(format!("(!{})", self.truthy(&operand)), Ty::Bool),
            };
            return Ok((v, true));
        }
        Ok((self.parse_primary()?, false))
    }

    fn parse_primary(&mut self) -> Result<Js, String> {
        match self.advance() {
            Some(Token::Num(n)) => Ok(Js::new(cpp_number(n), Ty::Num)),
            Some(Token::LParen) => {
                let inner = self.parse_ternary()?;
                self.expect(&Token::RParen)?;
                Ok(Js::new(format!("({})", inner.cpp), inner.ty))
            }
            Some(Token::Ident(name)) => self.parse_ident(&name),
            Some(Token::Op(op)) => Err(format!("unexpected `{op}` in expression")),
            other => Err(format!("unexpected {other:?} in expression")),
        }
    }

    fn parse_ident(&mut self, name: &str) -> Result<Js, String> {
        if self.peek() == Some(&Token::LParen) {
            return self.parse_call(name);
        }
        match name {
            "true" | "false" => Ok(Js::new(name, Ty::Bool)),
            _ => {
                let binding = self
                    .env
                    .iter()
                    .rev()
                    .find(|b| b.name == name)
                    .ok_or_else(|| format!("unknown identifier `{name}`"))?;
                if let Some(index) = binding.index {
                    self.deps.insert(index);
                }
                binding.value.clone()
            }
        }
    }

    fn parse_call(&mut self, name: &str) -> Result<Js, String> {
        self.expect(&Token::LParen)?;
        let mut args = Vec::new();
        if self.peek() != Some(&Token::RParen) {
            loop {
                args.push(self.parse_ternary()?);
                if self.peek() == Some(&Token::Comma) {
                    self.pos += 1;
                } else {
                    break;
                }
            }
        }
        self.expect(&Token::RParen)?;
        self.call(name, &args)
    }

    /// A supported call. Like JavaScript, a `Math` function ignores extra
    /// arguments and reads a missing one as `NaN`.
    fn call(&mut self, name: &str, args: &[Js]) -> Result<Js, String> {
        let arg = |i: usize| args.get(i).map_or_else(|| "NAN".to_string(), Js::num);
        let num = |cpp: String| Ok(Js::new(cpp, Ty::Num));
        let at_least = |n: usize| {
            if args.len() < n {
                Err(format!("`{name}` needs {n} argument(s) on the board"))
            } else {
                Ok(())
            }
        };
        match name {
            "Math.floor" => num(format!("floor({})", arg(0))),
            "Math.ceil" => num(format!("ceil({})", arg(0))),
            "Math.abs" => num(format!("fabs({})", arg(0))),
            "Math.sqrt" => num(format!("sqrt({})", arg(0))),
            "Math.round" => {
                self.helpers.insert(Helper::Round);
                num(format!("mf_js_round({})", arg(0)))
            }
            "Math.pow" => {
                self.helpers.insert(Helper::Pow);
                num(format!("mf_js_pow({}, {})", arg(0), arg(1)))
            }
            "Math.min" | "Math.max" => {
                let (helper, f, empty) = if name == "Math.min" {
                    (Helper::Min, "mf_js_min", "INFINITY")
                } else {
                    (Helper::Max, "mf_js_max", "(-INFINITY)")
                };
                let Some((first, rest)) = args.split_first() else { return num(empty.to_string()) };
                if !rest.is_empty() {
                    self.helpers.insert(helper);
                }
                num(rest.iter().fold(first.num(), |acc, a| format!("{f}({acc}, {})", a.num())))
            }
            "toNumber" => {
                at_least(1)?;
                let x = &args[0];
                if x.ty == Ty::Bool {
                    return num(x.num());
                }
                let fallback = args.get(1).map_or_else(|| Js::new("0.0", Ty::Num), Clone::clone);
                self.helpers.insert(Helper::ToNumber);
                Ok(Js::new(format!("mf_js_to_number({}, {})", x.cpp, fallback.num()), fallback.ty.join(Ty::Num)))
            }
            "toBool" => {
                at_least(1)?;
                Ok(Js::new(self.truthy(&args[0]), Ty::Bool))
            }
            "isValid" => {
                at_least(1)?;
                let x = &args[0];
                Ok(match x.ty {
                    Ty::Bool => Js::new("true", Ty::Bool),
                    Ty::Num | Ty::Mixed => Js::new(format!("(!isnan({}))", x.cpp), Ty::Bool),
                })
            }
            "ensureRange" => {
                at_least(3)?;
                let fallback = args.get(3).unwrap_or(&args[1]);
                self.helpers.insert(Helper::EnsureRange);
                Ok(Js::new(
                    format!(
                        "mf_js_ensure_range({}, {}, {}, {})",
                        args[0].num(),
                        args[1].num(),
                        args[2].num(),
                        fallback.num()
                    ),
                    fallback.ty.join(Ty::Num),
                ))
            }
            _ => Err(format!("unsupported call `{name}`")),
        }
    }
}

/// Binary operator precedence (higher binds tighter), as JavaScript ranks
/// them. `None` → not a supported binary operator.
fn binary_prec(op: &str) -> Option<u8> {
    Some(match op {
        "||" => 1,
        "&&" => 2,
        "==" | "===" | "!=" | "!==" => 3,
        ">" | "<" | ">=" | "<=" => 4,
        "+" | "-" => 5,
        "*" | "/" | "%" => 6,
        "**" => 7,
        _ => return None,
    })
}

/// Parse a full expression against the bindings so far: its translation and
/// the bindings it reads.
fn parse_expr(src: &str, env: &[Binding], helpers: &mut BTreeSet<Helper>) -> Result<(Js, BTreeSet<usize>), String> {
    let trimmed = src.trim();
    if trimmed.is_empty() {
        return Err("empty expression".to_string());
    }
    let tokens = tokenize(trimmed)?;
    let mut parser = Parser { tokens, pos: 0, env, helpers, deps: BTreeSet::new() };
    let result = parser.parse_ternary()?;
    if parser.pos != parser.tokens.len() {
        return Err(format!("unexpected {:?} in expression", parser.tokens[parser.pos]));
    }
    Ok((result, parser.deps))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::Position;
    use serde_json::json;

    fn func(id: &str, code: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Function".to_string()),
            data: json!({ "code": code }),
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    /// One numeric source `x` wired into the Function's `trigger` port.
    fn trig(expr: &str) -> NodeInputs {
        let mut inputs = NodeInputs::default();
        inputs.add("trigger", SourceExpr::level(CppExpr::number(expr)));
        inputs
    }

    /// The line computing the result: `<type> function_<id>_next = <expr>;`.
    fn next_line(e: &NodeEmission) -> String {
        e.loop_body.iter().map(|l| l.trim()).find(|l| l.contains("_next = ")).unwrap_or_default().to_string()
    }

    fn unsupported_note(e: &NodeEmission) -> Option<&String> {
        e.declarations.iter().find(|d| d.contains("// unsupported Function Node"))
    }

    fn refusal(code: &str, input: &CppExpr) -> String {
        translate(code, Some(input), "f").err().unwrap_or_else(|| panic!("{code:?} must be refused"))
    }

    /// A Function node that holds no `code` runs the starter body
    /// (`FunctionConfig`'s default) live, which returns its input; the sketch
    /// runs the same.
    #[test]
    fn a_function_without_code_passes_its_input_through_like_the_runtime() {
        let mut without_code = func("fn-1", "");
        without_code.data = json!({});
        let e = emit(&without_code, &trig("x")).unwrap();
        assert_eq!(unsupported_note(&e), None);
        assert_eq!(next_line(&e), "double function_fn_1_next = function_fn_1_v0;");
        assert!(
            e.loop_body.iter().any(|l| l.trim() == "double function_fn_1_v0 = ((double)(x));"),
            "{:?}",
            e.loop_body
        );
        assert_eq!(e, emit(&func("fn-1", "const value = input;\nreturn value;"), &trig("x")).unwrap());
    }

    #[test]
    fn declares_the_value_and_the_change_flag() {
        let e = emit(&func("fn-1", "return input;"), &NodeInputs::default()).unwrap();
        for decl in [
            "double function_fn_1_value = 0.0;",
            "bool function_fn_1_changed = false;",
            "bool function_fn_1_fired = false;",
        ] {
            assert!(e.declarations.iter().any(|d| d == decl), "{decl}: {:?}", e.declarations);
        }
    }

    /// The result is taken, and sent, only when it differs from the value
    /// held — as `ComponentBase::set_value` decides.
    #[test]
    fn a_result_is_taken_only_when_it_differs() {
        let e = emit(&func("fn-1", "return input + 1;"), &trig("x")).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains("function_fn_1_changed = (function_fn_1_next != function_fn_1_value);"), "{body}");
        assert!(body.contains("if (function_fn_1_changed) { function_fn_1_value = function_fn_1_next; }"), "{body}");
        let out = output(&func("fn-1", "return input + 1;"), None);
        assert_eq!(out.fired.as_deref(), Some("(function_fn_1_fired && function_fn_1_changed)"));
        assert_eq!(out.value, CppExpr::number("function_fn_1_value"));
    }

    /// A boolean result is held as a `bool`, and its first evaluation is
    /// always a new value: the live Node starts at the number 0.
    #[test]
    fn a_boolean_result_is_a_boolean_and_its_first_is_sent() {
        let node = func("fn-1", "return input > 5;");
        let e = emit(&node, &trig("x")).unwrap();
        assert!(e.declarations.iter().any(|d| d == "bool function_fn_1_value = false;"), "{:?}", e.declarations);
        let body = e.loop_body.join("\n");
        assert!(
            body.contains("function_fn_1_changed = !function_fn_1_held || (function_fn_1_next != function_fn_1_value);"),
            "{body}"
        );
        assert_eq!(output(&node, None).value, CppExpr::boolean("function_fn_1_value"));
    }

    /// `return input` hands on the input's own type: a boolean from a Button.
    #[test]
    fn the_output_type_follows_the_input() {
        let node = func("fn-1", "return input;");
        let button = SourceExpr::level(CppExpr::boolean("button_b_state"));
        assert_eq!(output(&node, Some(&button)).value.ty, CppType::Bool);
        assert_eq!(output(&node, None).value.ty, CppType::Double);
    }

    /// Bindings become locals; only those the result reads are declared.
    #[test]
    fn bindings_the_result_reads_become_locals() {
        let code = "const a = input * 2;\nconst unused = a + 7;\nconst b = a + 3;\nreturn b;";
        let e = emit(&func("fn-1", code), &trig("x")).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains("double function_fn_1_v0 = (((double)(x)) * 2.0);"), "{body}");
        assert!(!body.contains("function_fn_1_v1"), "an unread binding is not declared: {body}");
        assert!(body.contains("double function_fn_1_v2 = (function_fn_1_v0 + 3.0);"), "{body}");
        assert_eq!(next_line(&e), "double function_fn_1_next = function_fn_1_v2;");
    }

    /// `%` is `fmod` (C++ `%` takes no `double`), `&&` hands on an operand,
    /// and `Math.round` / `min` call the JavaScript helpers — each defined
    /// once, and only when used.
    #[test]
    fn javascript_semantics_come_from_helpers_where_cpp_differs() {
        let e = emit(&func("fn-1", "return input % 3;"), &trig("x")).unwrap();
        assert_eq!(next_line(&e), "double function_fn_1_next = fmod(((double)(x)), 3.0);");
        assert_eq!(e.shared_declarations, [] as [String; 0]);

        let e = emit(&func("fn-1", "return input && 5;"), &trig("x")).unwrap();
        assert_eq!(
            next_line(&e),
            "double function_fn_1_next = (mf_js_truthy(((double)(x))) ? 5.0 : ((double)(x)));"
        );
        assert_eq!(e.shared_declarations, [Helper::Truthy.definition()]);

        let e = emit(&func("fn-1", "return Math.round(Math.min(input, 1)) + Math.round(input);"), &trig("x")).unwrap();
        assert_eq!(e.shared_declarations, [Helper::Round.definition(), Helper::Min.definition()]);
    }

    /// A number is never strictly equal to a boolean.
    #[test]
    fn strict_equality_of_a_number_and_a_boolean_is_false() {
        let e = emit(&func("fn-1", "return input === (input > 0);"), &trig("x")).unwrap();
        assert_eq!(next_line(&e), "bool function_fn_1_next = false;");
        let e = emit(&func("fn-1", "return input === 5;"), &trig("x")).unwrap();
        assert_eq!(next_line(&e), "bool function_fn_1_next = (((double)(x)) == 5.0);");
    }

    #[test]
    fn a_loop_is_refused_and_never_evaluates() {
        let code = "let s = 0;\nfor (let i = 0; i < 10; i++) { s = s + i; }\nreturn s;";
        let e = emit(&func("fn-1", code), &trig("x")).unwrap();
        assert!(
            unsupported_note(&e).is_some_and(|n| n.contains("unsupported Function Node fn_1")),
            "{:?}",
            e.declarations
        );
        assert_eq!(e.loop_body, [] as [String; 0], "no evaluation");
        assert!(e.declarations.iter().any(|d| d == "bool function_fn_1_fired = false;"));
    }

    /// Text, a colour or a list as `input` is refused — once the code reads it.
    #[test]
    fn an_input_the_board_cannot_hold_is_refused_when_read() {
        assert!(refusal("return input + 1;", &CppExpr::text("mqtt_m_value")).contains("text"));
        assert!(refusal("return input;", &CppExpr::opaque("rgb_v")).contains("colour or a list"));
        assert!(translate("return 5;", Some(&CppExpr::text("mqtt_m_value")), "f").is_ok());
    }

    #[test]
    fn what_javascript_reads_differently_is_refused() {
        let x = CppExpr::number("x");
        for (code, why) in [
            ("return 010;", "leading 0"),
            ("return 0x10;", "0x"),
            ("return 1.2.3;", "malformed number"),
            ("return 1_000;", "malformed number"),
            ("return 1e;", "exponent"),
            ("return --input;", "increment / decrement"),
            ("return input ++ 1;", "increment / decrement"),
            ("return -input ** 2;", "needs parentheses"),
            ("const input = 1; return input;", "declared twice"),
            ("let a = 1; var a = 2; return a;", "declared twice"),
            ("var a = 1; let a = 2; return a;", "declared twice"),
            ("const Math = 1; return 1;", "cannot be a variable name"),
            ("return\ninput;", "returns nothing"),
            ("return;", "returns nothing"),
            ("return input > 1 ? 1 : false;", "one type"),
            ("return input === (input && 1 > 0);", "`===` compares"),
            ("return \"hello\";", "string literals"),
            ("return input + {{gain}};", "template slots"),
            ("return parseInt(input);", "unsupported call"),
            ("return undeclared + 1;", "unknown identifier"),
            ("const a = input;", "no `return`"),
            ("return input >> 1;", "unexpected"),
            ("return input & 1;", "unexpected"),
            ("x = 1; return x;", "unsupported statement"),
        ] {
            let reason = refusal(code, &x);
            assert!(reason.contains(why), "{code:?}: {reason}");
        }
    }

    #[test]
    fn what_javascript_accepts_is_translated() {
        let x = CppExpr::number("x");
        for code in [
            "return 1e3 + 1.5e-2 + .5 + 5.;",
            "return 0 + 0.5 + 0e1;",
            "var input = input * 2; return input;",
            "var a = 1; var a = a + 1; return a;",
            "const a = input\nconst b = a * 2\nreturn b",
            "const a = input *\n2;\nreturn a;",
            "return(input);",
            "return !input;",
            "return Math.max(input, 1, 2, 3);",
            "return toNumber(input, 5) + ensureRange(input, 0, 1) + isValid(input);",
            "return 1; const late = 2;",
        ] {
            let translated = translate(code, Some(&x), "f");
            assert!(translated.is_ok(), "{code:?}: {:?}", translated.err());
        }
    }

    /// A wired Function the board refuses reports why; an unwired one, which
    /// evaluates nowhere, does not.
    #[test]
    fn a_refusal_is_reported_only_when_wired() {
        let node = func("fn-1", "while (input) {}");
        let source = SourceExpr::level(CppExpr::number("x"));
        assert!(board_refusal(&node, Some(&source)).is_some_and(|r| r.contains("blocks")));
        assert_eq!(board_refusal(&node, None), None);
        assert_eq!(board_refusal(&func("fn-1", "return input;"), Some(&source)), None);
    }

    #[test]
    fn evaluates_only_when_its_source_fires() {
        let e = emit(&func("fn-1", "return input + 1;"), &trig("x")).unwrap();
        let body = e.loop_body.join("\n");
        assert!(body.contains("function_fn_1_fired = (function_fn_1_in_fired0);\nif (function_fn_1_fired) {"), "{body}");
    }

    #[test]
    fn no_driver_never_evaluates() {
        let e = emit(&func("fn-1", "return input + 1;"), &NodeInputs::default()).unwrap();
        assert_eq!(e.loop_body, [] as [String; 0]);
        assert_eq!(unsupported_note(&e), None);
    }

    #[test]
    fn emits_deterministically() {
        for code in ["return Math.round(input) % 2 && input;", "for (;;) {}\nreturn 1;"] {
            let n = func("fn-1", code);
            assert_eq!(emit(&n, &trig("x")).unwrap(), emit(&n, &trig("x")).unwrap());
        }
    }
}
