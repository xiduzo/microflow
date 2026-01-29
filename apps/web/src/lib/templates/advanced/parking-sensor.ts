import type { Template } from "../types";
import { sensorData, rangeMapData, compareNumberData, ledData, piezoData } from "../data-factories";

export const parkingSensor: Template = {
  id: "parking-sensor",
  name: "Parking Assistant",
  description:
    "Proximity sensor with progressive LED feedback. Never bump the wall again!",
  difficulty: "advanced",
  categories: ["Sensors", "LEDs", "Automotive"],
  nodes: [
    {
      id: "sensor-1",
      type: "Sensor",
      position: { x: 100, y: 250 },
      data: { ...sensorData("A0"), label: "Distance Sensor" },
    },
    {
      id: "range-1",
      type: "RangeMap",
      position: { x: 500, y: 150 },
      data: rangeMapData({ min: 100, max: 600 }, { min: 255, max: 0 }),
    },
    {
      id: "compare-1",
      type: "Compare",
      position: { x: 500, y: 400 },
      data: { ...compareNumberData("less than", 200), label: "Too Close?" },
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 900, y: 150 },
      data: { ...ledData(9), label: "Warning" },
    },
    {
      id: "piezo-1",
      type: "Piezo",
      position: { x: 900, y: 400 },
      data: { ...piezoData(8), frequency: 1000, duration: 200 },
    },
  ],
  edges: [
    {
      id: "e-sensor-range1",
      source: "sensor-1",
      target: "range-1",
      sourceHandle: "change",
      targetHandle: "from",
      type: "animated",
    },
    {
      id: "e-range1-led",
      source: "range-1",
      target: "led-1",
      sourceHandle: "to",
      targetHandle: "brightness",
      type: "animated",
    },
    {
      id: "e-sensor-compare",
      source: "sensor-1",
      target: "compare-1",
      sourceHandle: "change",
      targetHandle: "check",
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
  ],
};
