import type { Template } from "./types";
import {
  buttonData,
  ledData,
  intervalData,
  sensorData,
  potentiometerData,
  ldrData,
  monitorData,
  rangeMapData,
  servoData,
  compareNumberData,
  gateData,
  smoothData,
  triggerData,
  calculateData,
  rgbData,
  relayData,
  switchData,
  proximityData,
  oscillatorData,
  motionData,
  delayData,
  piezoData,
  counterData,
  constantData,
  mqttPublishData,
  mqttSubscribeData,
  stepperData,
  matrixData,
  pixelData,
} from "./data-factories";

export type { Template } from "./types";

// ===== BASIC =====

const blink: Template = {
  id: "blink",
  name: "Blink",
  description: "Flash an LED on and off at a regular interval",
  difficulty: "beginner",
  categories: ["Basic"],
  nodes: [
    { id: "interval-1", type: "Interval", position: { x: 0, y: 0 }, data: intervalData(1000) },
    { id: "led-1", type: "Led", position: { x: 280, y: 0 }, data: ledData(13) },
  ],
  edges: [
    { id: "e1", source: "interval-1", target: "led-1", sourceHandle: "event", targetHandle: "toggle" },
  ],
};

const buttonLed: Template = {
  id: "button-led",
  name: "Button LED",
  description: "Press a button to toggle an LED on and off",
  difficulty: "beginner",
  categories: ["Basic"],
  nodes: [
    { id: "button-1", type: "Button", position: { x: 0, y: 0 }, data: buttonData() },
    { id: "led-1", type: "Led", position: { x: 280, y: 0 }, data: ledData(13) },
  ],
  edges: [
    { id: "e1", source: "button-1", target: "led-1", sourceHandle: "event", targetHandle: "toggle" },
  ],
};

const waveMonitor: Template = {
  id: "wave-monitor",
  name: "Wave Monitor",
  description: "Visualize a smooth sine wave on the monitor in real time",
  difficulty: "beginner",
  categories: ["Basic"],
  nodes: [
    { id: "oscillator-1", type: "Oscillator", position: { x: 0, y: 0 }, data: oscillatorData("sinus", 2000) },
    { id: "monitor-1", type: "Monitor", position: { x: 280, y: 0 }, data: monitorData("graph") },
  ],
  edges: [
    { id: "e1", source: "oscillator-1", target: "monitor-1", sourceHandle: "value", targetHandle: "value" },
  ],
};

// ===== DIGITAL =====

const switchLed: Template = {
  id: "switch-led",
  name: "Switch LED",
  description: "Use a toggle switch to control an LED",
  difficulty: "beginner",
  categories: ["Digital"],
  nodes: [
    { id: "switch-1", type: "Switch", position: { x: 0, y: 0 }, data: switchData(2) },
    { id: "led-1", type: "Led", position: { x: 280, y: 0 }, data: ledData(13) },
  ],
  edges: [
    { id: "e1", source: "switch-1", target: "led-1", sourceHandle: "event", targetHandle: "toggle" },
  ],
};

const doorbell: Template = {
  id: "doorbell",
  name: "Doorbell",
  description: "Press a button to make the piezo buzzer sound",
  difficulty: "beginner",
  categories: ["Digital"],
  nodes: [
    { id: "button-1", type: "Button", position: { x: 0, y: 0 }, data: buttonData() },
    { id: "piezo-1", type: "Piezo", position: { x: 280, y: 0 }, data: piezoData(8) },
  ],
  edges: [
    { id: "e1", source: "button-1", target: "piezo-1", sourceHandle: "event", targetHandle: "trigger" },
  ],
};

const motionAlarm: Template = {
  id: "motion-alarm",
  name: "Motion Alarm",
  description: "Trigger a delayed buzzer alarm when motion is detected",
  difficulty: "intermediate",
  categories: ["Digital"],
  nodes: [
    { id: "motion-1", type: "Motion", position: { x: 0, y: 0 }, data: motionData(7) },
    { id: "delay-1", type: "Delay", position: { x: 280, y: 0 }, data: delayData(500) },
    { id: "piezo-1", type: "Piezo", position: { x: 560, y: 0 }, data: piezoData(8) },
  ],
  edges: [
    { id: "e1", source: "motion-1", target: "delay-1", sourceHandle: "event", targetHandle: "trigger" },
    { id: "e2", source: "delay-1", target: "piezo-1", sourceHandle: "event", targetHandle: "trigger" },
  ],
};

const motionRelay: Template = {
  id: "motion-relay",
  name: "Motion-Activated Relay",
  description: "Automatically switch a relay on when motion is detected",
  difficulty: "beginner",
  categories: ["Digital"],
  nodes: [
    { id: "motion-1", type: "Motion", position: { x: 0, y: 0 }, data: motionData(7) },
    { id: "relay-1", type: "Relay", position: { x: 280, y: 0 }, data: relayData(10) },
  ],
  edges: [
    { id: "e1", source: "motion-1", target: "relay-1", sourceHandle: "true", targetHandle: "true" },
    { id: "e2", source: "motion-1", target: "relay-1", sourceHandle: "false", targetHandle: "false" },
  ],
};

// ===== ANALOG =====

const knobServo: Template = {
  id: "knob-servo",
  name: "Knob Servo",
  description: "Control a servo motor's position with a potentiometer knob",
  difficulty: "intermediate",
  categories: ["Analog"],
  nodes: [
    { id: "pot-1", type: "Potentiometer", position: { x: 0, y: 0 }, data: potentiometerData("A0") },
    { id: "rangemap-1", type: "RangeMap", position: { x: 280, y: 0 }, data: rangeMapData({ min: 0, max: 1023 }, { min: 0, max: 180 }) },
    { id: "servo-1", type: "Servo", position: { x: 560, y: 0 }, data: servoData(9) },
  ],
  edges: [
    { id: "e1", source: "pot-1", target: "rangemap-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e2", source: "rangemap-1", target: "servo-1", sourceHandle: "to", targetHandle: "value" },
  ],
};

const lightMonitor: Template = {
  id: "light-monitor",
  name: "Light Monitor",
  description: "Smooth and visualize ambient light readings from an LDR sensor",
  difficulty: "beginner",
  categories: ["Analog"],
  nodes: [
    { id: "ldr-1", type: "Ldr", position: { x: 0, y: 0 }, data: ldrData("A0") },
    { id: "smooth-1", type: "Smooth", position: { x: 280, y: 0 }, data: smoothData("movingAverage", 10) },
    { id: "monitor-1", type: "Monitor", position: { x: 560, y: 0 }, data: monitorData("graph") },
  ],
  edges: [
    { id: "e1", source: "ldr-1", target: "smooth-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e2", source: "smooth-1", target: "monitor-1", sourceHandle: "value", targetHandle: "value" },
  ],
};

const servoSweep: Template = {
  id: "servo-sweep",
  name: "Servo Sweep",
  description: "Automatically sweep a servo back and forth using a sine wave oscillator",
  difficulty: "intermediate",
  categories: ["Analog"],
  nodes: [
    { id: "oscillator-1", type: "Oscillator", position: { x: 0, y: 0 }, data: oscillatorData("sinus", 3000) },
    { id: "rangemap-1", type: "RangeMap", position: { x: 280, y: 0 }, data: rangeMapData({ min: 1, max: 255 }, { min: 0, max: 180 }) },
    { id: "servo-1", type: "Servo", position: { x: 560, y: 0 }, data: servoData(9) },
  ],
  edges: [
    { id: "e1", source: "oscillator-1", target: "rangemap-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e2", source: "rangemap-1", target: "servo-1", sourceHandle: "to", targetHandle: "value" },
  ],
};

const rgbMoodLamp: Template = {
  id: "rgb-mood-lamp",
  name: "RGB Mood Lamp",
  description: "Slowly cycle through colors on an RGB LED using three phase-offset oscillators",
  difficulty: "intermediate",
  categories: ["Analog"],
  nodes: [
    { id: "osc-red", type: "Oscillator", position: { x: 0, y: -160 }, data: { ...oscillatorData("sinus", 5000), phase: 0, label: "Red Channel" } },
    { id: "osc-green", type: "Oscillator", position: { x: 0, y: 0 }, data: { ...oscillatorData("sinus", 5000), phase: 120, label: "Green Channel" } },
    { id: "osc-blue", type: "Oscillator", position: { x: 0, y: 160 }, data: { ...oscillatorData("sinus", 5000), phase: 240, label: "Blue Channel" } },
    { id: "rgb-1", type: "Rgb", position: { x: 280, y: 0 }, data: rgbData({ red: 9, green: 10, blue: 11 }) },
  ],
  edges: [
    { id: "e1", source: "osc-red", target: "rgb-1", sourceHandle: "value", targetHandle: "red" },
    { id: "e2", source: "osc-green", target: "rgb-1", sourceHandle: "value", targetHandle: "green" },
    { id: "e3", source: "osc-blue", target: "rgb-1", sourceHandle: "value", targetHandle: "blue" },
  ],
};

// ===== COMMUNICATION =====

const mqttButton: Template = {
  id: "mqtt-button",
  name: "MQTT Button",
  description: "Publish an MQTT message each time a button is pressed",
  difficulty: "intermediate",
  categories: ["Communication"],
  nodes: [
    { id: "button-1", type: "Button", position: { x: 0, y: 0 }, data: buttonData() },
    { id: "mqtt-1", type: "Mqtt", position: { x: 280, y: 0 }, data: mqttPublishData("home/button") },
  ],
  edges: [
    { id: "e1", source: "button-1", target: "mqtt-1", sourceHandle: "event", targetHandle: "trigger" },
  ],
};

const matrixCounter: Template = {
  id: "matrix-counter",
  name: "Matrix Counter",
  description: "Count up every second and cycle through shapes on an LED matrix display",
  difficulty: "intermediate",
  categories: ["Communication"],
  nodes: [
    { id: "interval-1", type: "Interval", position: { x: 0, y: 0 }, data: intervalData(1000) },
    { id: "counter-1", type: "Counter", position: { x: 280, y: 0 }, data: counterData() },
    { id: "matrix-1", type: "Matrix", position: { x: 560, y: 0 }, data: matrixData() },
  ],
  edges: [
    { id: "e1", source: "interval-1", target: "counter-1", sourceHandle: "event", targetHandle: "increment" },
    { id: "e2", source: "counter-1", target: "matrix-1", sourceHandle: "value", targetHandle: "value" },
  ],
};

const pixelStrip: Template = {
  id: "pixel-strip",
  name: "Pixel Strip",
  description: "Cycle through color presets on a NeoPixel LED strip at a regular interval",
  difficulty: "intermediate",
  categories: ["Communication"],
  nodes: [
    { id: "interval-1", type: "Interval", position: { x: 0, y: 0 }, data: intervalData(2000) },
    { id: "counter-1", type: "Counter", position: { x: 280, y: 0 }, data: counterData() },
    { id: "pixel-1", type: "Pixel", position: { x: 560, y: 0 }, data: pixelData(11, 8) },
  ],
  edges: [
    { id: "e1", source: "interval-1", target: "counter-1", sourceHandle: "event", targetHandle: "increment" },
    { id: "e2", source: "counter-1", target: "pixel-1", sourceHandle: "value", targetHandle: "value" },
  ],
};

// ===== CONTROL STRUCTURES =====

const thresholdAlert: Template = {
  id: "threshold-alert",
  name: "Threshold Alert",
  description: "Light up an LED when a potentiometer reading crosses the 512 threshold",
  difficulty: "intermediate",
  categories: ["Control structures"],
  nodes: [
    { id: "pot-1", type: "Potentiometer", position: { x: 0, y: 0 }, data: potentiometerData("A0") },
    { id: "compare-1", type: "Compare", position: { x: 280, y: 0 }, data: compareNumberData("greater than", 512) },
    { id: "led-1", type: "Led", position: { x: 560, y: 0 }, data: ledData(9) },
  ],
  edges: [
    { id: "e1", source: "pot-1", target: "compare-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e2", source: "compare-1", target: "led-1", sourceHandle: "true", targetHandle: "true" },
    { id: "e3", source: "compare-1", target: "led-1", sourceHandle: "false", targetHandle: "false" },
  ],
};

const andGate: Template = {
  id: "and-gate",
  name: "AND Gate",
  description: "LED only lights up when both buttons are held down simultaneously",
  difficulty: "intermediate",
  categories: ["Control structures"],
  nodes: [
    { id: "button-1", type: "Button", position: { x: 0, y: -80 }, data: { ...buttonData(2), label: "Button A" } },
    { id: "button-2", type: "Button", position: { x: 0, y: 80 }, data: { ...buttonData(3), label: "Button B" } },
    { id: "gate-1", type: "Gate", position: { x: 280, y: 0 }, data: gateData("and") },
    { id: "led-1", type: "Led", position: { x: 560, y: 0 }, data: ledData(13) },
  ],
  edges: [
    { id: "e1", source: "button-1", target: "gate-1", sourceHandle: "true", targetHandle: "value" },
    { id: "e2", source: "button-2", target: "gate-1", sourceHandle: "true", targetHandle: "value" },
    { id: "e3", source: "gate-1", target: "led-1", sourceHandle: "true", targetHandle: "true" },
    { id: "e4", source: "gate-1", target: "led-1", sourceHandle: "false", targetHandle: "false" },
  ],
};

const clickCounter: Template = {
  id: "click-counter",
  name: "Click Counter",
  description: "Count button presses and display the running total on the monitor",
  difficulty: "beginner",
  categories: ["Control structures"],
  nodes: [
    { id: "button-1", type: "Button", position: { x: 0, y: 0 }, data: buttonData() },
    { id: "counter-1", type: "Counter", position: { x: 280, y: 0 }, data: counterData() },
    { id: "monitor-1", type: "Monitor", position: { x: 560, y: 0 }, data: monitorData("raw") },
  ],
  edges: [
    { id: "e1", source: "button-1", target: "counter-1", sourceHandle: "event", targetHandle: "increment" },
    { id: "e2", source: "counter-1", target: "monitor-1", sourceHandle: "value", targetHandle: "value" },
  ],
};

const sensorMath: Template = {
  id: "sensor-math",
  name: "Sensor Math",
  description: "Add readings from two analog sensors and plot the combined value on the monitor",
  difficulty: "intermediate",
  categories: ["Control structures"],
  nodes: [
    { id: "sensor-1", type: "Sensor", position: { x: 0, y: -80 }, data: { ...sensorData("A0"), label: "Sensor A" } },
    { id: "sensor-2", type: "Sensor", position: { x: 0, y: 80 }, data: { ...sensorData("A1"), label: "Sensor B" } },
    { id: "calculate-1", type: "Calculate", position: { x: 280, y: 0 }, data: calculateData("add") },
    { id: "monitor-1", type: "Monitor", position: { x: 560, y: 0 }, data: monitorData("graph") },
  ],
  edges: [
    { id: "e1", source: "sensor-1", target: "calculate-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e2", source: "sensor-2", target: "calculate-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e3", source: "calculate-1", target: "monitor-1", sourceHandle: "value", targetHandle: "value" },
  ],
};

const edgeTrigger: Template = {
  id: "edge-trigger",
  name: "Edge Trigger Alarm",
  description: "Sound a buzzer when a sensor value rises sharply",
  difficulty: "intermediate",
  categories: ["Control structures"],
  nodes: [
    { id: "sensor-1", type: "Sensor", position: { x: 0, y: 0 }, data: sensorData("A0") },
    { id: "trigger-1", type: "Trigger", position: { x: 280, y: 0 }, data: triggerData("increasing", 50, 250) },
    { id: "piezo-1", type: "Piezo", position: { x: 560, y: 0 }, data: piezoData(8) },
  ],
  edges: [
    { id: "e1", source: "sensor-1", target: "trigger-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e2", source: "trigger-1", target: "piezo-1", sourceHandle: "bang", targetHandle: "trigger" },
  ],
};

// ===== LEARN-PATH TEMPLATES (mirror the docs tutorials) =====

const potentiometerFade: Template = {
  id: "fade-with-potentiometer",
  name: "Potentiometer Fade",
  description: "Twist a knob to fade an LED — maps the full 0-1023 analog range to 0-255 brightness",
  difficulty: "beginner",
  categories: ["Analog"],
  nodes: [
    { id: "pot-1", type: "Potentiometer", position: { x: 0, y: 0 }, data: potentiometerData("A0") },
    { id: "rangemap-1", type: "RangeMap", position: { x: 280, y: 0 }, data: rangeMapData({ min: 0, max: 1023 }, { min: 0, max: 255 }) },
    { id: "led-1", type: "Led", position: { x: 560, y: 0 }, data: ledData(9) },
  ],
  edges: [
    { id: "e1", source: "pot-1", target: "rangemap-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e2", source: "rangemap-1", target: "led-1", sourceHandle: "to", targetHandle: "value" },
  ],
};

const smoothSensor: Template = {
  id: "smooth-a-sensor",
  name: "Smooth a Noisy Sensor",
  description: "Compare raw and smoothed potentiometer readings side by side, then fade an LED with the clean signal",
  difficulty: "beginner",
  categories: ["Analog"],
  nodes: [
    { id: "pot-1", type: "Potentiometer", position: { x: 0, y: 0 }, data: potentiometerData("A0") },
    { id: "monitor-raw", type: "Monitor", position: { x: 280, y: -160 }, data: { ...monitorData("graph"), label: "Raw" } },
    { id: "smooth-1", type: "Smooth", position: { x: 280, y: 0 }, data: smoothData("movingAverage", 10) },
    { id: "monitor-smooth", type: "Monitor", position: { x: 560, y: -160 }, data: { ...monitorData("graph"), label: "Smoothed" } },
    { id: "rangemap-1", type: "RangeMap", position: { x: 560, y: 0 }, data: rangeMapData({ min: 0, max: 1023 }, { min: 0, max: 255 }) },
    { id: "led-1", type: "Led", position: { x: 840, y: 0 }, data: ledData(9) },
  ],
  edges: [
    { id: "e1", source: "pot-1", target: "monitor-raw", sourceHandle: "value", targetHandle: "value" },
    { id: "e2", source: "pot-1", target: "smooth-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e3", source: "smooth-1", target: "monitor-smooth", sourceHandle: "value", targetHandle: "value" },
    { id: "e4", source: "smooth-1", target: "rangemap-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e5", source: "rangemap-1", target: "led-1", sourceHandle: "to", targetHandle: "value" },
  ],
};

const sensorToFigma: Template = {
  id: "link-to-figma",
  name: "Sensor to Figma",
  description: "Publish a potentiometer reading on the figma/pot_value topic for the Figma Hardware Bridge",
  difficulty: "intermediate",
  categories: ["Communication"],
  nodes: [
    { id: "pot-1", type: "Potentiometer", position: { x: 0, y: 0 }, data: potentiometerData("A0") },
    { id: "mqtt-1", type: "Mqtt", position: { x: 280, y: 0 }, data: mqttPublishData("figma/pot_value") },
  ],
  edges: [
    { id: "e1", source: "pot-1", target: "mqtt-1", sourceHandle: "value", targetHandle: "trigger" },
  ],
};

const figmaToLed: Template = {
  id: "figma-to-led",
  name: "Figma to LED",
  description: "Subscribe to a Figma Hardware Bridge variable over MQTT and drive an LED's brightness with it",
  difficulty: "intermediate",
  categories: ["Communication"],
  nodes: [
    { id: "mqtt-1", type: "Mqtt", position: { x: 0, y: 0 }, data: mqttSubscribeData("figma/led_brightness") },
    { id: "led-1", type: "Led", position: { x: 280, y: 0 }, data: ledData(9) },
  ],
  edges: [
    { id: "e1", source: "mqtt-1", target: "led-1", sourceHandle: "value", targetHandle: "value" },
  ],
};

const debouncedButton: Template = {
  id: "debounce-button",
  name: "Debounced Button",
  description: "Filter out contact bounce with a 30 ms debounced delay so one press counts exactly once",
  difficulty: "beginner",
  categories: ["Digital"],
  nodes: [
    { id: "button-1", type: "Button", position: { x: 0, y: 0 }, data: buttonData() },
    { id: "delay-1", type: "Delay", position: { x: 280, y: 0 }, data: delayData(30, true) },
    { id: "counter-1", type: "Counter", position: { x: 560, y: 0 }, data: counterData() },
    { id: "monitor-1", type: "Monitor", position: { x: 840, y: 0 }, data: monitorData("raw") },
  ],
  edges: [
    { id: "e1", source: "button-1", target: "delay-1", sourceHandle: "event", targetHandle: "trigger" },
    { id: "e2", source: "delay-1", target: "counter-1", sourceHandle: "event", targetHandle: "increment" },
    { id: "e3", source: "counter-1", target: "monitor-1", sourceHandle: "value", targetHandle: "value" },
  ],
};

const noHardware: Template = {
  id: "no-hardware",
  name: "No-Hardware Playground",
  description: "Stand in for a sensor with a Constant node so a flow can be built and tested without a board",
  difficulty: "beginner",
  categories: ["Basic"],
  nodes: [
    { id: "constant-1", type: "Constant", position: { x: 0, y: 0 }, data: { ...constantData(512), label: "Fake Sensor" } },
    { id: "rangemap-1", type: "RangeMap", position: { x: 280, y: 0 }, data: rangeMapData({ min: 0, max: 1023 }, { min: 0, max: 255 }) },
    { id: "monitor-1", type: "Monitor", position: { x: 560, y: 0 }, data: monitorData("graph") },
  ],
  edges: [
    { id: "e1", source: "constant-1", target: "rangemap-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e2", source: "rangemap-1", target: "monitor-1", sourceHandle: "to", targetHandle: "value" },
  ],
};

const stepperPosition: Template = {
  id: "stepper-h-bridge",
  name: "Stepper Position",
  description: "Move a 4-wire stepper through an H-bridge to a target position set by a constant",
  difficulty: "advanced",
  categories: ["Analog"],
  nodes: [
    { id: "constant-1", type: "Constant", position: { x: 0, y: 0 }, data: { ...constantData(200), label: "Target Steps" } },
    { id: "stepper-1", type: "Stepper", position: { x: 280, y: 0 }, data: stepperData("four_wire") },
  ],
  edges: [
    { id: "e1", source: "constant-1", target: "stepper-1", sourceHandle: "value", targetHandle: "to" },
  ],
};

// ===== FEATURED =====

const smartHomeHub: Template = {
  id: "smart-home-hub",
  name: "Smart Home Hub",
  description: "Automatically control lights and a relay based on motion detection or manual button input",
  difficulty: "advanced",
  categories: ["Digital", "Control structures"],
  nodes: [
    { id: "motion-1", type: "Motion", position: { x: 0, y: -80 }, data: motionData(7) },
    { id: "button-1", type: "Button", position: { x: 0, y: 80 }, data: buttonData() },
    { id: "gate-1", type: "Gate", position: { x: 280, y: 0 }, data: gateData("or") },
    { id: "led-1", type: "Led", position: { x: 560, y: -80 }, data: { ...ledData(13), label: "Room Light" } },
    { id: "relay-1", type: "Relay", position: { x: 560, y: 80 }, data: { ...relayData(10), label: "Main Switch" } },
  ],
  edges: [
    { id: "e1", source: "motion-1", target: "gate-1", sourceHandle: "true", targetHandle: "value" },
    { id: "e2", source: "button-1", target: "gate-1", sourceHandle: "true", targetHandle: "value" },
    { id: "e3", source: "gate-1", target: "led-1", sourceHandle: "true", targetHandle: "true" },
    { id: "e4", source: "gate-1", target: "led-1", sourceHandle: "false", targetHandle: "false" },
    { id: "e5", source: "gate-1", target: "relay-1", sourceHandle: "true", targetHandle: "true" },
    { id: "e6", source: "gate-1", target: "relay-1", sourceHandle: "false", targetHandle: "false" },
  ],
};

const weatherStation: Template = {
  id: "weather-station",
  name: "Weather Station",
  description: "Monitor ambient light and temperature from two sensors with smoothed graph output",
  difficulty: "intermediate",
  categories: ["Analog", "Communication"],
  nodes: [
    { id: "ldr-1", type: "Ldr", position: { x: 0, y: -80 }, data: { ...ldrData("A0"), label: "Light Sensor" } },
    { id: "sensor-1", type: "Sensor", position: { x: 0, y: 80 }, data: { ...sensorData("A1"), label: "Temp Sensor" } },
    { id: "smooth-1", type: "Smooth", position: { x: 280, y: -80 }, data: smoothData("movingAverage", 10) },
    { id: "monitor-1", type: "Monitor", position: { x: 560, y: -80 }, data: { ...monitorData("graph"), label: "Light Level" } },
    { id: "monitor-2", type: "Monitor", position: { x: 560, y: 80 }, data: { ...monitorData("graph"), label: "Temperature" } },
  ],
  edges: [
    { id: "e1", source: "ldr-1", target: "smooth-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e2", source: "smooth-1", target: "monitor-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e3", source: "sensor-1", target: "monitor-2", sourceHandle: "value", targetHandle: "value" },
  ],
};

const securityGate: Template = {
  id: "security-gate",
  name: "Security Gate",
  description: "Trigger an alarm and unlock a relay when motion is detected or an object comes too close",
  difficulty: "advanced",
  categories: ["Digital", "Analog", "Control structures"],
  nodes: [
    { id: "motion-1", type: "Motion", position: { x: 0, y: -120 }, data: motionData(7) },
    { id: "proximity-1", type: "Proximity", position: { x: 0, y: 120 }, data: proximityData("A0") },
    { id: "compare-1", type: "Compare", position: { x: 280, y: 120 }, data: compareNumberData("less than", 50) },
    { id: "gate-1", type: "Gate", position: { x: 560, y: 0 }, data: gateData("or") },
    { id: "relay-1", type: "Relay", position: { x: 840, y: -80 }, data: { ...relayData(10), label: "Door Lock" } },
    { id: "piezo-1", type: "Piezo", position: { x: 840, y: 80 }, data: piezoData(8) },
  ],
  edges: [
    { id: "e1", source: "motion-1", target: "gate-1", sourceHandle: "true", targetHandle: "value" },
    { id: "e2", source: "proximity-1", target: "compare-1", sourceHandle: "value", targetHandle: "value" },
    { id: "e3", source: "compare-1", target: "gate-1", sourceHandle: "true", targetHandle: "value" },
    { id: "e4", source: "gate-1", target: "relay-1", sourceHandle: "true", targetHandle: "true" },
    { id: "e5", source: "gate-1", target: "relay-1", sourceHandle: "false", targetHandle: "false" },
    { id: "e6", source: "gate-1", target: "piezo-1", sourceHandle: "true", targetHandle: "trigger" },
  ],
};

export const TEMPLATES: Template[] = [
  // Basic
  blink,
  buttonLed,
  waveMonitor,
  noHardware,
  // Digital
  switchLed,
  doorbell,
  debouncedButton,
  motionAlarm,
  motionRelay,
  // Analog
  potentiometerFade,
  smoothSensor,
  knobServo,
  lightMonitor,
  servoSweep,
  rgbMoodLamp,
  // stepperPosition — hidden with the Stepper node (see stepper.schema.ts:
  // flashed StandardFirmata has no AccelStepper support, so the motor never moves)
  // Communication
  mqttButton,
  sensorToFigma,
  figmaToLed,
  matrixCounter,
  pixelStrip,
  // Control structures
  thresholdAlert,
  andGate,
  clickCounter,
  sensorMath,
  edgeTrigger,
  // Featured (also appear in their categories above)
  smartHomeHub,
  weatherStation,
  securityGate,
];
