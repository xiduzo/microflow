// GENERATED — edit node-components.json, then run `bun run codegen`
import type { NodeTypes } from "@xyflow/react";
import type { ComponentType } from "./_base/_base.types";

import { Button } from "./button/button";
import { defaults as ButtonDefaults } from "./button/button.schema";
import { Calculate } from "./calculate/calculate";
import { defaults as CalculateDefaults } from "./calculate/calculate.schema";
import { Compare } from "./compare/compare";
import { defaults as CompareDefaults } from "./compare/compare.schema";
import { Constant } from "./constant/constant";
import { defaults as ConstantDefaults } from "./constant/constant.schema";
import { Counter } from "./counter/counter";
import { defaults as CounterDefaults } from "./counter/counter.schema";
import { Delay } from "./delay/delay";
import { defaults as DelayDefaults } from "./delay/delay.schema";
import { Figma } from "./figma/figma";
import { defaults as FigmaDefaults } from "./figma/figma.schema";
import { Force } from "./force/force";
import { defaults as ForceDefaults } from "./force/force.schema";
import { Function } from "./function/function";
import { defaults as FunctionDefaults } from "./function/function.schema";
import { Gate } from "./gate/gate";
import { defaults as GateDefaults } from "./gate/gate.schema";
import { HallEffect } from "./hall-effect/hall-effect";
import { defaults as HallEffectDefaults } from "./hall-effect/hall-effect.schema";
import { Hotkey } from "./hotkey/hotkey";
import { defaults as HotkeyDefaults } from "./hotkey/hotkey.schema";
import { Interval } from "./interval/interval";
import { defaults as IntervalDefaults } from "./interval/interval.schema";
import { Ldr } from "./ldr/ldr";
import { defaults as LdrDefaults } from "./ldr/ldr.schema";
import { Led } from "./led/led";
import { defaults as LedDefaults } from "./led/led.schema";
import { Llm } from "./llm/llm";
import { defaults as LlmDefaults } from "./llm/llm.schema";
import { Matrix } from "./matrix/matrix";
import { defaults as MatrixDefaults } from "./matrix/matrix.schema";
import { Monitor } from "./monitor/monitor";
import { defaults as MonitorDefaults } from "./monitor/monitor.schema";
import { Motion } from "./motion/motion";
import { defaults as MotionDefaults } from "./motion/motion.schema";
import { Mqtt } from "./mqtt/mqtt";
import { defaults as MqttDefaults } from "./mqtt/mqtt.schema";
import { Oscillator } from "./oscillator/oscillator";
import { defaults as OscillatorDefaults } from "./oscillator/oscillator.schema";
import { Piezo } from "./piezo/piezo";
import { defaults as PiezoDefaults } from "./piezo/piezo.schema";
import { Pixel } from "./pixel/pixel";
import { defaults as PixelDefaults } from "./pixel/pixel.schema";
import { Potentiometer } from "./potentiometer/potentiometer";
import { defaults as PotentiometerDefaults } from "./potentiometer/potentiometer.schema";
import { Proximity } from "./proximity/proximity";
import { defaults as ProximityDefaults } from "./proximity/proximity.schema";
import { RangeMap } from "./range-map/range-map";
import { defaults as RangeMapDefaults } from "./range-map/range-map.schema";
import { Relay } from "./relay/relay";
import { defaults as RelayDefaults } from "./relay/relay.schema";
import { Rgb } from "./rgb/rgb";
import { defaults as RgbDefaults } from "./rgb/rgb.schema";
import { Sensor } from "./sensor/sensor";
import { defaults as SensorDefaults } from "./sensor/sensor.schema";
import { Servo } from "./servo/servo";
import { defaults as ServoDefaults } from "./servo/servo.schema";
import { Smooth } from "./smooth/smooth";
import { defaults as SmoothDefaults } from "./smooth/smooth.schema";
import { Switch } from "./switch/switch";
import { defaults as SwitchDefaults } from "./switch/switch.schema";
import { Tilt } from "./tilt/tilt";
import { defaults as TiltDefaults } from "./tilt/tilt.schema";
import { Trigger } from "./trigger/trigger";
import { defaults as TriggerDefaults } from "./trigger/trigger.schema";
import { Vibration } from "./vibration/vibration";
import { defaults as VibrationDefaults } from "./vibration/vibration.schema";

export type NodeDefaults = {
  group?: string;
  label?: string;
  description?: string;
  tags?: readonly string[];
  icon?: string;
  [key: string]: unknown;
};

export type NodeRegistryEntry = {
  component: unknown;
  defaults: NodeDefaults;
};

export const NODE_REGISTRY = {
  Button: { component: Button, defaults: ButtonDefaults as NodeDefaults },
  Calculate: { component: Calculate, defaults: CalculateDefaults as NodeDefaults },
  Compare: { component: Compare, defaults: CompareDefaults as NodeDefaults },
  Constant: { component: Constant, defaults: ConstantDefaults as NodeDefaults },
  Counter: { component: Counter, defaults: CounterDefaults as NodeDefaults },
  Delay: { component: Delay, defaults: DelayDefaults as NodeDefaults },
  Figma: { component: Figma, defaults: FigmaDefaults as NodeDefaults },
  Force: { component: Force, defaults: ForceDefaults as NodeDefaults },
  Function: { component: Function, defaults: FunctionDefaults as NodeDefaults },
  Gate: { component: Gate, defaults: GateDefaults as NodeDefaults },
  HallEffect: { component: HallEffect, defaults: HallEffectDefaults as NodeDefaults },
  Hotkey: { component: Hotkey, defaults: HotkeyDefaults as NodeDefaults },
  Interval: { component: Interval, defaults: IntervalDefaults as NodeDefaults },
  Ldr: { component: Ldr, defaults: LdrDefaults as NodeDefaults },
  Led: { component: Led, defaults: LedDefaults as NodeDefaults },
  Llm: { component: Llm, defaults: LlmDefaults as NodeDefaults },
  Matrix: { component: Matrix, defaults: MatrixDefaults as NodeDefaults },
  Monitor: { component: Monitor, defaults: MonitorDefaults as NodeDefaults },
  Motion: { component: Motion, defaults: MotionDefaults as NodeDefaults },
  Mqtt: { component: Mqtt, defaults: MqttDefaults as NodeDefaults },
  Oscillator: { component: Oscillator, defaults: OscillatorDefaults as NodeDefaults },
  Piezo: { component: Piezo, defaults: PiezoDefaults as NodeDefaults },
  Pixel: { component: Pixel, defaults: PixelDefaults as NodeDefaults },
  Potentiometer: { component: Potentiometer, defaults: PotentiometerDefaults as NodeDefaults },
  Proximity: { component: Proximity, defaults: ProximityDefaults as NodeDefaults },
  RangeMap: { component: RangeMap, defaults: RangeMapDefaults as NodeDefaults },
  Relay: { component: Relay, defaults: RelayDefaults as NodeDefaults },
  Rgb: { component: Rgb, defaults: RgbDefaults as NodeDefaults },
  Sensor: { component: Sensor, defaults: SensorDefaults as NodeDefaults },
  Servo: { component: Servo, defaults: ServoDefaults as NodeDefaults },
  Smooth: { component: Smooth, defaults: SmoothDefaults as NodeDefaults },
  Switch: { component: Switch, defaults: SwitchDefaults as NodeDefaults },
  Tilt: { component: Tilt, defaults: TiltDefaults as NodeDefaults },
  Trigger: { component: Trigger, defaults: TriggerDefaults as NodeDefaults },
  Vibration: { component: Vibration, defaults: VibrationDefaults as NodeDefaults },
} satisfies Record<ComponentType, NodeRegistryEntry>;

// ReactFlow compatibility — derived from NODE_REGISTRY
export const NODE_TYPES = {
  Button,
  Calculate,
  Compare,
  Constant,
  Counter,
  Delay,
  Figma,
  Force,
  Function,
  Gate,
  HallEffect,
  Hotkey,
  Interval,
  Ldr,
  Led,
  Llm,
  Matrix,
  Monitor,
  Motion,
  Mqtt,
  Oscillator,
  Piezo,
  Pixel,
  Potentiometer,
  Proximity,
  RangeMap,
  Relay,
  Rgb,
  Sensor,
  Servo,
  Smooth,
  Switch,
  Tilt,
  Trigger,
  Vibration,
} as const satisfies NodeTypes & Record<ComponentType, unknown>;
