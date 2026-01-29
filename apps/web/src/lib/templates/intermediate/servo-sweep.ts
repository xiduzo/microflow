import type { Template } from "../types";
import { oscillatorData, servoData, monitorData } from "../data-factories";

export const servoSweep: Template = {
  id: "servo-sweep",
  name: "Radar Sweep",
  description:
    "A servo sweeps back and forth like a radar scanner. Hypnotic to watch!",
  difficulty: "intermediate",
  categories: ["Motors", "Animation"],
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
