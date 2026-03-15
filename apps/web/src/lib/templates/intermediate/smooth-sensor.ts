import type { Template } from "../types";
import { sensorData, smoothData, rangeMapData, ledData, monitorData } from "../data-factories";

export const smoothSensor: Template = {
  id: "smooth-sensor",
  name: "Smoothing",
  description:
    "Smooth multiple readings from an analog input to reduce noise. Compare the raw noisy signal against the smoothed output side by side.",
  difficulty: "intermediate",
  categories: ["Analog", "Sensors"],
  nodes: [
    {
      id: "sensor-1",
      type: "Sensor",
      position: { x: 100, y: 200 },
      data: { ...sensorData("A0"), label: "Noisy Sensor" },
    },
    {
      id: "smooth-1",
      type: "Smooth",
      position: { x: 450, y: 200 },
      data: smoothData("smooth", 0.95),
    },
    {
      id: "range-1",
      type: "RangeMap",
      position: { x: 750, y: 200 },
      data: rangeMapData({ min: 0, max: 1023 }, { min: 0, max: 255 }),
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 1050, y: 200 },
      data: { ...ledData(9), label: "Smooth Output" },
    },
    {
      id: "monitor-raw",
      type: "Monitor",
      position: { x: 250, y: 500 },
      data: { ...monitorData("graph"), label: "Raw Signal" },
    },
    {
      id: "monitor-smooth",
      type: "Monitor",
      position: { x: 600, y: 500 },
      data: { ...monitorData("graph"), label: "Smoothed Signal" },
    },
  ],
  edges: [
    {
      id: "e-sensor-smooth",
      source: "sensor-1",
      target: "smooth-1",
      sourceHandle: "change",
      targetHandle: "signal",
      type: "animated",
    },
    {
      id: "e-smooth-range",
      source: "smooth-1",
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
      id: "e-sensor-monitor-raw",
      source: "sensor-1",
      target: "monitor-raw",
      sourceHandle: "change",
      targetHandle: "debug",
      type: "animated",
    },
    {
      id: "e-smooth-monitor",
      source: "smooth-1",
      target: "monitor-smooth",
      sourceHandle: "change",
      targetHandle: "debug",
      type: "animated",
    },
  ],
};
