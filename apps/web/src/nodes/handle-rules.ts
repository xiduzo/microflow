// The Handle Rule of every Component, by type: one explicit line per catalog
// entry, like the Rust registry. A new entry in `node-components.json` does not
// compile until it has a line here.
//
// Internal to the nodes vertical. Code outside it asks `nodes/handles.ts`.

import type { COMPONENT_IMPL, ComponentType } from "./component-types.generated";
import type { HandleLayout, HandleRule, Settings } from "./_base/handle-rule";

import { handles as button } from "./button/button.handles";
import { handles as calculate } from "./calculate/calculate.handles";
import { handles as compare } from "./compare/compare.handles";
import { handles as constant } from "./constant/constant.handles";
import { handles as counter } from "./counter/counter.handles";
import { handles as delay } from "./delay/delay.handles";
import { handles as figma } from "./figma/figma.handles";
import { handles as fn } from "./function/function.handles";
import { handles as gate } from "./gate/gate.handles";
import { handles as hotkey } from "./hotkey/hotkey.handles";
import { handles as i2cDevice } from "./i2c-device/i2c-device.handles";
import { handles as interval } from "./interval/interval.handles";
import { handles as led } from "./led/led.handles";
import { handles as llm } from "./llm/llm.handles";
import { handles as matrix } from "./matrix/matrix.handles";
import { handles as midi } from "./midi/midi.handles";
import { handles as monitor } from "./monitor/monitor.handles";
import { handles as motion } from "./motion/motion.handles";
import { handles as mqtt } from "./mqtt/mqtt.handles";
import { handles as music } from "./music/music.handles";
import { handles as note } from "./note/note.handles";
import { handles as oscillator } from "./oscillator/oscillator.handles";
import { handles as piezo } from "./piezo/piezo.handles";
import { handles as pixel } from "./pixel/pixel.handles";
import { handles as pn532 } from "./pn532/pn532.handles";
import { handles as proximity } from "./proximity/proximity.handles";
import { handles as rangeMap } from "./range-map/range-map.handles";
import { handles as relay } from "./relay/relay.handles";
import { handles as rgb } from "./rgb/rgb.handles";
import { handles as sensor } from "./sensor/sensor.handles";
import { handles as servo } from "./servo/servo.handles";
import { handles as smooth } from "./smooth/smooth.handles";
import { handles as stepper } from "./stepper/stepper.handles";
import { handles as switchRule } from "./switch/switch.handles";
import { handles as trigger } from "./trigger/trigger.handles";

/** The entry whose rule a type uses: itself, or for a Variant its parent. */
type RuleOwner<T extends ComponentType> = Extract<(typeof COMPONENT_IMPL)[T], ComponentType>;

// A Variant has its parent's wire interface and renders through its parent's
// component, so it must share the parent's rule (`Force` → `sensor`).
const HANDLE_RULES = {
  Button: button,
  Calculate: calculate,
  Compare: compare,
  Constant: constant,
  Counter: counter,
  Delay: delay,
  Figma: figma,
  Force: sensor,
  Function: fn,
  Gate: gate,
  HallEffect: sensor,
  Hotkey: hotkey,
  I2cDevice: i2cDevice,
  Interval: interval,
  Ldr: sensor,
  Led: led,
  Llm: llm,
  Matrix: matrix,
  Midi: midi,
  Monitor: monitor,
  Motion: motion,
  Mqtt: mqtt,
  Music: music,
  Note: note,
  Oscillator: oscillator,
  Piezo: piezo,
  Pixel: pixel,
  Pn532: pn532,
  Potentiometer: sensor,
  Proximity: proximity,
  RangeMap: rangeMap,
  Relay: relay,
  Rgb: rgb,
  Sensor: sensor,
  Servo: servo,
  Smooth: smooth,
  Stepper: stepper,
  Switch: switchRule,
  Tilt: sensor,
  Trigger: trigger,
  Vibration: led,
} satisfies { [T in ComponentType]: HandleRule<RuleOwner<T>> };

/** The Handle Rule of a type. A Variant's Ports and Emits are its parent's, so the parent's rule is its own. */
export function handleRule<T extends ComponentType>(type: T): HandleRule<T> {
  return HANDLE_RULES[type] as unknown as HandleRule<T>;
}

/**
 * A node's handles, with how each is drawn, for its current settings.
 *
 * `data` is read as it is found in the flow document; anything that is not an
 * object counts as no settings at all. Whatever the rule returns, every handle
 * that comes out has a non-empty string id that is unique on its side.
 */
export function handleLayout<T extends ComponentType>(type: T, data: unknown): HandleLayout<T> {
  const settings: Settings = data !== null && typeof data === "object" ? (data as Settings) : {};
  const layout = handleRule(type).layout(settings);
  return { ports: distinct(layout.ports), emits: distinct(layout.emits) };
}

/** Drop a handle without a usable id, and a later handle that repeats an id. */
function distinct<H extends { id: string }>(handles: readonly H[]): readonly H[] {
  const ids = new Set<string>();
  const kept = handles.filter((handle) => {
    if (typeof handle.id !== "string" || handle.id === "" || ids.has(handle.id)) return false;
    ids.add(handle.id);
    return true;
  });
  return kept.length === handles.length ? handles : kept;
}
