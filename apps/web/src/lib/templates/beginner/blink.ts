import type { Template } from "../types";
import { ledData, intervalData } from "../data-factories";

export const blink: Template = {
  id: "blink",
  name: "Blinking LED",
  description:
    "The classic first project! Make an LED blink on and off automatically.",
  difficulty: "beginner",
  categories: ["LEDs", "Getting Started"],
  nodes: [
    {
      id: "interval-1",
      type: "Interval",
      position: { x: 100, y: 200 },
      data: { ...intervalData(1000), label: "Timer" },
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 500, y: 200 },
      data: { ...ledData(13), label: "Blinker" },
    },
  ],
  edges: [
    {
      id: "e-interval-led",
      source: "interval-1",
      target: "led-1",
      sourceHandle: "change",
      targetHandle: "toggle",
      type: "animated",
    },
  ],
};
