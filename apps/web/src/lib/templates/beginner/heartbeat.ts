import type { Template } from "../types";
import { ledData, oscillatorData } from "../data-factories";

export const heartbeat: Template = {
  id: "heartbeat",
  name: "Fade",
  description:
    "Fade an LED in and out using analog output (PWM). Demonstrates how to use analogWrite to smoothly control LED brightness.",
  difficulty: "beginner",
  categories: ["Basics", "LEDs"],
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
