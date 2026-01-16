import { Matrix } from "./matrix/matrix";
import { Monitor } from "./monitor/monitor";
import { Motion } from "./motion/motion";
// import { Mqtt } from "./mqtt";
import { Oscillator } from "./oscillator/oscillator";
import { Piezo } from "./piezo/piezo";
import { Pixel } from "./pixel/pixel";
import { Proximity } from "./proximity/proximity";
import { Rgb } from "./rgb/rgb";
import { RangeMap } from "./range-map/range-map";
import { Relay } from "./relay/relay";
import {
  Force,
  HallEffect,
  Ldr,
  Potentiometer,
  Sensor,
  Tilt,
} from "./sensor/sensor";
import { Servo } from "./servo/servo";
import { Smooth } from "./smooth/smooth";
import { Switch } from "./switch/switch";
import { Trigger } from "./trigger/trigger";
import { Button } from ".//button/button";
import { Constant } from "./constant/constant";
import { Counter } from "./counter/counter";
import { Delay } from "./delay/delay";
// import { Figma } from "./figma";
import { Gate } from "./gate/gate";
import { Interval } from "./interval/interval";
import { Led } from "./led/led";
import { Llm } from "./llm/llm";
import type { NodeTypes } from "@xyflow/react";
import { Compare } from "./compare/compare";
import { Calculate } from "./calculate/calculate";

export const NODE_TYPES: NodeTypes = {
  Button: Button,
  Calculate: Calculate,
  Compare: Compare,
  Constant: Constant,
  Counter: Counter,
  Delay: Delay,
  Force: Force,
  Gate: Gate,
  HallEffect: HallEffect,
  Interval: Interval,
  Ldr: Ldr,
  Led: Led,
  Llm: Llm,
  Matrix: Matrix,
  Monitor: Monitor,
  Motion: Motion,
  Oscillator: Oscillator,
  Piezo: Piezo,
  Pixel: Pixel,
  Potentiometer: Potentiometer,
  Proximity: Proximity,
  RangeMap: RangeMap,
  Relay: Relay,
  Rgb: Rgb,
  Sensor: Sensor,
  Servo: Servo,
  Smooth: Smooth,
  Switch: Switch,
  Tilt: Tilt,
  Trigger: Trigger,
};
