# Plugin System - Future Considerations

## Overview

This document captures the architectural considerations for a future plugin system that would allow users to create custom nodes. This is parked for future implementation but documented here for reference.

## The Challenge

Microflow nodes have two parts:
1. **Frontend (TypeScript/React)** - UI component, settings panel, handles
2. **Backend (Rust)** - Hardware interaction, execution logic

A plugin system needs to handle both, which raises security concerns about arbitrary code execution.

## Proposed Tiers

### Tier 1: Soft Plugins (JS-only, Safe)

**What:** Plugins that only work in the web UI, no hardware access.

**Use Cases:**
- Data transformation (math, string manipulation)
- External API calls (webhooks, REST APIs, LLMs)
- Custom visualizations
- Protocol converters (JSON parsing, data formatting)

**Implementation:**
```typescript
// A "Function" node that runs user JS in a sandbox
interface SoftPlugin {
  name: string;
  description: string;
  inputs: { id: string; label: string }[];
  outputs: { id: string; label: string }[];
  // Runs in iframe/worker sandbox
  process: (inputs: Record<string, unknown>) => Record<string, unknown>;
}
```

**Security Model:**
- Runs in sandboxed iframe or Web Worker
- No access to DOM, localStorage, or parent window
- Network requests go through a proxy with rate limiting
- CPU/memory limits enforced

**Rust Runtime Behavior:**
- Treated as passthrough node
- Values flow through without Rust processing
- Or ignored entirely (web-only execution)

### Tier 2: Composite Plugins / Subflows (Safe)

**What:** Save a group of existing nodes as a reusable "macro."

**Use Cases:**
- Reusable patterns (debounce + threshold + LED)
- Team-shared components
- Tutorial building blocks

**Implementation:**
```typescript
interface Subflow {
  id: string;
  name: string;
  description: string;
  // Exposed inputs/outputs
  inputs: { nodeId: string; handleId: string; label: string }[];
  outputs: { nodeId: string; handleId: string; label: string }[];
  // Internal flow structure
  nodes: FlowNode[];
  edges: FlowEdge[];
}
```

**Security Model:**
- No new code, just composition
- Completely safe - uses existing vetted nodes
- Can be shared via JSON export/import

### Tier 3: Blessed Community Plugins (Curated)

**What:** Reviewed and approved plugins that ship with the app.

**Process:**
1. Developer submits plugin (TS component + Rust component)
2. Maintainers review for security and quality
3. Plugin is bundled into next release
4. Users can enable/disable plugins

**Implementation:**
```
plugins/
├── community/
│   ├── midi-input/
│   │   ├── midi-input.tsx      # React component
│   │   ├── midi-input.schema.ts
│   │   ├── midi-input.rs       # Rust component
│   │   └── plugin.json         # Metadata
│   └── dmx-output/
│       └── ...
```

**Security Model:**
- Human review of all code
- Plugins are signed
- Sandboxed permissions (declare what hardware access needed)

### Tier 4: WASM Plugins (Advanced, Future)

**What:** Plugins compile to WebAssembly, run in sandbox everywhere.

**Benefits:**
- Memory isolation (can't access host memory)
- Capability-based permissions
- Cross-platform (same WASM runs in browser + Tauri)
- Language-agnostic (Rust, Go, C, AssemblyScript)

**Implementation:**
```rust
// Plugin defines WASM exports
#[plugin_export]
fn component_type() -> &'static str { "MidiInput" }

#[plugin_export]
fn process(input: &[u8]) -> Vec<u8> { /* ... */ }

#[plugin_export]
fn initialize(config: &[u8]) -> Result<(), String> { /* ... */ }
```

**Host provides imports:**
```rust
// Capabilities granted to plugin
#[plugin_import]
fn emit_event(handle: &str, value: &[u8]);

#[plugin_import]
fn log(level: u8, message: &str);

// Hardware access requires explicit grant
#[plugin_import]
fn digital_write(pin: u8, value: bool) -> Result<(), String>;
```

**Security Model:**
- WASM sandbox prevents memory access
- Capabilities explicitly granted at install time
- Resource limits (CPU, memory, I/O)
- Revocable permissions

## Recommended Starting Point

**Start with Tier 1 + Tier 2:**

1. **Function Node** - Sandboxed JS for custom transformations
2. **Subflows** - Compose existing nodes into reusable blocks

This gives users significant flexibility with minimal security risk. The implementation is straightforward and doesn't require changes to the Rust runtime.

## Open Questions

1. **Plugin Distribution:** How do users discover and install plugins?
   - Built-in marketplace?
   - GitHub-based registry?
   - Manual import/export?

2. **Versioning:** How do we handle plugin updates that change behavior?
   - Semantic versioning?
   - Migration scripts?
   - Pin to specific versions?

3. **Hardware Plugins:** For Tier 3/4, how do we handle new hardware protocols?
   - Ship common protocols (I2C, SPI, UART) as host capabilities
   - Plugins compose on top of primitives
   - Or: plugins can include native drivers (highest risk)

4. **Testing:** How do plugin authors test their plugins?
   - Simulator mode?
   - Test harness?
   - CI integration?

## Related Files

- `apps/web/src/components/flow/nodes/_TYPES.ts` - Node registry
- `apps/web/src-tauri/src/runtime/registry.rs` - Rust component registry
- `apps/web/src/components/flow/nodes/_base/_base.tsx` - Base node component

## References

- [Figma Plugin API](https://www.figma.com/plugin-docs/) - Good example of sandboxed JS plugins
- [VS Code Extension API](https://code.visualstudio.com/api) - Capability-based permissions
- [Wasmtime](https://wasmtime.dev/) - WASM runtime for Rust
- [Extism](https://extism.org/) - Cross-language plugin system using WASM
