import type { Template } from "../types";
import { sensorData, compareNumberData, ledData, piezoData, monitorData } from "../data-factories";

export const plantMonitor: Template = {
  id: "plant-monitor",
  name: "Plant Moisture Alert",
  description:
    "Monitor soil moisture and get an alert when your plant needs water.",
  difficulty: "intermediate",
  categories: ["Sensors", "Home", "Monitoring"],
  nodes: [
    {
      id: "sensor-1",
      type: "Sensor",
      position: { x: 100, y: 200 },
      data: { ...sensorData("A0"), label: "Soil Moisture" },
    },
    {
      id: "compare-1",
      type: "Compare",
      position: { x: 500, y: 200 },
      data: { ...compareNumberData("less than", 300), label: "Dry?" },
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 900, y: 100 },
      data: { ...ledData(13), label: "Water Me!" },
    },
    {
      id: "piezo-1",
      type: "Piezo",
      position: { x: 900, y: 350 },
      data: { ...piezoData(8), frequency: 523 },
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
      targetHandle: "turnOn",
      type: "animated",
    },
    {
      id: "e-compare-led-off",
      source: "compare-1",
      target: "led-1",
      sourceHandle: "false",
      targetHandle: "turnOff",
      type: "animated",
    },
    {
      id: "e-compare-piezo",
      source: "compare-1",
      target: "piezo-1",
      sourceHandle: "true",
      targetHandle: "buzz",
      type: "animated",
    },
    {
      id: "e-sensor-monitor",
      source: "sensor-1",
      target: "monitor-1",
      sourceHandle: "change",
      targetHandle: "debug",
      type: "animated",
    },
  ],
};
