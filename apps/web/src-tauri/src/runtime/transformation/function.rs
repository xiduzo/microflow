//! Function Component - Transformation
//!
//! Executes user-authored JavaScript to transform values inline.
//! Runs inside the Rust process via `boa_engine` — no Tauri IPC round-trips.
//!
//! # Handles
//!
//! - `trigger` (input, command): incoming value passed as `input` to the JS function
//! - `{{var}}` (input, value): dynamic template variables, substituted before eval
//! - `value` (output, value): emits the return value of the JS function

use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};
use boa_engine::{Context, JsValue, Source};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionConfig {
    /// User-authored JS function body. Receives `input` variable, must return a value.
    /// Wrapped as: `(function(input) { <code> })(input)`
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
    /// Stored values for `{{var}}` template slots
    variables: HashMap<String, ComponentValue>,
    /// Last successfully emitted value (used as fallback on JS error)
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
        // Limit loop iterations to prevent runaway infinite loops
        ctx.runtime_limits_mut().set_loop_iteration_limit(10_000);
        // Inject built-in utility functions
        Self::inject_builtins(&mut ctx);
        ctx
    }

    /// Inject the built-in utility functions described in the Function node docs.
    /// These are always available inside user code — no imports needed.
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

    /// Substitute `{{var}}` placeholders with their stored JS literal values.
    fn build_code(&self) -> String {
        let mut code = self.config.code.clone();
        for (key, value) in &self.variables {
            code = code.replace(&format!("{{{{{key}}}}}"), &value_to_js_literal(value));
        }
        code
    }

    fn emit_value(&self, value: ComponentValue) {
        if let Some(sender) = &self.base.event_sender {
            let _ = sender.send(ComponentEvent {
                source: Arc::clone(&self.base.id),
                source_handle: Arc::from("value"),
                value,
                edge_id: None,
                sequence: 0,
            });
        }
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
///
/// Objects and arrays are already serialized to JSON strings by the JS wrapper,
/// so we only need to handle primitives here. If the result is a JSON string
/// representing an array, we parse it into `ComponentValue::Array`.
fn js_value_to_component_value(value: &JsValue, _original_input: &ComponentValue) -> ComponentValue {
    match value {
        JsValue::Boolean(b) => ComponentValue::Bool(*b),
        JsValue::Integer(n) => ComponentValue::Number(f64::from(*n)),
        JsValue::Rational(n) => ComponentValue::Number(*n),
        JsValue::String(s) => {
            let s = s.to_std_string_lossy();
            // If the JS wrapper JSON.stringify'd an object/array, the result
            // arrives here as a String. Try to detect and convert arrays.
            if s.starts_with('[') {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&s) {
                    if let Some(arr) = parsed.as_array() {
                        let items = arr.iter().map(json_to_component_value).collect();
                        return ComponentValue::Array(items);
                    }
                }
            }
            // Objects stay as their JSON string representation
            ComponentValue::String(s)
        }
        JsValue::Null | JsValue::Undefined => ComponentValue::Number(0.0),
        // Shouldn't happen since the wrapper stringifies objects, but just in case
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
    fn id(&self) -> &str { &self.base.id }
    fn value(&self) -> ComponentValue { self.base.value.clone() }
    fn set_value(&mut self, value: ComponentValue) { self.base.value = value; }
    fn component_type(&self) -> &'static str { "Function" }

    fn initialize(&mut self, _board: Arc<BoardHandle>) -> Result<(), crate::error::RuntimeError> {
        Ok(())
    }

    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), crate::error::RuntimeError> {
        match method {
            "trigger" => {
                let code = self.build_code();
                let input_literal = value_to_js_literal(&args);
                // Wrap user code so the result is captured as __res__, then
                // return a two-element array: [typeof __res__, JSON.stringify(__res__) ?? __res__]
                // This lets us distinguish objects/arrays from primitives on the Rust side.
                let wrapped = format!(
                    "var __res__ = (function(input) {{ {code} }})({input_literal});\
                     (typeof __res__ === 'object' && __res__ !== null) \
                       ? JSON.stringify(__res__) \
                       : __res__"
                );

                let mut context = Self::make_context();
                match context.eval(Source::from_bytes(wrapped.as_bytes())) {
                    Ok(js_result) => {
                        let output = js_value_to_component_value(&js_result, &args);
                        self.last_good_value = output.clone();
                        self.base.set_value(output.clone());
                        self.emit_value(output);
                    }
                    Err(e) => {
                        log::warn!("[Function] {} JS error: {e}", self.base.id);
                        // Emit last known good value so the flow keeps running
                        self.emit_value(self.last_good_value.clone());
                    }
                }
            }
            var_name => {
                // Store dynamic template variable (same catch-all as LLM node)
                self.variables.insert(var_name.to_string(), args);
            }
        }
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
