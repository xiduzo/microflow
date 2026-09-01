import type { FlowNode } from "@microflow/collab";
import type { ComponentType } from "@/components/flow/nodes/_base/_base.types";
import { resolveNodeData } from "@/lib/node-data";
import type { Template } from "./types";

export type { Template } from "./types";

/**
 * Author a template node as its type's registry defaults plus a small override
 * patch — the same defaults+schema path Ask AI writes through
 * (`lib/node-data.ts`), so a template cannot ship data the node's own schema
 * rejects. Overrides are the fields a template deliberately sets away from the
 * defaults (a pin, a topic, a custom label); everything else tracks the
 * registry.
 */
function node(
  id: string,
  type: ComponentType,
  position: { x: number; y: number },
  overrides: Record<string, unknown> = {},
): FlowNode {
  const resolved = resolveNodeData(type, overrides);
  if (!resolved.ok) throw new Error(`template node '${id}': ${resolved.error}`);
  return { id, type, position, data: resolved.data };
}

// The docs tutorials wire buttons as pullups on pin 2, not the picker default.
const BUTTON = { pin: 2, isPullup: true };
// A sine wave centred on the byte range (shift ± amplitude = 1..255).
const BYTE_WAVE = { amplitude: 127, shift: 128 };
const MOVING_AVERAGE = { instance: "MovingAverage", type: "movingAverage", windowSize: 10 };

// ===== BASIC =====

const blink: Template = {
  id: "blink",
  name: "Blink",
  description: "Flash an LED on and off at a regular interval",
  difficulty: "beginner",
  categories: ["Basic"],
  nodes: [
    node("interval-1", "Interval", { x: 0, y: 0 }),
    node("led-1", "Led", { x: 440, y: 0 }),
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
    node("button-1", "Button", { x: 0, y: 0 }, BUTTON),
    node("led-1", "Led", { x: 440, y: 0 }),
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
    node("oscillator-1", "Oscillator", { x: 0, y: 0 }, { ...BYTE_WAVE, period: 2000 }),
    node("monitor-1", "Monitor", { x: 440, y: 0 }),
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
    node("switch-1", "Switch", { x: 0, y: 0 }),
    node("led-1", "Led", { x: 440, y: 0 }),
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
    node("button-1", "Button", { x: 0, y: 0 }, BUTTON),
    node("piezo-1", "Piezo", { x: 440, y: 0 }, { pin: 8 }),
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
    node("motion-1", "Motion", { x: 0, y: 0 }, { pin: 7 }),
    node("delay-1", "Delay", { x: 440, y: 0 }, { delay: 500 }),
    node("piezo-1", "Piezo", { x: 880, y: 0 }, { pin: 8 }),
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
    node("motion-1", "Motion", { x: 0, y: 0 }, { pin: 7 }),
    node("relay-1", "Relay", { x: 440, y: 0 }),
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
    node("pot-1", "Potentiometer", { x: 0, y: 0 }),
    node("rangemap-1", "RangeMap", { x: 440, y: 0 }, { to: { min: 0, max: 180 } }),
    node("servo-1", "Servo", { x: 880, y: 0 }, { pin: 9 }),
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
    node("ldr-1", "Ldr", { x: 0, y: 0 }),
    node("smooth-1", "Smooth", { x: 440, y: 0 }, MOVING_AVERAGE),
    node("monitor-1", "Monitor", { x: 880, y: 0 }),
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
    node("oscillator-1", "Oscillator", { x: 0, y: 0 }, { ...BYTE_WAVE, period: 3000 }),
    node("rangemap-1", "RangeMap", { x: 440, y: 0 }, { from: { min: 1, max: 255 }, to: { min: 0, max: 180 } }),
    node("servo-1", "Servo", { x: 880, y: 0 }, { pin: 9 }),
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
    node("osc-red", "Oscillator", { x: 0, y: -560 }, { ...BYTE_WAVE, period: 5000, label: "Red Channel" }),
    node("osc-green", "Oscillator", { x: 0, y: 0 }, { ...BYTE_WAVE, period: 5000, phase: 120, label: "Green Channel" }),
    node("osc-blue", "Oscillator", { x: 0, y: 560 }, { ...BYTE_WAVE, period: 5000, phase: 240, label: "Blue Channel" }),
    node("rgb-1", "Rgb", { x: 440, y: 0 }),
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
    node("button-1", "Button", { x: 0, y: 0 }, BUTTON),
    node("mqtt-1", "Mqtt", { x: 440, y: 0 }, { direction: "publish", topic: "home/button" }),
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
    node("interval-1", "Interval", { x: 0, y: 0 }),
    node("counter-1", "Counter", { x: 440, y: 0 }),
    node("matrix-1", "Matrix", { x: 880, y: 0 }, {
      shapes: [
        ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
        ["01100110", "10011001", "10000001", "10000001", "01000010", "00100100", "00011000", "00000000"],
        ["00111100", "01000010", "10100101", "10000001", "10100101", "10011001", "01000010", "00111100"],
      ],
    }),
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
    node("interval-1", "Interval", { x: 0, y: 0 }, { interval: 2000 }),
    node("counter-1", "Counter", { x: 440, y: 0 }),
    node("pixel-1", "Pixel", { x: 880, y: 0 }, {
      length: 8,
      presets: [
        ["#FF0000", "#FF0000", "#FF0000", "#FF0000", "#FF0000", "#FF0000", "#FF0000", "#FF0000"],
        ["#00FF00", "#00FF00", "#00FF00", "#00FF00", "#00FF00", "#00FF00", "#00FF00", "#00FF00"],
        ["#0000FF", "#0000FF", "#0000FF", "#0000FF", "#0000FF", "#0000FF", "#0000FF", "#0000FF"],
        ["#FF0000", "#FF7F00", "#FFFF00", "#00FF00", "#0000FF", "#4B0082", "#9400D3", "#FFFFFF"],
      ],
    }),
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
    node("pot-1", "Potentiometer", { x: 0, y: 0 }),
    node("compare-1", "Compare", { x: 440, y: 0 }, { validator: "number", subValidator: "greater than", number: 512 }),
    node("led-1", "Led", { x: 880, y: 0 }, { pin: 9 }),
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
    node("button-1", "Button", { x: 0, y: -280 }, { ...BUTTON, label: "Button A" }),
    node("button-2", "Button", { x: 0, y: 280 }, { ...BUTTON, pin: 3, label: "Button B" }),
    node("gate-1", "Gate", { x: 440, y: 0 }),
    node("led-1", "Led", { x: 880, y: 0 }),
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
    node("button-1", "Button", { x: 0, y: 0 }, BUTTON),
    node("counter-1", "Counter", { x: 440, y: 0 }),
    node("monitor-1", "Monitor", { x: 880, y: 0 }, { type: "raw" }),
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
    node("sensor-1", "Sensor", { x: 0, y: -280 }, { label: "Sensor A" }),
    node("sensor-2", "Sensor", { x: 0, y: 280 }, { pin: "A1", label: "Sensor B" }),
    node("calculate-1", "Calculate", { x: 440, y: 0 }),
    node("monitor-1", "Monitor", { x: 880, y: 0 }),
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
    node("sensor-1", "Sensor", { x: 0, y: 0 }),
    node("trigger-1", "Trigger", { x: 440, y: 0 }, { behaviour: "increasing", threshold: 50 }),
    node("piezo-1", "Piezo", { x: 880, y: 0 }, { pin: 8 }),
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
    node("pot-1", "Potentiometer", { x: 0, y: 0 }),
    node("rangemap-1", "RangeMap", { x: 440, y: 0 }, { to: { min: 0, max: 255 } }),
    node("led-1", "Led", { x: 880, y: 0 }, { pin: 9 }),
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
    node("pot-1", "Potentiometer", { x: 0, y: 0 }),
    node("monitor-raw", "Monitor", { x: 440, y: -560 }, { label: "Raw" }),
    node("smooth-1", "Smooth", { x: 440, y: 0 }, MOVING_AVERAGE),
    node("monitor-smooth", "Monitor", { x: 880, y: -560 }, { label: "Smoothed" }),
    node("rangemap-1", "RangeMap", { x: 880, y: 0 }, { to: { min: 0, max: 255 } }),
    node("led-1", "Led", { x: 1320, y: 0 }, { pin: 9 }),
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
    node("pot-1", "Potentiometer", { x: 0, y: 0 }),
    node("mqtt-1", "Mqtt", { x: 440, y: 0 }, { direction: "publish", topic: "figma/pot_value" }),
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
    node("mqtt-1", "Mqtt", { x: 0, y: 0 }, { topic: "figma/led_brightness" }),
    node("led-1", "Led", { x: 440, y: 0 }, { pin: 9 }),
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
    node("button-1", "Button", { x: 0, y: 0 }, BUTTON),
    node("delay-1", "Delay", { x: 440, y: 0 }, { delay: 30, forgetPrevious: true }),
    node("counter-1", "Counter", { x: 880, y: 0 }),
    node("monitor-1", "Monitor", { x: 1320, y: 0 }, { type: "raw" }),
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
    node("constant-1", "Constant", { x: 0, y: 0 }, { value: 512, label: "Fake Sensor" }),
    node("rangemap-1", "RangeMap", { x: 440, y: 0 }, { to: { min: 0, max: 255 } }),
    node("monitor-1", "Monitor", { x: 880, y: 0 }),
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
    node("constant-1", "Constant", { x: 0, y: 0 }, { value: 200, label: "Target Steps" }),
    node("stepper-1", "Stepper", { x: 440, y: 0 }, { interface: "four_wire" }),
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
    node("motion-1", "Motion", { x: 0, y: -280 }, { pin: 7 }),
    node("button-1", "Button", { x: 0, y: 280 }, BUTTON),
    node("gate-1", "Gate", { x: 440, y: 0 }, { gate: "or" }),
    node("led-1", "Led", { x: 880, y: -280 }, { label: "Room Light" }),
    node("relay-1", "Relay", { x: 880, y: 280 }, { label: "Main Switch" }),
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
    node("ldr-1", "Ldr", { x: 0, y: -280 }, { label: "Light Sensor" }),
    node("sensor-1", "Sensor", { x: 0, y: 280 }, { pin: "A1", label: "Temp Sensor" }),
    node("smooth-1", "Smooth", { x: 440, y: -280 }, MOVING_AVERAGE),
    node("monitor-1", "Monitor", { x: 880, y: -280 }, { label: "Light Level" }),
    node("monitor-2", "Monitor", { x: 880, y: 280 }, { label: "Temperature" }),
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
    node("motion-1", "Motion", { x: 0, y: -420 }, { pin: 7 }),
    node("proximity-1", "Proximity", { x: 0, y: 420 }),
    node("compare-1", "Compare", { x: 440, y: 420 }, { validator: "number", subValidator: "less than", number: 50 }),
    node("gate-1", "Gate", { x: 880, y: 0 }, { gate: "or" }),
    node("relay-1", "Relay", { x: 1320, y: -280 }, { label: "Door Lock" }),
    node("piezo-1", "Piezo", { x: 1320, y: 280 }, { pin: 8 }),
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
