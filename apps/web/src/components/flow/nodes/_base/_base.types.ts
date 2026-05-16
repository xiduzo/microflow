// GENERATED — edit node-components.json, then run `bun run codegen`

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
 * Declared **Port** set per Component (catalog-driven). Mirrors
 * `impls[].ports[]` in `node-components.json` and the Rust impl's
 * `Component::ports()` const. The Rust registry asserts equality at
 * construction; this object is the single source of truth for what target
 * handles a ReactFlow edge may carry. Empty array for components with no
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
  Monitor: ["value"] as const,
  Motion: ["read"] as const,
  Mqtt: ["trigger"] as const,
  Oscillator: ["start", "stop", "reset"] as const,
  Piezo: ["trigger", "stop"] as const,
  Pixel: ["value", "color", "set", "reset"] as const,
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
