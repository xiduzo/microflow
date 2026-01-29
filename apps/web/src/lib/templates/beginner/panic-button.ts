import type { Template } from "../types";
import { buttonData, ledData, piezoData } from "../data-factories";

export const panicButton: Template = {
  id: "panic-button",
  name: "Panic Button",
  description:
    "A big red button that triggers flashing lights and an alarm sound. Fun for pranks!",
  difficulty: "beginner",
  categories: ["Hardware", "Audio", "Fun"],
  nodes: [
    {
      id: "button-1",
      type: "Button",
      position: { x: 100, y: 250 },
      data: { ...buttonData(6), label: "PANIC!" },
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 500, y: 100 },
      data: { ...ledData(13), label: "Warning 1" },
    },
    {
      id: "led-2",
      type: "Led",
      position: { x: 500, y: 250 },
      data: { ...ledData(12), label: "Warning 2" },
    },
    {
      id: "piezo-1",
      type: "Piezo",
      position: { x: 500, y: 400 },
      data: { ...piezoData(8), frequency: 1000, duration: 100 },
    },
  ],
  edges: [
    {
      id: "e-button-led1-on",
      source: "button-1",
      target: "led-1",
      sourceHandle: "active",
      targetHandle: "turnOn",
      type: "animated",
    },
    {
      id: "e-button-led1-off",
      source: "button-1",
      target: "led-1",
      sourceHandle: "inactive",
      targetHandle: "turnOff",
      type: "animated",
    },
    {
      id: "e-button-led2-on",
      source: "button-1",
      target: "led-2",
      sourceHandle: "active",
      targetHandle: "turnOn",
      type: "animated",
    },
    {
      id: "e-button-led2-off",
      source: "button-1",
      target: "led-2",
      sourceHandle: "inactive",
      targetHandle: "turnOff",
      type: "animated",
    },
    {
      id: "e-button-piezo",
      source: "button-1",
      target: "piezo-1",
      sourceHandle: "active",
      targetHandle: "buzz",
      type: "animated",
    },
  ],
};
