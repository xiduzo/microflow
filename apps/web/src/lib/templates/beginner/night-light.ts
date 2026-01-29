import type { Template } from "../types";
import { ldrData, compareNumberData, ledData } from "../data-factories";

export const nightLight: Template = {
  id: "night-light",
  name: "Auto Night Light",
  description:
    "An LED that automatically turns on when it gets dark. Perfect for hallways!",
  difficulty: "beginner",
  categories: ["Sensors", "LEDs", "Home"],
  nodes: [
    {
      id: "ldr-1",
      type: "Sensor",
      position: { x: 100, y: 200 },
      data: ldrData("A0"),
    },
    {
      id: "compare-1",
      type: "Compare",
      position: { x: 450, y: 200 },
      data: { ...compareNumberData("less than", 300), label: "Is Dark?" },
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 800, y: 200 },
      data: { ...ledData(13), label: "Night Light" },
    },
  ],
  edges: [
    {
      id: "e-ldr-compare",
      source: "ldr-1",
      target: "compare-1",
      sourceHandle: "change",
      targetHandle: "check",
      type: "animated",
    },
    {
      id: "e-compare-led-on",
      source: "compare-1",
      target: "led-1",
      sourceHandle: "true",
      targetHandle: "turnOn",
      type: "animated",
    },
    {
      id: "e-compare-led-off",
      source: "compare-1",
      target: "led-1",
      sourceHandle: "false",
      targetHandle: "turnOff",
      type: "animated",
    },
  ],
};
