import type { Template } from "../types";
import { sensorData, compareNumberData, ledData } from "../data-factories";

export const clapSwitch: Template = {
  id: "clap-switch",
  name: "Sound-Activated Light",
  description: "Use a sound sensor to toggle a light. Clap on, clap off!",
  difficulty: "beginner",
  categories: ["Sensors", "LEDs", "Fun"],
  nodes: [
    {
      id: "sensor-1",
      type: "Sensor",
      position: { x: 100, y: 200 },
      data: { ...sensorData("A0"), label: "Sound Sensor" },
    },
    {
      id: "compare-1",
      type: "Compare",
      position: { x: 500, y: 200 },
      data: compareNumberData("greater than", 600),
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 900, y: 200 },
      data: ledData(13),
    },
  ],
  edges: [
    {
      id: "e-sensor-compare",
      source: "sensor-1",
      target: "compare-1",
      sourceHandle: "change",
      targetHandle: "check",
      type: "animated",
    },
    {
      id: "e-compare-led",
      source: "compare-1",
      target: "led-1",
      sourceHandle: "true",
      targetHandle: "toggle",
      type: "animated",
    },
  ],
};
