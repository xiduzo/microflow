import type { Template } from "../types";
import { ldrData, monitorData } from "../data-factories";

export const lightMeter: Template = {
  id: "light-meter",
  name: "Light Meter",
  description:
    "Measure ambient light levels with a photoresistor and see the values on a graph.",
  difficulty: "beginner",
  categories: ["Sensors", "Monitoring"],
  nodes: [
    {
      id: "ldr-1",
      type: "Sensor",
      position: { x: 100, y: 200 },
      data: ldrData("A0"),
    },
    {
      id: "monitor-1",
      type: "Monitor",
      position: { x: 500, y: 200 },
      data: { ...monitorData("graph"), label: "Light Level" },
    },
  ],
  edges: [
    {
      id: "e-ldr-monitor",
      source: "ldr-1",
      target: "monitor-1",
      sourceHandle: "change",
      targetHandle: "in",
      type: "animated",
    },
  ],
};
