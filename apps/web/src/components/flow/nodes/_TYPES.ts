import { Matrix } from "./matrix/matrix";
import { Monitor } from "./monitor";
import { Motion } from "./motion";
// import { Mqtt } from "./mqtt";
import { Oscillator } from "./oscillator";
import { Piezo } from "./piezo/piezo";
import { Pixel } from "./pixel/pixel";
import { Proximity } from "./proximity";
import { Rgb } from "./rgb";
import { RangeMap } from "./range-map";
import { Relay } from "./relay";
import { Sensor } from "./sensor";
import { Servo } from "./servo";
import { Smooth } from "./smooth";
import { Switch } from "./switch";
import { Trigger } from "./trigger";
import { Button } from ".//button";
import { Constant } from "./constant";
import { Counter } from "./counter";
import { Delay } from "./delay";
// import { Figma } from "./figma";
import { Gate } from "./gate";
import { Interval } from "./interval";
import { Led } from "./led";
import { Llm } from "./llm";
import type { NodeTypes } from "@xyflow/react";

export const NODE_TYPES: NodeTypes = {
  Button: Button,
  Constant: Constant,
  Counter: Counter,
  Delay: Delay,
  //   Figma: Figma,
  Gate: Gate,
  Interval: Interval,
  Led: Led,
  Llm: Llm,
  Matrix: Matrix,
  Monitor: Monitor,
  Motion: Motion,
  //   Mqtt: Mqtt,
  Oscillator: Oscillator,
  Piezo: Piezo,
  Pixel: Pixel,
  Proximity: Proximity,
  Rgb: Rgb,
  RangeMap: RangeMap,
  Relay: Relay,
  Sensor: Sensor,
  Servo: Servo,
  Smooth: Smooth,
  Switch: Switch,
  Trigger: Trigger,
};
