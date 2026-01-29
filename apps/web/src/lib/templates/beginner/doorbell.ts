import type { Template } from "../types";
import { buttonData, ledData, piezoData } from "../data-factories";

export const doorbell: Template = {
  id: "doorbell",
  name: "Digital Doorbell",
  description:
    "Press a button to ring a buzzer and flash an LED. Your first interactive project!",
  difficulty: "beginner",
  categories: ["Hardware", "Audio", "Fun"],
  nodes: [
    {
      id: "button-1",
      type: "Button",
      position: { x: 100, y: 200 },
      data: { ...buttonData(6), label: "Doorbell" },
    },
    {
      id: "piezo-1",
      type: "Piezo",
      position: { x: 600, y: 100 },
      data: { ...piezoData(8), frequency: 880, duration: 200 },
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 600, y: 350 },
      data: ledData(13),
    },
  ],
  edges: [
    {
      id: "e-button-piezo",
      source: "button-1",
      target: "piezo-1",
      sourceHandle: "active",
      targetHandle: "buzz",
      type: "animated",
    },
    {
      id: "e-button-led",
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
