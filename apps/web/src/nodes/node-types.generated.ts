// GENERATED — do not edit. Source: node-components.json. Run `bun run codegen`.
import type { NodeTypes } from "@xyflow/react";
import type { ComponentType } from "./component-types.generated";

import { Button } from "./button/button";
import { Calculate } from "./calculate/calculate";
import { Compare } from "./compare/compare";
import { Constant } from "./constant/constant";
import { Counter } from "./counter/counter";
import { Delay } from "./delay/delay";
import { Figma } from "./figma/figma";
import { Force } from "./force/force";
import { Function } from "./function/function";
import { Gate } from "./gate/gate";
import { HallEffect } from "./hall-effect/hall-effect";
import { Hotkey } from "./hotkey/hotkey";
import { I2cDevice } from "./i2c-device/i2c-device";
import { Interval } from "./interval/interval";
import { Ldr } from "./ldr/ldr";
import { Led } from "./led/led";
import { Llm } from "./llm/llm";
import { Matrix } from "./matrix/matrix";
import { Midi } from "./midi/midi";
import { Monitor } from "./monitor/monitor";
import { Motion } from "./motion/motion";
import { Mqtt } from "./mqtt/mqtt";
import { Music } from "./music/music";
import { Note } from "./note/note";
import { Oscillator } from "./oscillator/oscillator";
import { Piezo } from "./piezo/piezo";
import { Pixel } from "./pixel/pixel";
import { Pn532 } from "./pn532/pn532";
import { Potentiometer } from "./potentiometer/potentiometer";
import { Proximity } from "./proximity/proximity";
import { RangeMap } from "./range-map/range-map";
import { Relay } from "./relay/relay";
import { Rgb } from "./rgb/rgb";
import { Sensor } from "./sensor/sensor";
import { Servo } from "./servo/servo";
import { Smooth } from "./smooth/smooth";
import { Stepper } from "./stepper/stepper";
import { Switch } from "./switch/switch";
import { Tilt } from "./tilt/tilt";
import { Trigger } from "./trigger/trigger";
import { Vibration } from "./vibration/vibration";

// ReactFlow compatibility
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
