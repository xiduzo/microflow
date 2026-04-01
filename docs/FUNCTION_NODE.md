# Function Node — Implementation Plan

> **Created:** April 2026
> **Status:** Draft
> **Category:** New Node (Transformation)

A "Function" node that lets users write custom JavaScript to transform values inline within a flow. Executes user-authored JS inside the Rust runtime via an embedded JS engine — no Tauri bridge round-trips.

---

## Approach: Embedded JS Engine (boa_engine)

Use [boa_engine](https://github.com/boa-dev/boa) — a pure-Rust ECMAScript engine. This keeps execution inside the `Component` trait lifecycle, identical to Calculate or RangeMap. No async bridge, no webview eval, no latency penalty.

**Why boa over alternatives:**
- Pure Rust, no C/C++ bindings (unlike `rquickjs`/`v8`)
- ~2MB binary size impact
- Sandboxed by default — no filesystem, network, or OS access
- ES2024 support is sufficient for value transformations
- Compiles cleanly with Tauri's toolchain

**Why not eval in the webview:**
- Round-trip through Tauri IPC for every value event adds latency
- Breaks the synchronous `call_method` → `emit` execution model
- Complicates event sequencing (stale events from async eval)
- Would need special-casing in the executor

---

## Rust Component

### New File: `apps/web/src-tauri/src/runtime/transformation/function.rs`

```rust
use boa_engine::{Context, Source, JsValue, JsError};
use crate::runtime::base::{
    BoardHandle, Component, ComponentBase, ComponentEvent, ComponentValue,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FunctionConfig {
    /// User-authored JS function body. Receives `input` variable,
    /// must return a value. Wrapped as: `(function(input) { <code> })(input)`
    #[serde(default = "default_code")]
    pub code: String,
}

fn default_code() -> String {
    "return input;".to_string()
}

pub struct Function {
    base: ComponentBase,
    config: FunctionConfig,
    context: Context,
}
```

**Execution model in `call_method`:**

Uses the same trigger + named variables pattern as the LLM node:

1. Named variable handles (`threshold`, `offset`, etc.) → store `ComponentValue` in `self.variables` HashMap
2. `trigger` handle → kicks off evaluation:
   a. Inject all stored variables into the boa JS context as globals
   b. Inject `input` as the trigger's `ComponentValue` → `JsValue`
   c. Eval the user's function body
   d. Convert returned `JsValue` → `ComponentValue`
   e. `self.base.set_value(result)` + `self.base.emit("value")`

**Type conversion table:**

| ComponentValue | → JS | JS → | ComponentValue |
|---|---|---|---|
| `Number(f64)` | `number` | `number` | `Number(f64)` |
| `Bool(bool)` | `boolean` | `boolean` | `Bool(bool)` |
| `String(String)` | `string` | `string` | `String(String)` |
| `Array(Vec<..>)` | `Array` | `Array` | `Array(Vec<..>)` |
| `Rgba{..}` | `{r,g,b,a}` | `{r,g,b,a}` | `Rgba{..}` |

**Error handling:**
- JS syntax errors → log warning, emit last known good value
- JS runtime errors → log warning, emit last known good value
- Infinite loops → boa's instruction budget limit (set a max op count)

### Component trait implementation

```rust
impl Component for Function {
    fn component_type(&self) -> &'static str { "Function" }
    fn requires_hardware(&self) -> bool { false }
    fn aggregates_inputs(&self) -> bool { false }
    // trigger + catch-all pattern identical to LLM node
}
```

### Registration

In `registry.rs`, add alongside other transformations:

```rust
self.register_software("Function", |id, data| {
    let config: FunctionConfig = serde_json::from_value(data.clone()).unwrap_or_default();
    Box::new(Function::new(id, config))
});
```

### Module export

In `transformation/mod.rs`:

```rust
mod function;
pub use function::{Function, FunctionConfig};
```

### Cargo dependency

In `apps/web/src-tauri/Cargo.toml`:

```toml
boa_engine = "0.20"
```

---

## React Node

### Schema: `apps/web/src/components/flow/nodes/function/function.schema.ts`

```typescript
import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.unknown();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Function").default("Function"),
  code: z.string().default("return input;"),
});

export type Data = z.infer<typeof dataSchema>;
```

### Component: `apps/web/src/components/flow/nodes/function/function.tsx`

- Wrap in `NodeContainer`
- Display a code icon (e.g. `BracesIcon` from lucide)
- Show a truncated preview of the code string
- `trigger` handle (left, command type) — kicks off evaluation
- `value` handle (right, value type) — emits the return value
- `DynamicHandles` component (bottom) — parsed from `var` declarations, identical pattern to LLM's `DynamicHandles`

**Dynamic handle parsing** (identical to LLM's `{{var}}` regex):

```typescript
const dynamicVars = useMemo(() => {
  const matches = data.code.match(/{{(.*?)}}/g) ?? [];
  return [
    ...new Set(
      matches.map((match) => match.replace("{{", "").replace("}}", "")),
    ),
  ].filter(Boolean);
}, [data.code]);
```

**Settings panel:** A textarea or lightweight code editor (CodeMirror/Monaco is overkill for single-function snippets — a `<textarea>` with monospace font and basic syntax highlighting via `highlight.js` or `shiki` is enough to start). The code updates node data via the same Yjs path as other node settings.

### Type registration

In `_base/_base.types.ts`, add `"Function"` to `COMPONENT_TYPES`.

In `_TYPES.ts` (or wherever `NODE_TYPES` maps component names to React components), add:

```typescript
Function: Function,
```

---

## Sandboxing & Safety

This is the most important design consideration. User code runs in the Rust process.

### boa_engine built-in limits
- **No I/O**: boa has no `fs`, `net`, `fetch`, or `process` globals — it's a pure language runtime
- **Instruction budget**: Use `context.set_instruction_limit(max_ops)` to prevent infinite loops. Start with 10,000 ops — more than enough for any reasonable transformation, will halt runaway `while(true)` loops
- **No `eval()`**: Can be disabled in the context if desired
- **Memory**: boa runs in the Rust process heap — no separate memory limit, but the instruction budget prevents unbounded allocation in practice

### Additional hardening (optional, future)
- Timeout via `tokio::time::timeout` if moving to async eval
- Allowlist of global functions (e.g. expose `Math`, `JSON.parse`, `JSON.stringify` only)
- Log user code errors to the frontend via a dedicated event channel

---

## UX Considerations

### Default code
New Function nodes start with `return input;` (passthrough). This is immediately useful — users can wire it in and see values flow through before writing custom logic.

### Error feedback
When user code throws, the node should:
1. Continue emitting the last good value (don't break the flow)
2. Show an error indicator on the node (red border or icon)
3. Display the error message in the settings panel

This requires a small addition: emit a separate "error" event or store error state in the node's value alongside the result. Simplest approach: add an optional `error` field to the node value that the React component checks.

### Code examples in placeholder/docs
Provide a few examples users can reference:
```javascript
// Simple passthrough (default)
return input;

// Clamp to range using external bounds
var min = {{min}};
var max = {{max}};
return Math.max(min, Math.min(max, input));

// Toggle boolean
return !input;

// Scale sensor reading to percentage
return (input / {{maxReading}}) * 100;

// Format as string
return "Value: " + input.toFixed(2);

// Threshold check with offset (inline style)
return (input - {{offset}}) > {{threshold}};

// Local vars for internal logic are fine — only {{}} creates handles
var clamped = Math.min(input, 1023);
var scaled = (clamped / {{range}}) * 100;
return Math.round(scaled);
```

---

## Implementation Order

### Step 1: Rust component (~2-3 hours)
1. Add `boa_engine` to Cargo.toml
2. Create `transformation/function.rs` with `FunctionConfig` + `Function` struct
3. Implement `ComponentValue` ↔ `JsValue` conversion helpers
4. Implement `Component` trait with trigger + catch-all variable pattern (same as LLM)
5. Add instruction limit for sandboxing
6. Export from `transformation/mod.rs`
7. Register `"Function"` in `registry.rs`

### Step 2: React node (~2-3 hours)
1. Add `"Function"` to `COMPONENT_TYPES`
2. Create `function.schema.ts`
3. Create `function.tsx` with:
   - `trigger` handle (left, command)
   - `value` handle (right, value)
   - `DynamicHandles` component parsing `var` declarations (reuse LLM pattern)
4. Add to `NODE_TYPES` map
5. Add code textarea in settings panel (via `useNodeControls` or custom panel)

### Step 3: Error feedback (~1 hour)
1. Surface JS errors as a node state indicator (red border/icon)
2. Show error message in settings panel

### Step 4: Polish (~1-2 hours)
1. Add syntax highlighting to the code editor
2. Add placeholder examples
3. Add to fumadocs documentation
4. Test with real flows (sensor → function → LED patterns)

---

## Multi-Input: `{{var}}` Template Syntax (same as LLM node)

Uses the exact same `{{var}}` template pattern as the LLM node's prompt. This is unambiguous — `{{}}` is never valid JS, so there's no confusion between input variables and local variables used for internal logic.

### How it works

1. User writes code using `{{name}}` placeholders for external inputs:

```javascript
// {{threshold}} and {{offset}} become input handles
// Users can assign to local vars for readability
var threshold = {{threshold}};
var offset = {{offset}};
return (input - offset) > threshold;

// Or use inline — both work fine
return (input - {{offset}}) > {{threshold}};
```

2. The React component parses `{{var}}` from the code string — identical regex to the LLM node's `DynamicHandles`:

```typescript
const dynamicVars = useMemo(() => {
  const matches = data.code.match(/{{(.*?)}}/g) ?? [];
  return [
    ...new Set(
      matches.map((match) => match.replace("{{", "").replace("}}", "")),
    ),
  ].filter(Boolean);
}, [data.code]);
```

3. Each detected `{{var}}` gets a target handle on the bottom of the node (reuse LLM's `DynamicHandles` component directly).

4. On the Rust side, `call_method` stores variable values when they arrive on named handles. When `trigger` fires, `build_code()` does string substitution — replacing `{{name}}` with the stored value serialized as a JS literal — then evals the resulting code.

### Type-aware substitution

Unlike the LLM node (which substitutes everything as strings for a text prompt), the Function node must serialize `ComponentValue` as JS literals to preserve types:

| ComponentValue | Substituted as | Example |
|---|---|---|
| `Number(42.0)` | `42` | `{{threshold}}` → `42` |
| `Bool(true)` | `true` | `{{enabled}}` → `true` |
| `String("hello")` | `"hello"` | `{{label}}` → `"hello"` |
| `Array([1,2])` | `[1,2]` | `{{values}}` → `[1,2]` |
| `Rgba{r,g,b,a}` | `{"r":r,"g":g,"b":b,"a":a}` | `{{color}}` → `{"r":255,...}` |

```rust
fn value_to_js_literal(value: &ComponentValue) -> String {
    match value {
        ComponentValue::Number(n) => n.to_string(),
        ComponentValue::Bool(b) => b.to_string(),
        ComponentValue::String(s) => format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")),
        ComponentValue::Array(arr) => {
            let items: Vec<String> = arr.iter().map(value_to_js_literal).collect();
            format!("[{}]", items.join(","))
        }
        ComponentValue::Rgba { r, g, b, a } => {
            format!("{{\"r\":{r},\"g\":{g},\"b\":{b},\"a\":{a}}}")
        }
    }
}

fn build_code(&self) -> String {
    let mut code = self.config.code.clone();
    for (key, value) in &self.variables {
        code = code.replace(&format!("{{{{{key}}}}}"), &value_to_js_literal(value));
    }
    code
}
```

### Rust component structure

```rust
pub struct Function {
    base: ComponentBase,
    config: FunctionConfig,
    context: Context,
    /// Stored values for {{var}} template slots (same as LLM's template_vars)
    variables: HashMap<String, ComponentValue>,
}

impl Component for Function {
    fn call_method(&mut self, method: &str, args: ComponentValue) -> Result<(), String> {
        match method {
            "trigger" => {
                // Substitute {{vars}} with JS literals, then eval
                let code = self.build_code();
                let wrapped = format!("(function(input) {{ {code} }})({})", value_to_js_literal(&args));
                let result = self.context.eval(Source::from_bytes(&wrapped))
                    .map_err(|e| format!("JS error: {e}"))?;
                let output = js_value_to_component_value(&result);
                self.base.set_value(output);
                self.base.emit("value");
                Ok(())
            }
            var_name => {
                // Store dynamic variable value (same as LLM's catch-all branch)
                self.variables.insert(var_name.to_string(), args);
                Ok(())
            }
        }
    }
}
```

### Handle layout

```
         ┌──────────────┐
trigger ─┤              ├─ value (output)
         │   Function   │
         └──┬───┬───┬───┘
            │   │   │
         threshold offset  (dynamic, parsed from {{}} in code)
```

This mirrors the LLM node exactly:
- `trigger` handle (left, command type) → kicks off evaluation
- Dynamic `{{var}}` handles (bottom, value type) → store values, substituted before eval
- `value` handle (right, value type) → emits the function's return value

---

## Decisions

- **Multiple outputs:** No. Single `value` output, user decides the shape.
- **Persistent state:** No. Fresh eval each trigger — simple input→output mapper. The boa `Context` is reused for performance but variables are re-injected each time (no leftover state between runs).
- **Code sharing/presets:** Deferred to a future version.
