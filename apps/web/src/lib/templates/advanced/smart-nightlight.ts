import type { Template } from "../types";
import { ldrData, motionData, compareNumberData, rangeMapData, ledData } from "../data-factories";

export const smartNightlight: Template = {
  id: "smart-nightlight",
  name: "Smart Nightlight",
  description:
    "Automatically dims based on ambient light and motion. Energy-efficient and smart!",
  difficulty: "advanced",
  categories: ["Home", "Sensors", "LEDs"],
  nodes: [
    {
      id: "ldr-1",
      type: "Ldr",
      position: { x: 100, y: 150 },
      data: ldrData("A0"),
    },
    {
      id: "motion-1",
      type: "Motion",
      position: { x: 100, y: 400 },
      data: motionData(7),
    },
    {
      id: "compare-1",
      type: "Compare",
      position: { x: 500, y: 150 },
      data: { ...compareNumberData("less than", 400), label: "Dark?" },
    },
    {
      id: "range-1",
      type: "RangeMap",
      position: { x: 500, y: 400 },
      data: rangeMapData({ min: 0, max: 400 }, { min: 255, max: 50 }),
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 900, y: 275 },
      data: { ...ledData(9), label: "Nightlight" },
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
      id: "e-ldr-range",
      source: "ldr-1",
      target: "range-1",
      sourceHandle: "change",
      targetHandle: "from",
      type: "animated",
    },
    {
      id: "e-range-led",
      source: "range-1",
      target: "led-1",
      sourceHandle: "to",
      targetHandle: "brightness",
      type: "animated",
    },
    {
      id: "e-motion-led-on",
      source: "motion-1",
      target: "led-1",
      sourceHandle: "motionstart",
      targetHandle: "turnOn",
      type: "animated",
    },
  ],
};
