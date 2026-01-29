import type { Template } from "../types";
import { ldrData, sensorData, rangeMapData, mqttPublishData } from "../data-factories";

export const weatherStation: Template = {
  id: "weather-station",
  name: "IoT Weather Station",
  description:
    "Publish light and temperature readings to MQTT for remote monitoring.",
  difficulty: "advanced",
  categories: ["IoT", "Sensors", "Networking"],
  nodes: [
    {
      id: "ldr-1",
      type: "Ldr",
      position: { x: 100, y: 150 },
      data: { ...ldrData("A0"), freq: 5000 },
    },
    {
      id: "sensor-1",
      type: "Sensor",
      position: { x: 100, y: 450 },
      data: { ...sensorData("A1"), freq: 5000, label: "Temperature" },
    },
    {
      id: "range-1",
      type: "RangeMap",
      position: { x: 500, y: 150 },
      data: rangeMapData({ min: 0, max: 1023 }, { min: 0, max: 100 }),
    },
    {
      id: "range-2",
      type: "RangeMap",
      position: { x: 500, y: 450 },
      data: rangeMapData({ min: 0, max: 1023 }, { min: -10, max: 40 }),
    },
    {
      id: "mqtt-1",
      type: "Mqtt",
      position: { x: 900, y: 150 },
      data: mqttPublishData("weather/light"),
    },
    {
      id: "mqtt-2",
      type: "Mqtt",
      position: { x: 900, y: 450 },
      data: mqttPublishData("weather/temperature"),
    },
  ],
  edges: [
    {
      id: "e-ldr-range",
      source: "ldr-1",
      target: "range-1",
      sourceHandle: "change",
      targetHandle: "from",
      type: "animated",
    },
    {
      id: "e-range-mqtt1",
      source: "range-1",
      target: "mqtt-1",
      sourceHandle: "to",
      targetHandle: "publish",
      type: "animated",
    },
    {
      id: "e-sensor-range2",
      source: "sensor-1",
      target: "range-2",
      sourceHandle: "change",
      targetHandle: "from",
      type: "animated",
    },
    {
      id: "e-range2-mqtt2",
      source: "range-2",
      target: "mqtt-2",
      sourceHandle: "to",
      targetHandle: "publish",
      type: "animated",
    },
  ],
};
