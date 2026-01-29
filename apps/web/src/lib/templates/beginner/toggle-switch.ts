import type { Template } from "../types";
import { switchData, ledData, relayData } from "../data-factories";

export const toggleSwitch: Template = {
  id: "toggle-switch",
  name: "Toggle Switch Light",
  description:
    "Control an LED and relay with a physical toggle switch. Simple on/off control!",
  difficulty: "beginner",
  categories: ["Hardware", "Control", "Home"],
  nodes: [
    {
      id: "switch-1",
      type: "Switch",
      position: { x: 100, y: 250 },
      data: switchData(2),
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 500, y: 150 },
      data: { ...ledData(13), label: "Status LED" },
    },
    {
      id: "relay-1",
      type: "Relay",
      position: { x: 500, y: 350 },
      data: { ...relayData(10), label: "Power Relay" },
    },
  ],
  edges: [
    {
      id: "e-switch-led-on",
      source: "switch-1",
      target: "led-1",
      sourceHandle: "open",
      targetHandle: "turnOn",
      type: "animated",
    },
    {
      id: "e-switch-led-off",
      source: "switch-1",
      target: "led-1",
      sourceHandle: "close",
      targetHandle: "turnOff",
      type: "animated",
    },
    {
      id: "e-switch-relay-on",
      source: "switch-1",
      target: "relay-1",
      sourceHandle: "open",
      targetHandle: "open",
      type: "animated",
    },
    {
      id: "e-switch-relay-off",
      source: "switch-1",
      target: "relay-1",
      sourceHandle: "close",
      targetHandle: "close",
      type: "animated",
    },
  ],
};
