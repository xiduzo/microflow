import type { Template } from "../types";
import { ldrData, monitorData } from "../data-factories";

export const lightMeter: Template = {
  id: "light-meter",
  name: "Analog Read Serial",
  description:
    "Read an analog input pin and display the values in real-time. The Arduino equivalent of printing sensor data to the Serial Monitor.",
  difficulty: "beginner",
  categories: ["Basics", "Sensors"],
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
