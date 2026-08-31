// GENERATED — do not edit. Source: node-components.json. Run `bun run codegen`.
import type { NodeTypes } from "@xyflow/react";
import type { ZodType } from "zod";
import type { ComponentType } from "./_base/_base.types";
import type { NodeHostAdapter } from "./_base/host-adapter";

import { Button } from "./button/button";
import { defaults as ButtonDefaults } from "./button/button.schema";
import { dataSchema as ButtonSchema } from "./button/button.schema";
import { Calculate } from "./calculate/calculate";
import { defaults as CalculateDefaults } from "./calculate/calculate.schema";
import { dataSchema as CalculateSchema } from "./calculate/calculate.schema";
import { Compare } from "./compare/compare";
import { defaults as CompareDefaults } from "./compare/compare.schema";
import { dataSchema as CompareSchema } from "./compare/compare.schema";
import { Constant } from "./constant/constant";
import { defaults as ConstantDefaults } from "./constant/constant.schema";
import { dataSchema as ConstantSchema } from "./constant/constant.schema";
import { Counter } from "./counter/counter";
import { defaults as CounterDefaults } from "./counter/counter.schema";
import { dataSchema as CounterSchema } from "./counter/counter.schema";
import { Delay } from "./delay/delay";
import { defaults as DelayDefaults } from "./delay/delay.schema";
import { dataSchema as DelaySchema } from "./delay/delay.schema";
import { Figma } from "./figma/figma";
import { defaults as FigmaDefaults } from "./figma/figma.schema";
import { dataSchema as FigmaSchema } from "./figma/figma.schema";
import { adapter as FigmaAdapter } from "./figma/figma";
import { Force } from "./force/force";
import { defaults as ForceDefaults } from "./force/force.schema";
import { dataSchema as ForceSchema } from "./force/force.schema";
import { Function } from "./function/function";
import { defaults as FunctionDefaults } from "./function/function.schema";
import { dataSchema as FunctionSchema } from "./function/function.schema";
import { Gate } from "./gate/gate";
import { defaults as GateDefaults } from "./gate/gate.schema";
import { dataSchema as GateSchema } from "./gate/gate.schema";
import { HallEffect } from "./hall-effect/hall-effect";
import { defaults as HallEffectDefaults } from "./hall-effect/hall-effect.schema";
import { dataSchema as HallEffectSchema } from "./hall-effect/hall-effect.schema";
import { Hotkey } from "./hotkey/hotkey";
import { defaults as HotkeyDefaults } from "./hotkey/hotkey.schema";
import { dataSchema as HotkeySchema } from "./hotkey/hotkey.schema";
import { adapter as HotkeyAdapter } from "./hotkey/hotkey";
import { I2cDevice } from "./i2c-device/i2c-device";
import { defaults as I2cDeviceDefaults } from "./i2c-device/i2c-device.schema";
import { dataSchema as I2cDeviceSchema } from "./i2c-device/i2c-device.schema";
import { Interval } from "./interval/interval";
import { defaults as IntervalDefaults } from "./interval/interval.schema";
import { dataSchema as IntervalSchema } from "./interval/interval.schema";
import { Ldr } from "./ldr/ldr";
import { defaults as LdrDefaults } from "./ldr/ldr.schema";
import { dataSchema as LdrSchema } from "./ldr/ldr.schema";
import { Led } from "./led/led";
import { defaults as LedDefaults } from "./led/led.schema";
import { dataSchema as LedSchema } from "./led/led.schema";
import { Llm } from "./llm/llm";
import { defaults as LlmDefaults } from "./llm/llm.schema";
import { dataSchema as LlmSchema } from "./llm/llm.schema";
import { Matrix } from "./matrix/matrix";
import { defaults as MatrixDefaults } from "./matrix/matrix.schema";
import { dataSchema as MatrixSchema } from "./matrix/matrix.schema";
import { Midi } from "./midi/midi";
import { defaults as MidiDefaults } from "./midi/midi.schema";
import { dataSchema as MidiSchema } from "./midi/midi.schema";
import { Monitor } from "./monitor/monitor";
import { defaults as MonitorDefaults } from "./monitor/monitor.schema";
import { dataSchema as MonitorSchema } from "./monitor/monitor.schema";
import { Motion } from "./motion/motion";
import { defaults as MotionDefaults } from "./motion/motion.schema";
import { dataSchema as MotionSchema } from "./motion/motion.schema";
import { Mqtt } from "./mqtt/mqtt";
import { defaults as MqttDefaults } from "./mqtt/mqtt.schema";
import { dataSchema as MqttSchema } from "./mqtt/mqtt.schema";
import { adapter as MqttAdapter } from "./mqtt/mqtt";
import { Music } from "./music/music";
import { defaults as MusicDefaults } from "./music/music.schema";
import { dataSchema as MusicSchema } from "./music/music.schema";
import { Note } from "./note/note";
import { defaults as NoteDefaults } from "./note/note.schema";
import { dataSchema as NoteSchema } from "./note/note.schema";
import { Oscillator } from "./oscillator/oscillator";
import { defaults as OscillatorDefaults } from "./oscillator/oscillator.schema";
import { dataSchema as OscillatorSchema } from "./oscillator/oscillator.schema";
import { Piezo } from "./piezo/piezo";
import { defaults as PiezoDefaults } from "./piezo/piezo.schema";
import { dataSchema as PiezoSchema } from "./piezo/piezo.schema";
import { Pixel } from "./pixel/pixel";
import { defaults as PixelDefaults } from "./pixel/pixel.schema";
import { dataSchema as PixelSchema } from "./pixel/pixel.schema";
import { Pn532 } from "./pn532/pn532";
import { defaults as Pn532Defaults } from "./pn532/pn532.schema";
import { dataSchema as Pn532Schema } from "./pn532/pn532.schema";
import { Potentiometer } from "./potentiometer/potentiometer";
import { defaults as PotentiometerDefaults } from "./potentiometer/potentiometer.schema";
import { dataSchema as PotentiometerSchema } from "./potentiometer/potentiometer.schema";
import { Proximity } from "./proximity/proximity";
import { defaults as ProximityDefaults } from "./proximity/proximity.schema";
import { dataSchema as ProximitySchema } from "./proximity/proximity.schema";
import { RangeMap } from "./range-map/range-map";
import { defaults as RangeMapDefaults } from "./range-map/range-map.schema";
import { dataSchema as RangeMapSchema } from "./range-map/range-map.schema";
import { Relay } from "./relay/relay";
import { defaults as RelayDefaults } from "./relay/relay.schema";
import { dataSchema as RelaySchema } from "./relay/relay.schema";
import { Rgb } from "./rgb/rgb";
import { defaults as RgbDefaults } from "./rgb/rgb.schema";
import { dataSchema as RgbSchema } from "./rgb/rgb.schema";
import { Sensor } from "./sensor/sensor";
import { defaults as SensorDefaults } from "./sensor/sensor.schema";
import { dataSchema as SensorSchema } from "./sensor/sensor.schema";
import { Servo } from "./servo/servo";
import { defaults as ServoDefaults } from "./servo/servo.schema";
import { dataSchema as ServoSchema } from "./servo/servo.schema";
import { Smooth } from "./smooth/smooth";
import { defaults as SmoothDefaults } from "./smooth/smooth.schema";
import { dataSchema as SmoothSchema } from "./smooth/smooth.schema";
import { Stepper } from "./stepper/stepper";
import { defaults as StepperDefaults } from "./stepper/stepper.schema";
import { dataSchema as StepperSchema } from "./stepper/stepper.schema";
import { Switch } from "./switch/switch";
import { defaults as SwitchDefaults } from "./switch/switch.schema";
import { dataSchema as SwitchSchema } from "./switch/switch.schema";
import { Tilt } from "./tilt/tilt";
import { defaults as TiltDefaults } from "./tilt/tilt.schema";
import { dataSchema as TiltSchema } from "./tilt/tilt.schema";
import { Trigger } from "./trigger/trigger";
import { defaults as TriggerDefaults } from "./trigger/trigger.schema";
import { dataSchema as TriggerSchema } from "./trigger/trigger.schema";
import { Vibration } from "./vibration/vibration";
import { defaults as VibrationDefaults } from "./vibration/vibration.schema";
import { dataSchema as VibrationSchema } from "./vibration/vibration.schema";

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
  /** The node's own zod schema — the authority on what its `data` may hold.
   *  Exposed here so a caller holding only a type string can validate before
   *  writing to the document (see `lib/ai/flow-tools.ts`). */
  schema: ZodType;
  adapter?: NodeHostAdapter;
};

export const NODE_REGISTRY = {
  Button: { component: Button, defaults: ButtonDefaults as NodeDefaults, schema: ButtonSchema, adapter: undefined },
  Calculate: { component: Calculate, defaults: CalculateDefaults as NodeDefaults, schema: CalculateSchema, adapter: undefined },
  Compare: { component: Compare, defaults: CompareDefaults as NodeDefaults, schema: CompareSchema, adapter: undefined },
  Constant: { component: Constant, defaults: ConstantDefaults as NodeDefaults, schema: ConstantSchema, adapter: undefined },
  Counter: { component: Counter, defaults: CounterDefaults as NodeDefaults, schema: CounterSchema, adapter: undefined },
  Delay: { component: Delay, defaults: DelayDefaults as NodeDefaults, schema: DelaySchema, adapter: undefined },
  Figma: { component: Figma, defaults: FigmaDefaults as NodeDefaults, schema: FigmaSchema, adapter: FigmaAdapter },
  Force: { component: Force, defaults: ForceDefaults as NodeDefaults, schema: ForceSchema, adapter: undefined },
  Function: { component: Function, defaults: FunctionDefaults as NodeDefaults, schema: FunctionSchema, adapter: undefined },
  Gate: { component: Gate, defaults: GateDefaults as NodeDefaults, schema: GateSchema, adapter: undefined },
  HallEffect: { component: HallEffect, defaults: HallEffectDefaults as NodeDefaults, schema: HallEffectSchema, adapter: undefined },
  Hotkey: { component: Hotkey, defaults: HotkeyDefaults as NodeDefaults, schema: HotkeySchema, adapter: HotkeyAdapter },
  I2cDevice: { component: I2cDevice, defaults: I2cDeviceDefaults as NodeDefaults, schema: I2cDeviceSchema, adapter: undefined },
  Interval: { component: Interval, defaults: IntervalDefaults as NodeDefaults, schema: IntervalSchema, adapter: undefined },
  Ldr: { component: Ldr, defaults: LdrDefaults as NodeDefaults, schema: LdrSchema, adapter: undefined },
  Led: { component: Led, defaults: LedDefaults as NodeDefaults, schema: LedSchema, adapter: undefined },
  Llm: { component: Llm, defaults: LlmDefaults as NodeDefaults, schema: LlmSchema, adapter: undefined },
  Matrix: { component: Matrix, defaults: MatrixDefaults as NodeDefaults, schema: MatrixSchema, adapter: undefined },
  Midi: { component: Midi, defaults: MidiDefaults as NodeDefaults, schema: MidiSchema, adapter: undefined },
  Monitor: { component: Monitor, defaults: MonitorDefaults as NodeDefaults, schema: MonitorSchema, adapter: undefined },
  Motion: { component: Motion, defaults: MotionDefaults as NodeDefaults, schema: MotionSchema, adapter: undefined },
  Mqtt: { component: Mqtt, defaults: MqttDefaults as NodeDefaults, schema: MqttSchema, adapter: MqttAdapter },
  Music: { component: Music, defaults: MusicDefaults as NodeDefaults, schema: MusicSchema, adapter: undefined },
  Note: { component: Note, defaults: NoteDefaults as NodeDefaults, schema: NoteSchema, adapter: undefined },
  Oscillator: { component: Oscillator, defaults: OscillatorDefaults as NodeDefaults, schema: OscillatorSchema, adapter: undefined },
  Piezo: { component: Piezo, defaults: PiezoDefaults as NodeDefaults, schema: PiezoSchema, adapter: undefined },
  Pixel: { component: Pixel, defaults: PixelDefaults as NodeDefaults, schema: PixelSchema, adapter: undefined },
  Pn532: { component: Pn532, defaults: Pn532Defaults as NodeDefaults, schema: Pn532Schema, adapter: undefined },
  Potentiometer: { component: Potentiometer, defaults: PotentiometerDefaults as NodeDefaults, schema: PotentiometerSchema, adapter: undefined },
  Proximity: { component: Proximity, defaults: ProximityDefaults as NodeDefaults, schema: ProximitySchema, adapter: undefined },
  RangeMap: { component: RangeMap, defaults: RangeMapDefaults as NodeDefaults, schema: RangeMapSchema, adapter: undefined },
  Relay: { component: Relay, defaults: RelayDefaults as NodeDefaults, schema: RelaySchema, adapter: undefined },
  Rgb: { component: Rgb, defaults: RgbDefaults as NodeDefaults, schema: RgbSchema, adapter: undefined },
  Sensor: { component: Sensor, defaults: SensorDefaults as NodeDefaults, schema: SensorSchema, adapter: undefined },
  Servo: { component: Servo, defaults: ServoDefaults as NodeDefaults, schema: ServoSchema, adapter: undefined },
  Smooth: { component: Smooth, defaults: SmoothDefaults as NodeDefaults, schema: SmoothSchema, adapter: undefined },
  Stepper: { component: Stepper, defaults: StepperDefaults as NodeDefaults, schema: StepperSchema, adapter: undefined },
  Switch: { component: Switch, defaults: SwitchDefaults as NodeDefaults, schema: SwitchSchema, adapter: undefined },
  Tilt: { component: Tilt, defaults: TiltDefaults as NodeDefaults, schema: TiltSchema, adapter: undefined },
  Trigger: { component: Trigger, defaults: TriggerDefaults as NodeDefaults, schema: TriggerSchema, adapter: undefined },
  Vibration: { component: Vibration, defaults: VibrationDefaults as NodeDefaults, schema: VibrationSchema, adapter: undefined },
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
  Midi,
  Monitor,
  Motion,
  Mqtt,
  Music,
  Note,
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
