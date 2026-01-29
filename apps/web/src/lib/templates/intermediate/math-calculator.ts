import type { Template } from "../types";
import { potentiometerData, constantData, calculateData, monitorData, rangeMapData, ledData } from "../data-factories";

export const mathCalculator: Template = {
  id: "math-calculator",
  name: "Math Operations",
  description:
    "Combine sensor values with constants using math operations. Learn data transformation!",
  difficulty: "intermediate",
  categories: ["Education", "Transformation", "Math"],
  nodes: [
    {
      id: "pot-1",
      type: "Potentiometer",
      position: { x: 100, y: 150 },
      data: potentiometerData("A0"),
    },
    {
      id: "constant-1",
      type: "Constant",
      position: { x: 100, y: 400 },
      data: { ...constantData(2), label: "Multiplier" },
    },
    {
      id: "calc-1",
      type: "Calculate",
      position: { x: 450, y: 275 },
      data: { ...calculateData("multiply"), label: "Multiply" },
    },
    {
      id: "range-1",
      type: "RangeMap",
      position: { x: 750, y: 275 },
      data: rangeMapData({ min: 0, max: 2046 }, { min: 0, max: 255 }),
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 1050, y: 275 },
      data: { ...ledData(9), label: "Result" },
    },
    {
      id: "monitor-1",
      type: "Monitor",
      position: { x: 750, y: 550 },
      data: monitorData("graph"),
    },
  ],
  edges: [
    {
      id: "e-pot-calc",
      source: "pot-1",
      target: "calc-1",
      sourceHandle: "change",
      targetHandle: "input",
      type: "animated",
    },
    {
      id: "e-constant-calc",
      source: "constant-1",
      target: "calc-1",
      sourceHandle: "output",
      targetHandle: "input",
      type: "animated",
    },
    {
      id: "e-calc-range",
      source: "calc-1",
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
      id: "e-calc-monitor",
      source: "calc-1",
      target: "monitor-1",
      sourceHandle: "change",
      targetHandle: "debug",
      type: "animated",
    },
  ],
};
