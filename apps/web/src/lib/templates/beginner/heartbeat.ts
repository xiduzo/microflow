import type { Template } from "../types";
import { ledData, oscillatorData } from "../data-factories";

export const heartbeat: Template = {
  id: "heartbeat",
  name: "Heartbeat LED",
  description:
    "A gentle pulsing LED that mimics a heartbeat rhythm. Calming and mesmerizing.",
  difficulty: "beginner",
  categories: ["LEDs", "Animation"],
  nodes: [
    {
      id: "osc-1",
      type: "Oscillator",
      position: { x: 100, y: 200 },
      data: { ...oscillatorData("sinus", 1200), amplitude: 200, shift: 55 },
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 600, y: 200 },
      data: { ...ledData(9), label: "Heartbeat" },
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
  ],
};
