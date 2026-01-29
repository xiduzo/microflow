import type { Template } from "../types";
import { ldrData, rangeMapData, ledData, monitorData } from "../data-factories";

export const theremin: Template = {
  id: "theremin",
  name: "Light Theremin",
  description:
    "Wave your hand over a light sensor to control LED brightness. A visual theremin experience!",
  difficulty: "intermediate",
  categories: ["LEDs", "Sensors", "Fun"],
  nodes: [
    {
      id: "ldr-1",
      type: "Ldr",
      position: { x: 100, y: 200 },
      data: ldrData("A0"),
    },
    {
      id: "range-1",
      type: "RangeMap",
      position: { x: 500, y: 200 },
      data: rangeMapData({ min: 100, max: 900 }, { min: 0, max: 255 }),
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 900, y: 200 },
      data: { ...ledData(9), label: "Theremin LED" },
    },
    {
      id: "monitor-1",
      type: "Monitor",
      position: { x: 500, y: 500 },
      data: monitorData("graph"),
    },
  ],
  edges: [
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
      id: "e-range-monitor",
      source: "range-1",
      target: "monitor-1",
      sourceHandle: "to",
      targetHandle: "debug",
      type: "animated",
    },
  ],
};
