import { Matrix } from "./matrix/matrix";
import { Midi } from "./midi/midi";
import { Monitor } from "./monitor/monitor";
import { Motion } from "./motion/motion";
import { Mqtt } from "./mqtt/mqtt";
import { Oscillator } from "./oscillator/oscillator";
import { Piezo } from "./piezo/piezo";
import { Pixel } from "./pixel/pixel";
import { Pn532 } from "./pn532/pn532";
import { Proximity } from "./proximity/proximity";
import { Rgb } from "./rgb/rgb";
import { RangeMap } from "./range-map/range-map";
import { Relay } from "./relay/relay";
import { Sensor } from "./sensor/sensor";
import { Force } from "./force/force";
import { HallEffect } from "./hall-effect/hall-effect";
import { Ldr } from "./ldr/ldr";
import { Potentiometer } from "./potentiometer/potentiometer";
import { Tilt } from "./tilt/tilt";
import { Servo } from "./servo/servo";
import { Smooth } from "./smooth/smooth";
import { Stepper } from "./stepper/stepper";
import { Switch } from "./switch/switch";
import { Trigger } from "./trigger/trigger";
import { Button } from ".//button/button";
import { Constant } from "./constant/constant";
import { Counter } from "./counter/counter";
import { Delay } from "./delay/delay";
import { Figma } from "./figma/figma";
import { Function } from "./function/function";
import { Gate } from "./gate/gate";
import { Hotkey } from "./hotkey/hotkey";
import { I2cDevice } from "./i2c-device/i2c-device";
import { Interval } from "./interval/interval";
import { Led } from "./led/led";
import { Vibration } from "./vibration/vibration";
import { Llm } from "./llm/llm";
import type { NodeTypes } from "@xyflow/react";
import { Compare } from "./compare/compare";
import { Calculate } from "./calculate/calculate";
import type { ComponentType } from "./_base/_base.types";

// Re-export component types for external use
export { COMPONENT_TYPES, type ComponentType, isComponentType } from "./_base/_base.types";

// ============================================================================
// Node Types Registry
// ============================================================================
// Maps component type names to their React components.
// The keys MUST match the COMPONENT_TYPES array in _component-types.ts.
//
// TypeScript will error if you add a component here without adding it to
// COMPONENT_TYPES, or vice versa (via the satisfies check below).
// ============================================================================

export const NODE_TYPES = {
  Button: Button,
  Calculate: Calculate,
  Compare: Compare,
  Constant: Constant,
  Counter: Counter,
  Delay: Delay,
  Figma: Figma,
  Force: Force,
  Function: Function,
  Gate: Gate,
  HallEffect: HallEffect,
  Hotkey: Hotkey,
  I2cDevice: I2cDevice,
  Interval: Interval,
  Ldr: Ldr,
  Led: Led,
  Llm: Llm,
  Matrix: Matrix,
  Midi: Midi,
  Monitor: Monitor,
  Motion: Motion,
  Mqtt: Mqtt,
  Oscillator: Oscillator,
  Piezo: Piezo,
  Pixel: Pixel,
  Pn532: Pn532,
  Potentiometer: Potentiometer,
  Proximity: Proximity,
  RangeMap: RangeMap,
  Relay: Relay,
  Rgb: Rgb,
  Sensor: Sensor,
  Servo: Servo,
  Smooth: Smooth,
  Stepper: Stepper,
  Switch: Switch,
  Tilt: Tilt,
  Trigger: Trigger,
  Vibration: Vibration,
} as const satisfies NodeTypes & Record<ComponentType, unknown>;
