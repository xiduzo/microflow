// GENERATED — do not edit. Source: node-components.json. Run `bun run codegen`.
import type { NodeTypes } from "@xyflow/react";
import type { ComponentType } from "./_base/_base.types";
import type { NodeHostAdapter } from "./_base/host-adapter";

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
import { adapter as FigmaAdapter } from "./figma/figma";
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
import { adapter as HotkeyAdapter } from "./hotkey/hotkey";
import { I2cDevice } from "./i2c-device/i2c-device";
import { defaults as I2cDeviceDefaults } from "./i2c-device/i2c-device.schema";
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
import { adapter as MqttAdapter } from "./mqtt/mqtt";
import { Oscillator } from "./oscillator/oscillator";
import { defaults as OscillatorDefaults } from "./oscillator/oscillator.schema";
import { Piezo } from "./piezo/piezo";
import { defaults as PiezoDefaults } from "./piezo/piezo.schema";
import { Pixel } from "./pixel/pixel";
import { defaults as PixelDefaults } from "./pixel/pixel.schema";
import { Pn532 } from "./pn532/pn532";
import { defaults as Pn532Defaults } from "./pn532/pn532.schema";
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
import { Stepper } from "./stepper/stepper";
import { defaults as StepperDefaults } from "./stepper/stepper.schema";
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
  adapter?: NodeHostAdapter;
};

export const NODE_REGISTRY = {
  Button: { component: Button, defaults: ButtonDefaults as NodeDefaults, adapter: undefined },
  Calculate: { component: Calculate, defaults: CalculateDefaults as NodeDefaults, adapter: undefined },
  Compare: { component: Compare, defaults: CompareDefaults as NodeDefaults, adapter: undefined },
  Constant: { component: Constant, defaults: ConstantDefaults as NodeDefaults, adapter: undefined },
  Counter: { component: Counter, defaults: CounterDefaults as NodeDefaults, adapter: undefined },
  Delay: { component: Delay, defaults: DelayDefaults as NodeDefaults, adapter: undefined },
  Figma: { component: Figma, defaults: FigmaDefaults as NodeDefaults, adapter: FigmaAdapter },
  Force: { component: Force, defaults: ForceDefaults as NodeDefaults, adapter: undefined },
  Function: { component: Function, defaults: FunctionDefaults as NodeDefaults, adapter: undefined },
  Gate: { component: Gate, defaults: GateDefaults as NodeDefaults, adapter: undefined },
  HallEffect: { component: HallEffect, defaults: HallEffectDefaults as NodeDefaults, adapter: undefined },
  Hotkey: { component: Hotkey, defaults: HotkeyDefaults as NodeDefaults, adapter: HotkeyAdapter },
  I2cDevice: { component: I2cDevice, defaults: I2cDeviceDefaults as NodeDefaults, adapter: undefined },
  Interval: { component: Interval, defaults: IntervalDefaults as NodeDefaults, adapter: undefined },
  Ldr: { component: Ldr, defaults: LdrDefaults as NodeDefaults, adapter: undefined },
  Led: { component: Led, defaults: LedDefaults as NodeDefaults, adapter: undefined },
  Llm: { component: Llm, defaults: LlmDefaults as NodeDefaults, adapter: undefined },
  Matrix: { component: Matrix, defaults: MatrixDefaults as NodeDefaults, adapter: undefined },
  Monitor: { component: Monitor, defaults: MonitorDefaults as NodeDefaults, adapter: undefined },
  Motion: { component: Motion, defaults: MotionDefaults as NodeDefaults, adapter: undefined },
  Mqtt: { component: Mqtt, defaults: MqttDefaults as NodeDefaults, adapter: MqttAdapter },
  Oscillator: { component: Oscillator, defaults: OscillatorDefaults as NodeDefaults, adapter: undefined },
  Piezo: { component: Piezo, defaults: PiezoDefaults as NodeDefaults, adapter: undefined },
  Pixel: { component: Pixel, defaults: PixelDefaults as NodeDefaults, adapter: undefined },
  Pn532: { component: Pn532, defaults: Pn532Defaults as NodeDefaults, adapter: undefined },
  Potentiometer: { component: Potentiometer, defaults: PotentiometerDefaults as NodeDefaults, adapter: undefined },
  Proximity: { component: Proximity, defaults: ProximityDefaults as NodeDefaults, adapter: undefined },
  RangeMap: { component: RangeMap, defaults: RangeMapDefaults as NodeDefaults, adapter: undefined },
  Relay: { component: Relay, defaults: RelayDefaults as NodeDefaults, adapter: undefined },
  Rgb: { component: Rgb, defaults: RgbDefaults as NodeDefaults, adapter: undefined },
  Sensor: { component: Sensor, defaults: SensorDefaults as NodeDefaults, adapter: undefined },
  Servo: { component: Servo, defaults: ServoDefaults as NodeDefaults, adapter: undefined },
  Smooth: { component: Smooth, defaults: SmoothDefaults as NodeDefaults, adapter: undefined },
  Stepper: { component: Stepper, defaults: StepperDefaults as NodeDefaults, adapter: undefined },
  Switch: { component: Switch, defaults: SwitchDefaults as NodeDefaults, adapter: undefined },
  Tilt: { component: Tilt, defaults: TiltDefaults as NodeDefaults, adapter: undefined },
  Trigger: { component: Trigger, defaults: TriggerDefaults as NodeDefaults, adapter: undefined },
  Vibration: { component: Vibration, defaults: VibrationDefaults as NodeDefaults, adapter: undefined },
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
  I2cDevice,
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
  Pn532,
  Potentiometer,
  Proximity,
  RangeMap,
  Relay,
  Rgb,
  Sensor,
  Servo,
  Smooth,
  Stepper,
  Switch,
  Tilt,
  Trigger,
  Vibration,
} as const satisfies NodeTypes & Record<ComponentType, unknown>;
