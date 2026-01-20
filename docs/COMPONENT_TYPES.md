# Component Types - Type Safety Guide

## Overview

This document explains the type-safe component type system that ensures consistency between the TypeScript frontend and Rust backend.

## Architecture

```
_component-types.ts          # Source of truth for type names
        │
        ├──► _base/_base.schema.ts    # Zod schema uses COMPONENT_TYPES
        │         │
        │         └──► node schemas (led.schema.ts, etc.)
        │
        └──► _TYPES.ts          # NODE_TYPES registry uses ComponentType
                  │
                  └──► ReactFlow nodeTypes prop
```

## Files

### `_base.types.ts` - Single Source of Truth

Defines the canonical list of component type names:

```typescript
export const COMPONENT_TYPES = [
  "Button",
  "Led",
  "Sensor",
  // ...
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];
```

### `_base/_base.schema.ts` - Zod Validation

Creates a Zod schema from the component types:

```typescript
import { COMPONENT_TYPES } from "./_base.types.ts";

export const componentTypeSchema = z.enum(COMPONENT_TYPES);

export const baseDataSchema = z.looseObject({
  instance: componentTypeSchema.optional(),
  // ...
});
```

### `_TYPES.ts` - ReactFlow Registry

Maps component types to React components with type checking:

```typescript
import type { ComponentType } from "./_component-types";

export const NODE_TYPES = {
  Button: Button,
  Led: Led,
  // ...
} as const satisfies NodeTypes & Record<ComponentType, unknown>;
```

The `satisfies Record<ComponentType, unknown>` ensures that every type in `COMPONENT_TYPES` has a corresponding entry in `NODE_TYPES`.

## Adding a New Node

1. **Add the type name** to `_component-types.ts`:
   ```typescript
   export const COMPONENT_TYPES = [
     // ...existing types
     "MyNewNode",
   ] as const;
   ```

2. **Create the node component** in `nodes/my-new-node/`:
   ```typescript
   // my-new-node.schema.ts
   import { z } from "zod";
   import { baseDataSchema } from "../_base/_base.schema";

   export const dataSchema = baseDataSchema.extend({
     instance: z.literal("MyNewNode").default("MyNewNode"),
     // ...node-specific fields
   });
   ```

3. **Add to NODE_TYPES** in `_TYPES.ts`:
   ```typescript
   import { MyNewNode } from "./my-new-node/my-new-node";

   export const NODE_TYPES = {
     // ...existing nodes
     MyNewNode: MyNewNode,
   } as const satisfies NodeTypes & Record<ComponentType, unknown>;
   ```

4. **Add Rust component** (if hardware-related) in `src-tauri/src/runtime/`:
   - Create the component in the appropriate module
   - Register it in `registry.rs`

## Type Safety Guarantees

### Compile-Time Checks

- **Missing NODE_TYPES entry:** If you add a type to `COMPONENT_TYPES` but forget to add it to `NODE_TYPES`, TypeScript will error:
  ```
  Type '{ Button: ...; Led: ...; }' does not satisfy 'Record<ComponentType, unknown>'
  Property 'MyNewNode' is missing
  ```

- **Invalid instance literal:** If a node schema uses an invalid instance value:
  ```typescript
  instance: z.literal("Typo"), // ✗ Type error - "Typo" not in COMPONENT_TYPES
  ```

### Runtime Validation

- **Zod parsing:** When node data is parsed, invalid instance values are rejected:
  ```typescript
  baseDataSchema.parse({ instance: "InvalidType" });
  // Throws: Invalid enum value
  ```

- **Type guard:** For dynamic validation:
  ```typescript
  import { isComponentType } from "./_component-types";

  if (isComponentType(userInput)) {
    // userInput is narrowed to ComponentType
  }
  ```

## Rust Synchronization

The Rust `ComponentRegistry` in `src-tauri/src/runtime/registry.rs` must be kept in sync manually. To catch drift:

1. **Integration test** (recommended):
   ```rust
   #[test]
   fn all_component_types_are_registered() {
       let registry = ComponentRegistry::new();
       let expected = ["Button", "Led", "Sensor", /* ... */];
       
       for name in expected {
           assert!(
               registry.has(name),
               "Component '{}' not registered in Rust",
               name
           );
       }
   }
   ```

2. **Build-time script** (optional):
   Generate `component_types.rs` from `_component-types.ts` during build.

## Related Files

- `apps/web/src/components/flow/nodes/_component-types.ts` - Type definitions
- `apps/web/src/components/flow/nodes/_base/_base.schema.ts` - Zod schema
- `apps/web/src/components/flow/nodes/_TYPES.ts` - ReactFlow registry
- `apps/web/src-tauri/src/runtime/registry.rs` - Rust component registry
