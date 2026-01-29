import type { Template } from "../types";
import { potentiometerData, rangeMapData, servoData, monitorData } from "../data-factories";

export const roboticArm: Template = {
  id: "robotic-arm",
  name: "Robotic Arm",
  description:
    "Control a servo-based robotic arm with a potentiometer. Feel like a robot operator!",
  difficulty: "intermediate",
  categories: ["Motors", "Sensors", "Robotics"],
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
      position: { x: 550, y: 200 },
      data: rangeMapData({ min: 0, max: 1023 }, { min: 0, max: 180 }),
    },
    {
      id: "servo-1",
      type: "Servo",
      position: { x: 1000, y: 200 },
      data: { ...servoData(9), label: "Arm Joint" },
    },
    {
      id: "monitor-1",
      type: "Monitor",
      position: { x: 1000, y: 550 },
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
      id: "e-range-servo",
      source: "range-1",
      target: "servo-1",
      sourceHandle: "to",
      targetHandle: "to",
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
