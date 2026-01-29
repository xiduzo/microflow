import type { Template } from "./types";

// Beginner templates
import { blink } from "./beginner/blink";
import { buttonLed } from "./beginner/button-led";
import { clickCounter } from "./beginner/click-counter";
import { clapSwitch } from "./beginner/clap-switch";
import { doorbell } from "./beginner/doorbell";
import { heartbeat } from "./beginner/heartbeat";
import { knobLed } from "./beginner/knob-led";
import { lightMeter } from "./beginner/light-meter";
import { nightLight } from "./beginner/night-light";
import { panicButton } from "./beginner/panic-button";
import { reactionTimer } from "./beginner/reaction-timer";
import { toggleSwitch } from "./beginner/toggle-switch";
import { trafficLight } from "./beginner/traffic-light";

// Intermediate templates
import { theremin } from "./intermediate/theremin";
import { roboticArm } from "./intermediate/robotic-arm";
import { sunriseAlarm } from "./intermediate/sunrise-alarm";
import { breathingLed } from "./intermediate/breathing-led";
import { servoSweep } from "./intermediate/servo-sweep";
import { plantMonitor } from "./intermediate/plant-monitor";
import { dimmerSwitch } from "./intermediate/dimmer-switch";
import { smoothSensor } from "./intermediate/smooth-sensor";
import { mathCalculator } from "./intermediate/math-calculator";
import { rgbMoodLamp } from "./intermediate/rgb-mood-lamp";

// Advanced templates
import { motionAlarm } from "./advanced/motion-alarm";
import { simonSays } from "./advanced/simon-says";
import { smartNightlight } from "./advanced/smart-nightlight";
import { petFeeder } from "./advanced/pet-feeder";
import { weatherStation } from "./advanced/weather-station";
import { smartHomeHub } from "./advanced/smart-home-hub";
import { parkingSensor } from "./advanced/parking-sensor";
import { proximityAlarm } from "./advanced/proximity-alarm";
import { xorGame } from "./advanced/xor-game";
import { knockDetector } from "./advanced/knock-detector";
import { securityGate } from "./advanced/security-gate";

export type { Template } from "./types";

export const TEMPLATES: Template[] = [
  // Beginner
  blink,
  buttonLed,
  clickCounter,
  clapSwitch,
  doorbell,
  heartbeat,
  knobLed,
  lightMeter,
  nightLight,
  panicButton,
  reactionTimer,
  toggleSwitch,
  trafficLight,

  // Intermediate
  theremin,
  roboticArm,
  sunriseAlarm,
  breathingLed,
  servoSweep,
  plantMonitor,
  dimmerSwitch,
  smoothSensor,
  mathCalculator,
  rgbMoodLamp,

  // Advanced
  motionAlarm,
  simonSays,
  smartNightlight,
  petFeeder,
  weatherStation,
  smartHomeHub,
  parkingSensor,
  proximityAlarm,
  xorGame,
  knockDetector,
  securityGate,
];
