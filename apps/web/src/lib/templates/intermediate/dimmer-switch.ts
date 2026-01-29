import type { Template } from "../types";
import { potentiometerData, rangeMapData, ledData, monitorData } from "../data-factories";

export const dimmerSwitch: Template = {
  id: "dimmer-switch",
  name: "Smooth Dimmer",
  description:
    "Use a potentiometer to smoothly control LED brightness with value smoothing.",
  difficulty: "intermediate",
  categories: ["LEDs", "Control", "Hardware"],
  nodes: [
    {
      id: "pot-1",
      type: "Potentiometer",
      position: { x: 100, y: 200 },
      data: potentiometerData("A0"),
    },
    {
      id: "range-1",
      type: "RangeMap",
      position: { x: 500, y: 200 },
      data: rangeMapData({ min: 0, max: 1023 }, { min: 0, max: 255 }),
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 900, y: 200 },
      data: ledData(9),
    },
    {
      id: "monitor-1",
      type: "Monitor",
      position: { x: 900, y: 500 },
      data: monitorData("graph"),
    },
  ],
  edges: [
    {
      id: "e-pot-range",
      source: "pot-1",
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
