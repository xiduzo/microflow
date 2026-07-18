// GENERATED — do not edit. Sources: node-components.json (entries/metadata) +
// wire-interface.generated.json (ports/emits, from Rust). Run `bun run codegen`.

export const COMPONENT_TYPES = [
  "Button",
  "Calculate",
  "Compare",
  "Constant",
  "Counter",
  "Delay",
  "Figma",
  "Force",
  "Function",
  "Gate",
  "HallEffect",
  "Hotkey",
  "I2cDevice",
  "Interval",
  "Ldr",
  "Led",
  "Llm",
  "Matrix",
  "Midi",
  "Monitor",
  "Motion",
  "Mqtt",
  "Oscillator",
  "Piezo",
  "Pixel",
  "Pn532",
  "Potentiometer",
  "Proximity",
  "RangeMap",
  "Relay",
  "Rgb",
  "Sensor",
  "Servo",
  "Smooth",
  "Stepper",
  "Switch",
  "Tilt",
  "Trigger",
  "Vibration",
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

export function isComponentType(value: string): value is ComponentType {
  return COMPONENT_TYPES.includes(value as ComponentType);
}

/**
 * Declared **Port** set per Component. GENERATED from the Rust impl's
 * `Component::ports()` via `wire-interface.generated.json` — the single
 * source of truth (see `src-tauri/tests/catalog_parity.rs`). Type-checks the
 * target handles a ReactFlow edge may carry. Empty array for components with no
 * edge inputs (e.g. `Constant`). See CONTEXT.md § Port.
 */
export const COMPONENT_PORTS = {
  Button: ["read"] as const,
  Calculate: ["value"] as const,
  Compare: ["value"] as const,
  Constant: [] as const,
  Counter: ["increment", "decrement", "reset", "set"] as const,
  Delay: ["trigger"] as const,
  Figma: ["true", "false", "toggle", "set", "increment", "decrement", "reset", "red", "green", "blue", "opacity"] as const,
  Force: ["read"] as const,
  Function: ["trigger"] as const,
  Gate: ["value"] as const,
  HallEffect: ["read"] as const,
  Hotkey: ["key_event"] as const,
  I2cDevice: ["write", "trigger"] as const,
  Interval: ["start", "stop"] as const,
  Ldr: ["read"] as const,
  Led: ["true", "false", "toggle", "value"] as const,
  Llm: ["trigger"] as const,
  Matrix: ["value", "reset", "reinitialize"] as const,
  Midi: ["send"] as const,
  Monitor: ["value"] as const,
  Motion: ["read"] as const,
  Mqtt: ["trigger"] as const,
  Oscillator: ["start", "stop", "reset"] as const,
  Piezo: ["trigger", "stop"] as const,
  Pixel: ["value", "color", "set", "reset"] as const,
  Pn532: [] as const,
  Potentiometer: ["read"] as const,
  Proximity: ["read"] as const,
  RangeMap: ["value"] as const,
  Relay: ["true", "false", "toggle"] as const,
  Rgb: ["red", "green", "blue", "alpha", "off"] as const,
  Sensor: ["read"] as const,
  Servo: ["min", "max", "value", "rotate", "stop"] as const,
  Smooth: ["value"] as const,
  Stepper: ["value", "to", "stop", "zero", "enable"] as const,
  Switch: ["read"] as const,
  Tilt: ["read"] as const,
  Trigger: ["value"] as const,
  Vibration: ["true", "false", "toggle", "value"] as const,
} as const satisfies Record<ComponentType, readonly string[]>;

/**
 * Valid `target_handle` literal-union for a given Component instance type.
 * Distributive conditional ensures the result is the union of port literals
 * across all members of `T` when `T` is itself a union of ComponentTypes.
 */
export type PortOf<T extends ComponentType> = T extends ComponentType
  ? (typeof COMPONENT_PORTS)[T][number]
  : never;

/**
 * Declared **Emit** set per Component. GENERATED from the Rust impl's
 * `Component::emits()` via `wire-interface.generated.json` — the single
 * source of truth, kept current by the Catalog Parity Guard
 * (`src-tauri/tests/catalog_parity.rs`). Type-checks the source handles a
 * ReactFlow edge may originate from. See CONTEXT.md § Emit.
 */
export const COMPONENT_EMITS = {
  Button: ["event", "true", "false", "hold", "value"] as const,
  Calculate: ["value"] as const,
  Compare: ["true", "false", "value"] as const,
  Constant: ["value"] as const,
  Counter: ["value"] as const,
  Delay: ["event"] as const,
  Figma: ["change", "value"] as const,
  Force: ["value"] as const,
  Function: ["value"] as const,
  Gate: ["true", "false", "value"] as const,
  HallEffect: ["value"] as const,
  Hotkey: ["event", "true", "false", "value"] as const,
  I2cDevice: ["value"] as const,
  Interval: ["event"] as const,
  Ldr: ["value"] as const,
  Led: ["value"] as const,
  Llm: ["thinking", "value", "done", "error"] as const,
  Matrix: ["value"] as const,
  Midi: ["value", "note", "velocity", "on", "off"] as const,
  Monitor: ["value"] as const,
  Motion: ["event", "true", "false", "value"] as const,
  Mqtt: ["value"] as const,
  Oscillator: ["value"] as const,
  Piezo: ["value"] as const,
  Pixel: ["event", "value"] as const,
  Pn532: ["value"] as const,
  Potentiometer: ["value"] as const,
  Proximity: ["value"] as const,
  RangeMap: ["to", "value"] as const,
  Relay: ["value"] as const,
  Rgb: ["value"] as const,
  Sensor: ["value"] as const,
  Servo: ["value"] as const,
  Smooth: ["value"] as const,
  Stepper: ["value"] as const,
  Switch: ["event", "true", "false", "value"] as const,
  Tilt: ["value"] as const,
  Trigger: ["bang", "value"] as const,
  Vibration: ["value"] as const,
} as const satisfies Record<ComponentType, readonly string[]>;

/**
 * Valid `source_handle` literal-union for a given Component instance type.
 * Distributive conditional ensures the result is the union of emit literals
 * across all members of `T` when `T` is itself a union of ComponentTypes.
 */
export type EmitOf<T extends ComponentType> = T extends ComponentType
  ? (typeof COMPONENT_EMITS)[T][number]
  : never;
