import type { Template } from "../types";
import { oscillatorData, ledData, monitorData } from "../data-factories";

export const breathingLed: Template = {
  id: "breathing-led",
  name: "Breathing LED",
  description:
    "Create a smooth breathing effect on an LED using a sine wave oscillator.",
  difficulty: "intermediate",
  categories: ["LEDs", "Animation"],
  nodes: [
    {
      id: "osc-1",
      type: "Oscillator",
      position: { x: 100, y: 200 },
      data: oscillatorData("sinus", 2000),
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 600, y: 200 },
      data: ledData(9),
    },
    {
      id: "monitor-1",
      type: "Monitor",
      position: { x: 600, y: 550 },
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
