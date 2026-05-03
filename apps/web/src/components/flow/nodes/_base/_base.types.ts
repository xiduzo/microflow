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
  "Vibration",
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

export function isComponentType(value: string): value is ComponentType {
  return COMPONENT_TYPES.includes(value as ComponentType);
}
