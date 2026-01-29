import type { Template } from "../types";
import { oscillatorData, ledData, monitorData } from "../data-factories";

export const sunriseAlarm: Template = {
  id: "sunrise-alarm",
  name: "Sunrise Simulator",
  description: "Gradually brighten an LED like a sunrise. Wake up naturally!",
  difficulty: "intermediate",
  categories: ["LEDs", "Home", "Animation"],
  nodes: [
    {
      id: "osc-1",
      type: "Oscillator",
      position: { x: 100, y: 200 },
      data: { ...oscillatorData("sawtooth", 30000), amplitude: 255, shift: 0 },
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 600, y: 200 },
      data: { ...ledData(9), label: "Sunrise" },
    },
    {
      id: "monitor-1",
      type: "Monitor",
      position: { x: 600, y: 500 },
      data: monitorData("graph"),
    },
  ],
  edges: [
    {
      id: "e-osc-led",
      source: "osc-1",
      target: "led-1",
      sourceHandle: "change",
      targetHandle: "brightness",
      type: "animated",
    },
    {
      id: "e-osc-monitor",
      source: "osc-1",
      target: "monitor-1",
      sourceHandle: "change",
      targetHandle: "debug",
      type: "animated",
    },
  ],
};
