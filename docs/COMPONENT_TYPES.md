# Component Types - Type Safety Guide

## Overview

This document explains how the TypeScript frontend knows every component type name (`"Button"`, `"Led"`, …) and its handles, and how that stays consistent with the Rust runtime.

No TypeScript file lists component types by hand. `bun run codegen` generates them from the Component Catalog and the Rust wire interface, and the compiler plus the Catalog Parity Guard catch drift.

## Architecture

```
apps/web/node-components.json                 entries[] (UI names) + impls[] (runtime classes)
Rust <Impl>::ports() / emits()  ──►  apps/web/wire-interface.generated.json
                                     (written by the Catalog Parity Guard, BLESS_WIRE_INTERFACE=1)
        │
        ▼
apps/web/scripts/codegen-node-registry.ts     (bun run codegen)
        │
        ├──► nodes/component-types.generated.ts   COMPONENT_TYPES, ComponentType, ports, emits
        │         │
        │         └──► nodes/_base/_base.schema.ts   Zod schema uses COMPONENT_TYPES
        │                   └──► node schemas (led.schema.ts, etc.)
        │
        ├──► nodes/catalog.generated.ts           NODE_CATALOG: defaults, schema, adapter (no React)
        │
        └──► nodes/node-types.generated.ts        NODE_TYPES: React component per type
                  └──► ReactFlow nodeTypes prop
```

The `nodes/` paths are under `apps/web/src/`. `bun run catalog:sync` (in `apps/web`) runs both steps: it blesses `wire-interface.generated.json` from Rust, then runs `bun run codegen`.

## Files

### `component-types.generated.ts` - Type names and wire interface

The canonical list of component type names, plus what the runtime declares for each:

```typescript
export const COMPONENT_TYPES = [
  "Button",
  "Calculate",
  // ...
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

export function isComponentType(value: string): value is ComponentType { /* ... */ }
```

It also exports `COMPONENT_PORTS` / `PortOf<T>` and `COMPONENT_EMITS` / `EmitOf<T>` (the handles, generated from the Rust `ports()` / `emits()`, see [ADR-0007](adr/0007-node-wire-interface-emit-contract.md)), `REQUIRES_HARDWARE`, and `COMPONENT_IMPL` (entry name → impl name). It has no React and no schemas, so any code may import it.

### `_base/_base.schema.ts` - Zod validation

Creates a Zod schema from the component types, and re-exports `COMPONENT_TYPES`, `ComponentType` and `isComponentType` for node schemas:

```typescript
import { COMPONENT_TYPES } from "../component-types.generated";

export const componentTypeSchema = z.enum(COMPONENT_TYPES);

export const baseDataSchema = z.looseObject({
  instance: componentTypeSchema.optional(),
  // ...
});
```

### `catalog.generated.ts` - `NODE_CATALOG`

Per component type: the `defaults` and `dataSchema` exported by `<node>/<node>.schema.ts`, and the `adapter` exported by `<node>/<node>.adapter.ts` when that file exists.

```typescript
export const NODE_CATALOG = {
  Button: { defaults: ButtonDefaults as NodeDefaults, schema: ButtonSchema, adapter: undefined },
  // ...
} satisfies Record<ComponentType, NodeCatalogEntry>;
```

It never imports a node's React component. Non-UI code (the runtime host, Ask AI, templates, the Node Data Resolver) reads node metadata from here without loading every node's UI.

### `node-types.generated.ts` - `NODE_TYPES`

Maps component types to React components, for ReactFlow:

```typescript
export const NODE_TYPES = {
  Button,
  Calculate,
  // ...
} as const satisfies NodeTypes & Record<ComponentType, unknown>;
```

It imports every node's UI. The architecture guard allows runtime imports of it only from `editor/`, `flows/` and `nodes/` ([ADR-0027](adr/0027-web-app-domain-verticals.md)).

## Adding a New Node

1. **Add the entry** to `apps/web/node-components.json` (`entries[]`, and `impls[]` when the node has its own runtime class).

2. **Create the node folder** `apps/web/src/nodes/my-new-node/` (kebab-case of the entry name):
   ```typescript
   // my-new-node.schema.ts
   import { z } from "zod";
   import { baseDataSchema } from "../_base/_base.schema";

   export const dataSchema = baseDataSchema.extend({
     instance: z.literal("MyNewNode").default("MyNewNode"),
     // ...node-specific fields
   });

   export const defaults = {
     ...dataSchema.parse({}),
     group: "shape",
     label: "My new node",
     // ...tags, description, icon
   };
   ```
   Next to it, `my-new-node.tsx` exports the component as `MyNewNode` (the entry name). Add `my-new-node.adapter.ts`, exporting `adapter: NodeHostAdapter`, only when the node needs a host adapter.

3. **Run codegen** from `apps/web`:
   ```sh
   bun run catalog:sync   # when the Rust ports/emits are new or changed
   bun run codegen        # when only the catalog or the frontend changed
   ```

4. **Add the Rust component** in `crates/microflow-core` and register it in the `ComponentRegistry`. The contributor guide (`apps/fumadocs/content/docs/contributing/adding-a-node.mdx`) walks through both halves.

## Type Safety Guarantees

### Compile-Time Checks

- **Missing or misnamed node files:** the generated files import `./<node>/<node>` (the component, by entry name) and `./<node>/<node>.schema` (`dataSchema`, `defaults`) for every entry. A missing file or export fails `tsc` in the generated file.

- **Missing catalog or map entry:** `NODE_CATALOG` and `NODE_TYPES` are both checked against `Record<ComponentType, …>`, so every type has metadata and a component.

- **Unknown handle:** `NodeHandles` and `Handle<"Button">` accept only ids in `PortOf<T>` / `EmitOf<T>`. A port renamed in Rust is a compile error in the UI after `bun run catalog:sync`.

### Runtime Validation

- **Zod parsing:** When node data is parsed, invalid instance values are rejected:
  ```typescript
  baseDataSchema.parse({ instance: "InvalidType" });
  // Throws: Invalid enum value
  ```

- **Type guard:** For dynamic validation:
  ```typescript
  import { isComponentType } from "./component-types.generated";

  if (isComponentType(userInput)) {
    // userInput is narrowed to ComponentType
  }
  ```

## Rust Synchronization

The Catalog Parity Guard (`apps/web/src-tauri/tests/catalog_parity.rs`, [ADR-0007](adr/0007-node-wire-interface-emit-contract.md)) keeps the catalog and the Rust `ComponentRegistry` in step:

- With `BLESS_WIRE_INTERFACE=1` it writes `apps/web/wire-interface.generated.json` from the ports and emits each registered Rust component declares.
- Without it, it fails when that file is stale, so wrong handle types cannot ship.
- It always fails when a catalog entry has no registered Rust component, or the other way round.

## Related Files

- `apps/web/node-components.json` - Component Catalog
- `apps/web/scripts/codegen-node-registry.ts` - Codegen
- `apps/web/src/nodes/component-types.generated.ts` - Type names, ports, emits
- `apps/web/src/nodes/catalog.generated.ts` - `NODE_CATALOG`
- `apps/web/src/nodes/node-types.generated.ts` - `NODE_TYPES` (ReactFlow)
- `apps/web/src/nodes/_base/_base.schema.ts` - Zod schema
- `apps/web/src/nodes/_base/host-adapter.ts` - `NodeHostAdapter`
- `apps/web/src-tauri/tests/catalog_parity.rs` - Catalog Parity Guard
