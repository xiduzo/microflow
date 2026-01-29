import type { Template } from "../types";
import { mqttSubscribeData, compareTextData, compareNumberData, ledData, servoData } from "../data-factories";

export const smartHomeHub: Template = {
  id: "smart-home-hub",
  name: "Smart Home Hub",
  description:
    "Control multiple devices via MQTT. The brain of your smart home!",
  difficulty: "advanced",
  categories: ["IoT", "Home", "Networking"],
  nodes: [
    {
      id: "mqtt-1",
      type: "Mqtt",
      position: { x: 100, y: 150 },
      data: mqttSubscribeData("home/living-room/light"),
    },
    {
      id: "mqtt-2",
      type: "Mqtt",
      position: { x: 100, y: 400 },
      data: mqttSubscribeData("home/bedroom/fan"),
    },
    {
      id: "compare-1",
      type: "Compare",
      position: { x: 500, y: 150 },
      data: compareTextData("equal to", "on"),
    },
    {
      id: "compare-2",
      type: "Compare",
      position: { x: 500, y: 400 },
      data: compareNumberData("greater than", 0),
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 900, y: 150 },
      data: { ...ledData(13), label: "Living Room" },
    },
    {
      id: "servo-1",
      type: "Servo",
      position: { x: 900, y: 400 },
      data: { ...servoData(9), label: "Fan Speed" },
    },
  ],
  edges: [
    {
      id: "e-mqtt1-compare1",
      source: "mqtt-1",
      target: "compare-1",
      sourceHandle: "message",
      targetHandle: "check",
      type: "animated",
    },
    {
      id: "e-compare1-led-on",
      source: "compare-1",
      target: "led-1",
      sourceHandle: "true",
      targetHandle: "turnOn",
      type: "animated",
    },
    {
      id: "e-compare1-led-off",
      source: "compare-1",
      target: "led-1",
      sourceHandle: "false",
      targetHandle: "turnOff",
      type: "animated",
    },
    {
      id: "e-mqtt2-compare2",
      source: "mqtt-2",
      target: "compare-2",
      sourceHandle: "message",
      targetHandle: "check",
      type: "animated",
    },
    {
      id: "e-mqtt2-servo",
      source: "mqtt-2",
      target: "servo-1",
      sourceHandle: "message",
      targetHandle: "to",
      type: "animated",
    },
  ],
};
