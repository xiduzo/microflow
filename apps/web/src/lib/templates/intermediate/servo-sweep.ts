import type { Template } from "../types";
import { oscillatorData, servoData, monitorData } from "../data-factories";

export const servoSweep: Template = {
  id: "servo-sweep",
  name: "Sweep",
  description:
    "Move a servo motor back and forth in a smooth sweeping arc from 0 to 180 degrees. The classic Arduino servo example.",
  difficulty: "intermediate",
  categories: ["Motors", "Servo"],
  nodes: [
    {
      id: "osc-1",
      type: "Oscillator",
      position: { x: 100, y: 200 },
      data: { ...oscillatorData("triangle", 3000), amplitude: 90, shift: 90 },
    },
    {
      id: "servo-1",
      type: "Servo",
      position: { x: 600, y: 200 },
      data: servoData(9),
    },
    {
      id: "monitor-1",
      type: "Monitor",
      position: { x: 600, y: 500 },
      data: monitorData("graph"),
    },
  ],
  edges: [
    {
      id: "e-osc-servo",
      source: "osc-1",
      target: "servo-1",
      sourceHandle: "change",
      targetHandle: "to",
      type: "animated",
    },
    {
      id: "e-osc-monitor",
      source: "osc-1",
      target: "monitor-1",
      sourceHandle: "change",
      targetHandle: "debug",
      type: "animated",
    },
  ],
};
