//! Function emitter — translates the user-authored JS of a Function Node into
//! C++ for the generated Sketch (Task #36), the codegen mirror of
//! `runtime/transformation/function.rs`.
//!
//! The live Function Node evaluates arbitrary JavaScript via `boa_engine`. That
//! cannot be reproduced on a bare board, so this emitter translates only a
//! deterministic **expression subset** that maps cleanly onto C++ `double`
//! arithmetic. Anything outside the subset is never guessed at: the Node emits
//! a clearly-marked `// unsupported` region and leaves its value at the
//! runtime's `0.0` initial state, so the Sketch never contains broken or
//! silently-wrong C++.
//!
//! ## Supported subset
//!
//! The Node's `code` must be a body of zero or more simple bindings followed by
//! a single `return`:
//!
//! ```js
//! const a = input * 2;
//! let b = a + 1;
//! return b > 10 ? a : b;
//! ```
//!
//! Within an expression the subset allows:
//! - the `input` identifier and any identifier bound earlier in the body,
//! - numeric literals (`5`, `2.5`), `true`/`false`,
//! - arithmetic `+ - * / %`, unary `-`/`!`,
//! - comparisons `> < >= <= == === != !==`,
//! - logical `&& ||`, a ternary `?:`, and parentheses,
//! - the unary `Math.*` helpers `floor`, `ceil`, `round`, `abs`, `sqrt` and the
//!   binary `Math.min`, `Math.max`, `Math.pow`,
//! - the runtime builtins `toNumber(x)` / `toBool(x)` (single-argument form).
//!
//! Everything else — loops, objects, strings, `{{var}}` template slots, member
//! access other than `Math.*`, and any other call — is unsupported.
//!
//! Like every other emitter this is a pure function of the [`FlowNode`]:
//! identical input always yields identical output.

use crate::codegen::emit::{NodeEmission, NodeToken};
use crate::runtime::types::FlowNode;

/// The C++ `double` variable holding this Function Node's latest result.
#[must_use]
pub fn value_var(node: &FlowNode) -> String {
    format!("function_{}_value", node.id_token())
}

/// Emit C++ for a Function Node. `driver` is the C++ numeric expression that
/// feeds the Node's `input`, or `None` when nothing is wired in (the runtime
/// leaves the value at its `0.0` initial state).
///
/// On success the Node's value variable is assigned the translated expression
/// in `loop()`. When the source falls outside the supported subset, a
/// clearly-marked `// unsupported` comment is emitted instead and no assignment
/// is produced — the value stays at `0.0`.
#[must_use]
pub fn emit(node: &FlowNode, driver: Option<&str>) -> NodeEmission {
    let var = value_var(node);
    let token = node.id_token();
    let mut e = NodeEmission {
        declarations: vec![format!("double {var} = 0.0;")],
        ..NodeEmission::default()
    };

    let code = node
        .data
        .get("code")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");

    // The `input` C++ expression downstream code reads. With nothing wired in,
    // the runtime evaluates the JS with `input = 0`, so we mirror that.
    let input_expr = driver.map_or_else(|| "0.0".to_string(), |d| format!("(double)({d})"));

    match translate(code, &input_expr) {
        Ok(cpp) => {
            e.loop_body.push(format!("{var} = (double)({cpp});"));
        }
        Err(reason) => {
            e.declarations.push(format!(
                "// unsupported Function Node {token}: {reason} — no C++ emitted; value stays 0.0"
            ));
        }
    }
    e
}

/// Translate the Function Node's JS body into a single C++ `double` expression,
/// or return a human-readable reason it falls outside the supported subset.
fn translate(code: &str, input_expr: &str) -> Result<String, String> {
    let mut env: Vec<(String, String)> = vec![("input".to_string(), input_expr.to_string())];
    let statements = split_statements(code)?;
    let mut return_expr: Option<String> = None;

    for stmt in statements {
        if let Some(return_body) = stmt.strip_prefix_word("return") {
            let expr = parse_expr(&return_body, &env)?;
            return_expr = Some(expr);
            break; // anything after `return` is unreachable / unsupported noise
        } else if let Some((name, value_src)) = parse_binding(&stmt) {
            let value = parse_expr(&value_src, &env)?;
            // Shadow or add the binding so later statements can read it.
            env.push((name, format!("({value})")));
        } else {
            return Err(format!("unsupported statement `{}`", stmt.trim()));
        }
    }

    return_expr.ok_or_else(|| "function has no `return` statement".to_string())
}

/// A single source statement with whitespace-tolerant prefix matching.
struct Statement(String);

impl Statement {
    /// If the statement starts with `word` as a whole keyword, return the rest.
    fn strip_prefix_word(&self, word: &str) -> Option<String> {
        let trimmed = self.0.trim();
        let rest = trimmed.strip_prefix(word)?;
        // The keyword must be followed by whitespace, `(`, or end — not be a
        // prefix of a longer identifier (`returnValue`).
        match rest.chars().next() {
            None => Some(String::new()),
            Some(c) if c.is_whitespace() || c == '(' => Some(rest.to_string()),
            _ => None,
        }
    }

    fn trim(&self) -> &str {
        self.0.trim()
    }
}

/// Split the body into statements on top-level `;`, stripping `//` line
/// comments and rejecting block comments / braces (a quick subset gate).
fn split_statements(code: &str) -> Result<Vec<Statement>, String> {
    let mut cleaned = String::new();
    for line in code.lines() {
        let without_comment = match line.find("//") {
            Some(i) => &line[..i],
            None => line,
        };
        cleaned.push_str(without_comment);
        cleaned.push('\n');
    }
    if cleaned.contains("/*") {
        return Err("block comments are not supported".to_string());
    }
    if cleaned.contains('{') || cleaned.contains('}') {
        return Err("blocks, objects, and functions are not supported".to_string());
    }
    Ok(cleaned
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| Statement(s.to_string()))
        .collect())
}

/// Parse a `const`/`let`/`var` binding into (name, value-source). Returns
/// `None` if the statement is not a binding.
fn parse_binding(stmt: &Statement) -> Option<(String, String)> {
    let trimmed = stmt.trim();
    let rest = ["const ", "let ", "var "]
        .iter()
        .find_map(|kw| trimmed.strip_prefix(kw))?;
    let (name, value) = rest.split_once('=')?;
    let name = name.trim();
    if name.is_empty() || !is_identifier(name) {
        return None;
    }
    Some((name.to_string(), value.trim().to_string()))
}

fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

// --- Expression parser (recursive-descent over a token stream) ---

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Num(String),
    Ident(String),
    Op(String),
    LParen,
    RParen,
    Comma,
    Question,
    Colon,
}

fn tokenize(src: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = src.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c.is_ascii_digit()
            || (c == '.' && i + 1 < chars.len() && chars[i + 1].is_ascii_digit())
        {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            tokens.push(Token::Num(chars[start..i].iter().collect()));
        } else if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '.')
            {
                i += 1;
            }
            tokens.push(Token::Ident(chars[start..i].iter().collect()));
        } else {
            match c {
                '(' => tokens.push(Token::LParen),
                ')' => tokens.push(Token::RParen),
                ',' => tokens.push(Token::Comma),
                '?' => tokens.push(Token::Question),
                ':' => tokens.push(Token::Colon),
                '+' | '-' | '*' | '/' | '%' => tokens.push(Token::Op(c.to_string())),
                '>' | '<' | '=' | '!' | '&' | '|' => {
                    let mut op = c.to_string();
                    while i + 1 < chars.len() && matches!(chars[i + 1], '=' | '&' | '|') {
                        // Consume multi-char operators (>=, ===, !==, &&, ||).
                        op.push(chars[i + 1]);
                        i += 1;
                    }
                    tokens.push(Token::Op(op));
                }
                _ => return Err(format!("unsupported character `{c}` in expression")),
            }
            i += 1;
        }
    }
    Ok(tokens)
}

struct Parser<'a> {
    tokens: Vec<Token>,
    pos: usize,
    env: &'a [(String, String)],
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

    // ternary := logic_or ('?' ternary ':' ternary)?
    fn parse_ternary(&mut self) -> Result<String, String> {
        let cond = self.parse_binary(0)?;
        if self.peek() == Some(&Token::Question) {
            self.pos += 1;
            let then_branch = self.parse_ternary()?;
            self.expect(&Token::Colon)?;
            let else_branch = self.parse_ternary()?;
            return Ok(format!("(({cond}) ? ({then_branch}) : ({else_branch}))"));
        }
        Ok(cond)
    }

    /// Precedence-climbing for binary operators.
    fn parse_binary(&mut self, min_prec: u8) -> Result<String, String> {
        let mut lhs = self.parse_unary()?;
        while let Some(Token::Op(op)) = self.peek() {
            let Some(prec) = binary_prec(op) else { break };
            if prec < min_prec {
                break;
            }
            let op = op.clone();
            self.pos += 1;
            let rhs = self.parse_binary(prec + 1)?;
            lhs = format!("({lhs} {} {rhs})", cpp_binary_op(&op));
        }
        Ok(lhs)
    }

    fn parse_unary(&mut self) -> Result<String, String> {
        if let Some(Token::Op(op)) = self.peek() {
            if op == "-" || op == "!" {
                let op = op.clone();
                self.pos += 1;
                let operand = self.parse_unary()?;
                return Ok(format!("({op}({operand}))"));
            }
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<String, String> {
        match self.advance() {
            Some(Token::Num(n)) => {
                // Ensure a C++ double literal.
                if n.contains('.') {
                    Ok(n)
                } else {
                    Ok(format!("{n}.0"))
                }
            }
            Some(Token::LParen) => {
                let inner = self.parse_ternary()?;
                self.expect(&Token::RParen)?;
                Ok(format!("({inner})"))
            }
            Some(Token::Ident(name)) => self.parse_ident(&name),
            other => Err(format!("unexpected token {other:?} in expression")),
        }
    }

    fn parse_ident(&mut self, name: &str) -> Result<String, String> {
        // A call?
        if self.peek() == Some(&Token::LParen) {
            return self.parse_call(name);
        }
        match name {
            "true" => Ok("true".to_string()),
            "false" => Ok("false".to_string()),
            _ => self
                .env
                .iter()
                .rev()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
                .ok_or_else(|| format!("unknown identifier `{name}`")),
        }
    }

    fn parse_call(&mut self, name: &str) -> Result<String, String> {
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
        cpp_call(name, &args)
    }
}

/// JS binary operator → C++ operator (same spelling, but `===`/`!==` collapse).
fn cpp_binary_op(op: &str) -> &str {
    match op {
        "===" | "==" => "==",
        "!==" | "!=" => "!=",
        other => other,
    }
}

/// Binary operator precedence (higher binds tighter). `None` → not a supported
/// binary operator.
fn binary_prec(op: &str) -> Option<u8> {
    Some(match op {
        "||" => 1,
        "&&" => 2,
        "==" | "===" | "!=" | "!==" => 3,
        ">" | "<" | ">=" | "<=" => 4,
        "+" | "-" => 5,
        "*" | "/" | "%" => 6,
        _ => return None,
    })
}

/// Translate a supported call (`Math.*`, `toNumber`, `toBool`) into C++.
fn cpp_call(name: &str, args: &[String]) -> Result<String, String> {
    let unary = |f: &str| -> Result<String, String> {
        match args {
            [a] => Ok(format!("{f}((double)({a}))")),
            _ => Err(format!("`{name}` expects one argument")),
        }
    };
    let binary = |f: &str| -> Result<String, String> {
        match args {
            [a, b] => Ok(format!("{f}((double)({a}), (double)({b}))")),
            _ => Err(format!("`{name}` expects two arguments")),
        }
    };
    match name {
        "Math.floor" => unary("floor"),
        "Math.ceil" => unary("ceil"),
        "Math.round" => unary("round"),
        "Math.abs" => unary("fabs"),
        "Math.sqrt" => unary("sqrt"),
        "Math.min" => binary("min"),
        "Math.max" => binary("max"),
        "Math.pow" => binary("pow"),
        // `toNumber(x)` → numeric coercion; `toBool(x)` → truthiness.
        "toNumber" => unary(""),
        "toBool" => match args {
            [a] => Ok(format!("((bool)((double)({a})))")),
            _ => Err("`toBool` expects one argument".to_string()),
        },
        _ => Err(format!("unsupported call `{name}`")),
    }
}

/// Parse a full expression string against the binding environment.
fn parse_expr(src: &str, env: &[(String, String)]) -> Result<String, String> {
    let trimmed = src.trim();
    if trimmed.is_empty() {
        return Err("empty expression".to_string());
    }
    if trimmed.contains("{{") {
        return Err("`{{var}}` template slots are not supported".to_string());
    }
    if trimmed.contains('"') || trimmed.contains('\'') || trimmed.contains('`') {
        return Err("string literals are not supported".to_string());
    }
    let tokens = tokenize(trimmed)?;
    let mut parser = Parser {
        tokens,
        pos: 0,
        env,
    };
    let result = parser.parse_ternary()?;
    if parser.pos != parser.tokens.len() {
        return Err("trailing tokens in expression".to_string());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::Position;
    use serde_json::json;

    fn func(id: &str, code: &str) -> FlowNode {
        FlowNode {
            id: id.to_string(),
            node_type: Some("Function".to_string()),
            data: json!({ "code": code }),
            position: Position { x: 0.0, y: 0.0 },
        }
    }

    fn loop_line(e: &NodeEmission) -> String {
        e.loop_body.join("\n")
    }

    fn is_unsupported(e: &NodeEmission) -> bool {
        e.declarations.iter().any(|d| d.contains("unsupported"))
    }

    #[test]
    fn declares_output_variable() {
        let e = emit(&func("fn-1", "return input;"), None);
        assert!(e
            .declarations
            .iter()
            .any(|d| d == "double function_fn_1_value = 0.0;"));
    }

    #[test]
    fn value_var_uses_sanitized_id() {
        assert_eq!(
            value_var(&func("fn-1", "return input;")),
            "function_fn_1_value"
        );
    }

    #[test]
    fn return_input_reads_driver() {
        let e = emit(&func("fn-1", "return input;"), Some("sensor_s_value"));
        let body = loop_line(&e);
        assert!(body.contains("function_fn_1_value"));
        assert!(
            body.contains("sensor_s_value"),
            "must read the driver, got: {body}"
        );
        assert!(!is_unsupported(&e));
    }

    #[test]
    fn arithmetic_is_translated() {
        let e = emit(&func("fn-1", "return input * 2 + 1;"), Some("x"));
        let body = loop_line(&e);
        assert!(body.contains('*') && body.contains('+'), "got: {body}");
        assert!(!is_unsupported(&e));
    }

    #[test]
    fn bindings_chain_into_return() {
        let code = "const a = input * 2;\nconst b = a + 3;\nreturn b;";
        let e = emit(&func("fn-1", code), Some("x"));
        let body = loop_line(&e);
        // `b` resolves to `a + 3` which resolves to `input * 2`.
        assert!(body.contains('*'), "binding a inlined: {body}");
        assert!(body.contains('+'), "binding b inlined: {body}");
        assert!(!is_unsupported(&e));
    }

    #[test]
    fn default_code_passthrough_is_supported() {
        // The Node's default body: assigns input and returns it.
        let code = "const value = input;\nreturn value;";
        let e = emit(&func("fn-1", code), Some("driver"));
        assert!(loop_line(&e).contains("driver"));
        assert!(!is_unsupported(&e));
    }

    #[test]
    fn comparison_and_ternary_are_translated() {
        let e = emit(&func("fn-1", "return input > 10 ? 1 : 0;"), Some("x"));
        let body = loop_line(&e);
        assert!(
            body.contains('>') && body.contains('?') && body.contains(':'),
            "got: {body}"
        );
        assert!(!is_unsupported(&e));
    }

    #[test]
    fn logical_operators_are_translated() {
        let e = emit(&func("fn-1", "return input > 0 && input < 100;"), Some("x"));
        assert!(loop_line(&e).contains("&&"));
    }

    #[test]
    fn strict_equality_collapses_to_cpp_equality() {
        let e = emit(&func("fn-1", "return input === 5 ? 1 : 0;"), Some("x"));
        let body = loop_line(&e);
        assert!(body.contains("=="), "got: {body}");
        assert!(!body.contains("==="), "=== must collapse to ==, got: {body}");
    }

    #[test]
    fn math_helpers_are_translated() {
        let e = emit(&func("fn-1", "return Math.max(input, 0);"), Some("x"));
        assert!(loop_line(&e).contains("max("), "Math.max → max");
    }

    #[test]
    fn unary_negation_is_translated() {
        let e = emit(&func("fn-1", "return -input;"), Some("x"));
        assert!(loop_line(&e).contains('-'));
    }

    // --- Scenario: Unsupported Function logic is clearly marked ---

    #[test]
    fn loop_construct_is_marked_unsupported() {
        let code = "let s = 0;\nfor (let i = 0; i < 10; i++) { s = s + i; }\nreturn s;";
        let e = emit(&func("fn-1", code), Some("x"));
        assert!(
            e.declarations
                .iter()
                .any(|d| d.contains("unsupported Function Node fn_1")),
            "loops must be marked unsupported, got: {:?}",
            e.declarations
        );
        // No broken/guessed C++ is emitted for it.
        assert!(e.loop_body.is_empty(), "no assignment for unsupported code");
    }

    #[test]
    fn string_literal_is_marked_unsupported() {
        let e = emit(&func("fn-1", "return \"hello\";"), Some("x"));
        assert!(is_unsupported(&e));
        assert!(e.loop_body.is_empty());
    }

    #[test]
    fn template_slot_is_marked_unsupported() {
        let e = emit(&func("fn-1", "return input + {{gain}};"), Some("x"));
        assert!(is_unsupported(&e));
        assert!(e.loop_body.is_empty());
    }

    #[test]
    fn unknown_call_is_marked_unsupported() {
        let e = emit(&func("fn-1", "return parseInt(input);"), Some("x"));
        assert!(is_unsupported(&e));
        assert!(e.loop_body.is_empty());
    }

    #[test]
    fn missing_return_is_marked_unsupported() {
        let e = emit(&func("fn-1", "const a = input;"), Some("x"));
        assert!(is_unsupported(&e));
        assert!(e.loop_body.is_empty());
    }

    #[test]
    fn unknown_identifier_is_marked_unsupported() {
        let e = emit(&func("fn-1", "return undeclared + 1;"), Some("x"));
        assert!(is_unsupported(&e));
        assert!(e.loop_body.is_empty());
    }

    #[test]
    fn no_driver_uses_zero_input() {
        // With nothing wired in the runtime evaluates with input = 0.
        let e = emit(&func("fn-1", "return input + 1;"), None);
        let body = loop_line(&e);
        assert!(body.contains("0.0"), "input defaults to 0.0, got: {body}");
        assert!(!is_unsupported(&e));
    }

    #[test]
    fn emits_deterministically() {
        let n = func("fn-1", "return input * 2 + 1;");
        assert_eq!(emit(&n, Some("x")), emit(&n, Some("x")));
    }

    #[test]
    fn unsupported_is_deterministic() {
        let n = func("fn-1", "for (;;) {}\nreturn 1;");
        assert_eq!(emit(&n, Some("x")), emit(&n, Some("x")));
    }
}
