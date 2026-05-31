//! Function Component — Transformation. Runs user JS via `boa_engine` inline.
//!
//! Gated behind the `js` feature (a full JS VM); excluded from the browser wasm
//! build until its size is vetted. Handles: `trigger` (input → JS `input`),
//! `{{var}}` template inputs, `value` (output).

use crate::runtime::{
    Component, ComponentBase, ComponentBuilder, ComponentValue, RuntimeContext, RuntimeError,
};
use boa_engine::{Context, JsValue, Source};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionConfig {
    /// User-authored JS body. Receives `input`; must return a value. Wrapped as
    /// `(function(input) { <code> })(input)`.
    #[serde(default = "default_code")]
    pub code: String,
}

fn default_code() -> String {
    "// Transform the input value and return the result\n// Use {{varName}} to reference connected handle values\nconst value = input;\nreturn value;".to_string()
}

impl Default for FunctionConfig {
    fn default() -> Self {
        Self { code: default_code() }
    }
}

pub struct Function {
    base: ComponentBase,
    config: FunctionConfig,
    variables: HashMap<String, ComponentValue>,
    last_good_value: ComponentValue,
}

impl Function {
    #[must_use]
    pub fn new(id: String, config: FunctionConfig) -> Self {
        Self {
            base: ComponentBase::new(id, ComponentValue::Number(0.0)),
            config,
            variables: HashMap::new(),
            last_good_value: ComponentValue::Number(0.0),
        }
    }

    fn make_context() -> Context {
        let mut ctx = Context::default();
        ctx.runtime_limits_mut().set_loop_iteration_limit(10_000);
        Self::inject_builtins(&mut ctx);
        ctx
    }

    fn inject_builtins(ctx: &mut Context) {
        let builtins = r#"
function toNumber(value, fallback) {
    if (fallback === undefined) fallback = 0;
    if (typeof value === "number") return isNaN(value) ? fallback : value;
    if (typeof value === "boolean") return value ? 1 : 0;
    var n = Number(value);
    return isNaN(n) ? fallback : n;
}

function toString(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

function toBool(value) {
    if (typeof value === "string") {
        var lower = value.toLowerCase();
        if (lower === "false" || lower === "0" || lower === "") return false;
        return true;
    }
    return !!value;
}

function ensureRange(value, min, max, fallback) {
    if (fallback === undefined) fallback = min;
    var n = toNumber(value, NaN);
    if (isNaN(n) || n < min || n > max) return fallback;
    return n;
}

function oneOf(value, allowed, fallback) {
    for (var i = 0; i < allowed.length; i++) {
        if (value === allowed[i]) return value;
    }
    return fallback;
}

function isValid(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === "number" && isNaN(value)) return false;
    return true;
}
"#;
        if let Err(e) = ctx.eval(Source::from_bytes(builtins.as_bytes())) {
            log::error!("[Function] Failed to inject built-in utilities: {e}");
        }
    }

    fn build_code(&self) -> String {
        let mut code = self.config.code.clone();
        for (key, value) in &self.variables {
            code = code.replace(&format!("{{{{{key}}}}}"), &value_to_js_literal(value));
        }
        code
    }
}

/// Serialize a `ComponentValue` as a JS literal for template substitution.
fn value_to_js_literal(value: &ComponentValue) -> String {
    match value {
        ComponentValue::Number(n) => n.to_string(),
        ComponentValue::Bool(b) => b.to_string(),
        ComponentValue::String(s) => {
            let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
            format!("\"{escaped}\"")
        }
        ComponentValue::Array(arr) => {
            let items: Vec<String> = arr.iter().map(value_to_js_literal).collect();
            format!("[{}]", items.join(","))
        }
        ComponentValue::Rgba { r, g, b, a } => {
            format!("{{\"r\":{r},\"g\":{g},\"b\":{b},\"a\":{a}}}")
        }
    }
}

/// Convert a boa `JsValue` to a `ComponentValue`.
fn js_value_to_component_value(value: &JsValue) -> ComponentValue {
    match value {
        JsValue::Boolean(b) => ComponentValue::Bool(*b),
        JsValue::Integer(n) => ComponentValue::Number(f64::from(*n)),
        JsValue::Rational(n) => ComponentValue::Number(*n),
        JsValue::String(s) => {
            let s = s.to_std_string_lossy();
            if s.starts_with('[') {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&s) {
                    if let Some(arr) = parsed.as_array() {
                        let items = arr.iter().map(json_to_component_value).collect();
                        return ComponentValue::Array(items);
                    }
                }
            }
            ComponentValue::String(s)
        }
        JsValue::Null | JsValue::Undefined => ComponentValue::Number(0.0),
        _ => ComponentValue::Number(0.0),
    }
}

/// Convert a `serde_json::Value` to a `ComponentValue`.
fn json_to_component_value(value: &serde_json::Value) -> ComponentValue {
    match value {
        serde_json::Value::Bool(b) => ComponentValue::Bool(*b),
        serde_json::Value::Number(n) => ComponentValue::Number(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => ComponentValue::String(s.clone()),
        serde_json::Value::Array(arr) => {
            ComponentValue::Array(arr.iter().map(json_to_component_value).collect())
        }
        serde_json::Value::Object(_) => ComponentValue::String(value.to_string()),
        serde_json::Value::Null => ComponentValue::Number(0.0),
    }
}

impl Component for Function {
    fn ports() -> &'static [&'static str] {
        &["trigger"]
    }

    fn base(&self) -> &ComponentBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ComponentBase {
        &mut self.base
    }
    fn component_type(&self) -> &'static str {
        "Function"
    }

    fn dispatch(
        &mut self,
        method: &str,
        args: ComponentValue,
        _ctx: &mut RuntimeContext,
    ) -> Result<(), RuntimeError> {
        match method {
            "trigger" => {
                let code = self.build_code();
                let input_literal = value_to_js_literal(&args);
                let wrapped = format!(
                    "var __res__ = (function(input) {{ {code} }})({input_literal});\
                     (typeof __res__ === 'object' && __res__ !== null) \
                       ? JSON.stringify(__res__) \
                       : __res__"
                );

                let mut context = Self::make_context();
                match context.eval(Source::from_bytes(wrapped.as_bytes())) {
                    Ok(js_result) => {
                        let output = js_value_to_component_value(&js_result);
                        self.last_good_value = output.clone();
                        self.base.set_value(output);
                    }
                    Err(e) => {
                        log::warn!("[Function] {} JS error: {e}", self.base.id);
                        self.base.set_value(self.last_good_value.clone());
                    }
                }
            }
            var_name => {
                self.variables.insert(var_name.to_string(), args);
            }
        }
        Ok(())
    }
}

impl ComponentBuilder for Function {
    type Config = FunctionConfig;
    fn build(id: String, config: Self::Config) -> Result<Self, RuntimeError> {
        Ok(Self::new(id, config))
    }
}
