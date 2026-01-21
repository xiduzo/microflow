// ============================================================================
// Component Types - Single Source of Truth
// ============================================================================
// This file defines all valid component type names as a standalone module
// to avoid circular dependencies between _TYPES.ts and _base/_base.schema.ts.
//
// The keys here are used:
// 1. As ReactFlow node type identifiers (in _TYPES.ts)
// 2. As the `instance` field in node data schemas
// 3. Should match Rust ComponentRegistry entries in src-tauri/src/runtime/registry.rs
//
// To add a new node:
// 1. Add the type name here
// 2. Add the component to NODE_TYPES in _TYPES.ts
// 3. Create the schema with `instance: z.literal("YourNode")`
// 4. Add the Rust component to the registry (if it requires hardware)
// ============================================================================

/**
 * All valid component type names.
 * This is the single source of truth for component types.
 */
export const COMPONENT_TYPES = [
  "Button",
  "Calculate",
  "Compare",
  "Constant",
  "Counter",
  "Delay",
  "Force",
  "Gate",
  "HallEffect",
  "Interval",
  "Ldr",
  "Led",
  "Llm",
  "Matrix",
  "Monitor",
  "Motion",
  "Mqtt",
  "Oscillator",
  "Piezo",
  "Pixel",
  "Potentiometer",
  "Proximity",
  "RangeMap",
  "Relay",
  "Rgb",
  "Sensor",
  "Servo",
  "Smooth",
  "Switch",
  "Tilt",
  "Trigger",
] as const;

/**
 * Union type of all valid component type names.
 * Use this for type-safe component type references.
 *
 * @example
 * const myType: ComponentType = "Led"; // ✓ Valid
 * const badType: ComponentType = "Foo"; // ✗ Type error
 */
export type ComponentType = (typeof COMPONENT_TYPES)[number];

/**
 * Type guard to check if a string is a valid ComponentType.
 * Use this for runtime validation of user input or external data.
 *
 * @example
 * if (isComponentType(input)) {
 *   // input is narrowed to ComponentType
 * }
 */
export function isComponentType(value: string): value is ComponentType {
  return COMPONENT_TYPES.includes(value as ComponentType);
}
