import type { Template } from "../types";
import { proximityData, compareNumberData, rangeMapData, ledData, piezoData, monitorData } from "../data-factories";

export const proximityAlarm: Template = {
  id: "proximity-alarm",
  name: "Distance Alarm",
  description:
    "Use an ultrasonic or IR proximity sensor to detect objects and trigger alerts.",
  difficulty: "advanced",
  categories: ["Sensors", "Security", "Robotics"],
  nodes: [
    {
      id: "proximity-1",
      type: "Proximity",
      position: { x: 100, y: 250 },
      data: { ...proximityData("A0"), label: "Distance Sensor" },
    },
    {
      id: "compare-1",
      type: "Compare",
      position: { x: 500, y: 150 },
      data: { ...compareNumberData("less than", 30), label: "Too Close?" },
    },
    {
      id: "range-1",
      type: "RangeMap",
      position: { x: 500, y: 400 },
      data: rangeMapData({ min: 10, max: 100 }, { min: 255, max: 0 }),
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 900, y: 150 },
      data: { ...ledData(13), label: "Alert" },
    },
    {
      id: "piezo-1",
      type: "Piezo",
      position: { x: 900, y: 300 },
      data: { ...piezoData(8), frequency: 2000, duration: 100 },
    },
    {
      id: "led-2",
      type: "Led",
      position: { x: 900, y: 450 },
      data: { ...ledData(9), label: "Distance Indicator" },
    },
    {
      id: "monitor-1",
      type: "Monitor",
      position: { x: 500, y: 600 },
      data: monitorData("graph"),
    },
  ],
  edges: [
    {
      id: "e-prox-compare",
      source: "proximity-1",
      target: "compare-1",
      sourceHandle: "change",
      targetHandle: "check",
      type: "animated",
    },
    {
      id: "e-prox-range",
      source: "proximity-1",
      target: "range-1",
      sourceHandle: "change",
      targetHandle: "from",
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
      id: "e-range-led2",
      source: "range-1",
      target: "led-2",
      sourceHandle: "to",
      targetHandle: "brightness",
      type: "animated",
    },
    {
      id: "e-prox-monitor",
      source: "proximity-1",
      target: "monitor-1",
      sourceHandle: "change",
      targetHandle: "debug",
      type: "animated",
    },
  ],
};
