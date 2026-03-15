import type { Template } from "../types";
import { buttonData, ledData } from "../data-factories";

export const buttonLed: Template = {
  id: "button-led",
  name: "Button",
  description:
    "Use a pushbutton to control an LED. Press to turn on, release to turn off.",
  difficulty: "beginner",
  categories: ["Digital", "Hardware"],
  nodes: [
    {
      id: "button-1",
      type: "Button",
      position: { x: 100, y: 200 },
      data: { ...buttonData(6), label: "Press Me" },
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 500, y: 200 },
      data: { ...ledData(13), label: "Light" },
    },
  ],
  edges: [
    {
      id: "e-button-led-on",
      source: "button-1",
      target: "led-1",
      sourceHandle: "active",
      targetHandle: "turnOn",
      type: "animated",
    },
    {
      id: "e-button-led-off",
      source: "button-1",
      target: "led-1",
      sourceHandle: "inactive",
      targetHandle: "turnOff",
      type: "animated",
    },
  ],
};
