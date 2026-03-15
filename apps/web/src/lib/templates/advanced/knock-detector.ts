import type { Template } from "../types";
import { sensorData, triggerData, counterData, ledData, piezoData, delayData } from "../data-factories";

export const knockDetector: Template = {
  id: "knock-detector",
  name: "Knock Sensor",
  description:
    "Detect knocks with a piezo element connected to an analog pin. Triggers a visual and audio response when a knock is detected above the threshold.",
  difficulty: "advanced",
  categories: ["Sensors", "Audio"],
  nodes: [
    {
      id: "sensor-1",
      type: "Sensor",
      position: { x: 100, y: 250 },
      data: { ...sensorData("A0"), label: "Piezo Sensor" },
    },
    {
      id: "trigger-1",
      type: "Trigger",
      position: { x: 450, y: 250 },
      data: { ...triggerData("increasing", 100, 50), label: "Knock Detect" },
    },
    {
      id: "counter-1",
      type: "Counter",
      position: { x: 800, y: 150 },
      data: { ...counterData(), label: "Knock Count" },
    },
    {
      id: "delay-1",
      type: "Delay",
      position: { x: 800, y: 350 },
      data: { ...delayData(100), label: "Debounce" },
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 1100, y: 150 },
      data: { ...ledData(13), label: "Knock LED" },
    },
    {
      id: "piezo-1",
      type: "Piezo",
      position: { x: 1100, y: 350 },
      data: { ...piezoData(8), frequency: 1000, duration: 50 },
    },
  ],
  edges: [
    {
      id: "e-sensor-trigger",
      source: "sensor-1",
      target: "trigger-1",
      sourceHandle: "change",
      targetHandle: "signal",
      type: "animated",
    },
    {
      id: "e-trigger-counter",
      source: "trigger-1",
      target: "counter-1",
      sourceHandle: "bang",
      targetHandle: "increment",
      type: "animated",
    },
    {
      id: "e-trigger-delay",
      source: "trigger-1",
      target: "delay-1",
      sourceHandle: "bang",
      targetHandle: "signal",
      type: "animated",
    },
    {
      id: "e-trigger-led",
      source: "trigger-1",
      target: "led-1",
      sourceHandle: "bang",
      targetHandle: "toggle",
      type: "animated",
    },
    {
      id: "e-delay-piezo",
      source: "delay-1",
      target: "piezo-1",
      sourceHandle: "bang",
      targetHandle: "buzz",
      type: "animated",
    },
  ],
};
