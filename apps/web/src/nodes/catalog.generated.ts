// GENERATED — do not edit. Sources: node-components.json (entries) + each node's
// `<node>.adapter.ts`, when present. Run `bun run codegen`.
// React-free: imports schemas and host adapters only, never a node's UI.
import type { ZodType } from "zod";
import type { ComponentType } from "./component-types.generated";
import type { NodeHostAdapter } from "./_base/host-adapter";

import { defaults as ButtonDefaults } from "./button/button.schema";
import { dataSchema as ButtonSchema } from "./button/button.schema";
import { defaults as CalculateDefaults } from "./calculate/calculate.schema";
import { dataSchema as CalculateSchema } from "./calculate/calculate.schema";
import { defaults as CompareDefaults } from "./compare/compare.schema";
import { dataSchema as CompareSchema } from "./compare/compare.schema";
import { defaults as ConstantDefaults } from "./constant/constant.schema";
import { dataSchema as ConstantSchema } from "./constant/constant.schema";
import { defaults as CounterDefaults } from "./counter/counter.schema";
import { dataSchema as CounterSchema } from "./counter/counter.schema";
import { defaults as DelayDefaults } from "./delay/delay.schema";
import { dataSchema as DelaySchema } from "./delay/delay.schema";
import { defaults as FigmaDefaults } from "./figma/figma.schema";
import { dataSchema as FigmaSchema } from "./figma/figma.schema";
import { adapter as FigmaAdapter } from "./figma/figma.adapter";
import { defaults as ForceDefaults } from "./force/force.schema";
import { dataSchema as ForceSchema } from "./force/force.schema";
import { defaults as FunctionDefaults } from "./function/function.schema";
import { dataSchema as FunctionSchema } from "./function/function.schema";
import { defaults as GateDefaults } from "./gate/gate.schema";
import { dataSchema as GateSchema } from "./gate/gate.schema";
import { defaults as HallEffectDefaults } from "./hall-effect/hall-effect.schema";
import { dataSchema as HallEffectSchema } from "./hall-effect/hall-effect.schema";
import { defaults as HotkeyDefaults } from "./hotkey/hotkey.schema";
import { dataSchema as HotkeySchema } from "./hotkey/hotkey.schema";
import { adapter as HotkeyAdapter } from "./hotkey/hotkey.adapter";
import { defaults as I2cDeviceDefaults } from "./i2c-device/i2c-device.schema";
import { dataSchema as I2cDeviceSchema } from "./i2c-device/i2c-device.schema";
import { defaults as IntervalDefaults } from "./interval/interval.schema";
import { dataSchema as IntervalSchema } from "./interval/interval.schema";
import { defaults as LdrDefaults } from "./ldr/ldr.schema";
import { dataSchema as LdrSchema } from "./ldr/ldr.schema";
import { defaults as LedDefaults } from "./led/led.schema";
import { dataSchema as LedSchema } from "./led/led.schema";
import { defaults as LlmDefaults } from "./llm/llm.schema";
import { dataSchema as LlmSchema } from "./llm/llm.schema";
import { defaults as MatrixDefaults } from "./matrix/matrix.schema";
import { dataSchema as MatrixSchema } from "./matrix/matrix.schema";
import { defaults as MidiDefaults } from "./midi/midi.schema";
import { dataSchema as MidiSchema } from "./midi/midi.schema";
import { defaults as MonitorDefaults } from "./monitor/monitor.schema";
import { dataSchema as MonitorSchema } from "./monitor/monitor.schema";
import { defaults as MotionDefaults } from "./motion/motion.schema";
import { dataSchema as MotionSchema } from "./motion/motion.schema";
import { defaults as MqttDefaults } from "./mqtt/mqtt.schema";
import { dataSchema as MqttSchema } from "./mqtt/mqtt.schema";
import { adapter as MqttAdapter } from "./mqtt/mqtt.adapter";
import { defaults as MusicDefaults } from "./music/music.schema";
import { dataSchema as MusicSchema } from "./music/music.schema";
import { defaults as NoteDefaults } from "./note/note.schema";
import { dataSchema as NoteSchema } from "./note/note.schema";
import { defaults as OscillatorDefaults } from "./oscillator/oscillator.schema";
import { dataSchema as OscillatorSchema } from "./oscillator/oscillator.schema";
import { defaults as PiezoDefaults } from "./piezo/piezo.schema";
import { dataSchema as PiezoSchema } from "./piezo/piezo.schema";
import { defaults as PixelDefaults } from "./pixel/pixel.schema";
import { dataSchema as PixelSchema } from "./pixel/pixel.schema";
import { defaults as Pn532Defaults } from "./pn532/pn532.schema";
import { dataSchema as Pn532Schema } from "./pn532/pn532.schema";
import { defaults as PotentiometerDefaults } from "./potentiometer/potentiometer.schema";
import { dataSchema as PotentiometerSchema } from "./potentiometer/potentiometer.schema";
import { defaults as ProximityDefaults } from "./proximity/proximity.schema";
import { dataSchema as ProximitySchema } from "./proximity/proximity.schema";
import { defaults as RangeMapDefaults } from "./range-map/range-map.schema";
import { dataSchema as RangeMapSchema } from "./range-map/range-map.schema";
import { defaults as RelayDefaults } from "./relay/relay.schema";
import { dataSchema as RelaySchema } from "./relay/relay.schema";
import { defaults as RgbDefaults } from "./rgb/rgb.schema";
import { dataSchema as RgbSchema } from "./rgb/rgb.schema";
import { defaults as SensorDefaults } from "./sensor/sensor.schema";
import { dataSchema as SensorSchema } from "./sensor/sensor.schema";
import { defaults as ServoDefaults } from "./servo/servo.schema";
import { dataSchema as ServoSchema } from "./servo/servo.schema";
import { defaults as SmoothDefaults } from "./smooth/smooth.schema";
import { dataSchema as SmoothSchema } from "./smooth/smooth.schema";
import { defaults as StepperDefaults } from "./stepper/stepper.schema";
import { dataSchema as StepperSchema } from "./stepper/stepper.schema";
import { defaults as SwitchDefaults } from "./switch/switch.schema";
import { dataSchema as SwitchSchema } from "./switch/switch.schema";
import { defaults as TiltDefaults } from "./tilt/tilt.schema";
import { dataSchema as TiltSchema } from "./tilt/tilt.schema";
import { defaults as TriggerDefaults } from "./trigger/trigger.schema";
import { dataSchema as TriggerSchema } from "./trigger/trigger.schema";
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

export type NodeCatalogEntry = {
  defaults: NodeDefaults;
  /** The node's own zod schema — the authority on what its `data` may hold.
   *  Exposed here so a caller holding only a type string can validate before
   *  writing to the document (see `ai/flow-tools.ts`). */
  schema: ZodType;
  adapter?: NodeHostAdapter;
};

export const NODE_CATALOG = {
  Button: { defaults: ButtonDefaults as NodeDefaults, schema: ButtonSchema, adapter: undefined },
  Calculate: { defaults: CalculateDefaults as NodeDefaults, schema: CalculateSchema, adapter: undefined },
  Compare: { defaults: CompareDefaults as NodeDefaults, schema: CompareSchema, adapter: undefined },
  Constant: { defaults: ConstantDefaults as NodeDefaults, schema: ConstantSchema, adapter: undefined },
  Counter: { defaults: CounterDefaults as NodeDefaults, schema: CounterSchema, adapter: undefined },
  Delay: { defaults: DelayDefaults as NodeDefaults, schema: DelaySchema, adapter: undefined },
  Figma: { defaults: FigmaDefaults as NodeDefaults, schema: FigmaSchema, adapter: FigmaAdapter },
  Force: { defaults: ForceDefaults as NodeDefaults, schema: ForceSchema, adapter: undefined },
  Function: { defaults: FunctionDefaults as NodeDefaults, schema: FunctionSchema, adapter: undefined },
  Gate: { defaults: GateDefaults as NodeDefaults, schema: GateSchema, adapter: undefined },
  HallEffect: { defaults: HallEffectDefaults as NodeDefaults, schema: HallEffectSchema, adapter: undefined },
  Hotkey: { defaults: HotkeyDefaults as NodeDefaults, schema: HotkeySchema, adapter: HotkeyAdapter },
  I2cDevice: { defaults: I2cDeviceDefaults as NodeDefaults, schema: I2cDeviceSchema, adapter: undefined },
  Interval: { defaults: IntervalDefaults as NodeDefaults, schema: IntervalSchema, adapter: undefined },
  Ldr: { defaults: LdrDefaults as NodeDefaults, schema: LdrSchema, adapter: undefined },
  Led: { defaults: LedDefaults as NodeDefaults, schema: LedSchema, adapter: undefined },
  Llm: { defaults: LlmDefaults as NodeDefaults, schema: LlmSchema, adapter: undefined },
  Matrix: { defaults: MatrixDefaults as NodeDefaults, schema: MatrixSchema, adapter: undefined },
  Midi: { defaults: MidiDefaults as NodeDefaults, schema: MidiSchema, adapter: undefined },
  Monitor: { defaults: MonitorDefaults as NodeDefaults, schema: MonitorSchema, adapter: undefined },
  Motion: { defaults: MotionDefaults as NodeDefaults, schema: MotionSchema, adapter: undefined },
  Mqtt: { defaults: MqttDefaults as NodeDefaults, schema: MqttSchema, adapter: MqttAdapter },
  Music: { defaults: MusicDefaults as NodeDefaults, schema: MusicSchema, adapter: undefined },
  Note: { defaults: NoteDefaults as NodeDefaults, schema: NoteSchema, adapter: undefined },
  Oscillator: { defaults: OscillatorDefaults as NodeDefaults, schema: OscillatorSchema, adapter: undefined },
  Piezo: { defaults: PiezoDefaults as NodeDefaults, schema: PiezoSchema, adapter: undefined },
  Pixel: { defaults: PixelDefaults as NodeDefaults, schema: PixelSchema, adapter: undefined },
  Pn532: { defaults: Pn532Defaults as NodeDefaults, schema: Pn532Schema, adapter: undefined },
  Potentiometer: { defaults: PotentiometerDefaults as NodeDefaults, schema: PotentiometerSchema, adapter: undefined },
  Proximity: { defaults: ProximityDefaults as NodeDefaults, schema: ProximitySchema, adapter: undefined },
  RangeMap: { defaults: RangeMapDefaults as NodeDefaults, schema: RangeMapSchema, adapter: undefined },
  Relay: { defaults: RelayDefaults as NodeDefaults, schema: RelaySchema, adapter: undefined },
  Rgb: { defaults: RgbDefaults as NodeDefaults, schema: RgbSchema, adapter: undefined },
  Sensor: { defaults: SensorDefaults as NodeDefaults, schema: SensorSchema, adapter: undefined },
  Servo: { defaults: ServoDefaults as NodeDefaults, schema: ServoSchema, adapter: undefined },
  Smooth: { defaults: SmoothDefaults as NodeDefaults, schema: SmoothSchema, adapter: undefined },
  Stepper: { defaults: StepperDefaults as NodeDefaults, schema: StepperSchema, adapter: undefined },
  Switch: { defaults: SwitchDefaults as NodeDefaults, schema: SwitchSchema, adapter: undefined },
  Tilt: { defaults: TiltDefaults as NodeDefaults, schema: TiltSchema, adapter: undefined },
  Trigger: { defaults: TriggerDefaults as NodeDefaults, schema: TriggerSchema, adapter: undefined },
  Vibration: { defaults: VibrationDefaults as NodeDefaults, schema: VibrationSchema, adapter: undefined },
} satisfies Record<ComponentType, NodeCatalogEntry>;
