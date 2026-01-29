import type { Template } from "../types";
import { buttonData, switchData, gateData, relayData, ledData, piezoData } from "../data-factories";

export const securityGate: Template = {
  id: "security-gate",
  name: "Two-Factor Security Gate",
  description:
    "A security system requiring both a button press AND a switch to be on. Uses logic gates!",
  difficulty: "advanced",
  categories: ["Security", "Logic", "Hardware"],
  nodes: [
    {
      id: "button-1",
      type: "Button",
      position: { x: 100, y: 150 },
      data: { ...buttonData(6), label: "Access Button" },
    },
    {
      id: "switch-1",
      type: "Switch",
      position: { x: 100, y: 400 },
      data: { ...switchData(2), label: "Key Switch" },
    },
    {
      id: "gate-1",
      type: "Gate",
      position: { x: 500, y: 275 },
      data: { ...gateData("and"), label: "Both Required" },
    },
    {
      id: "relay-1",
      type: "Relay",
      position: { x: 900, y: 150 },
      data: { ...relayData(10), label: "Door Lock" },
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 900, y: 300 },
      data: { ...ledData(13), label: "Access Granted" },
    },
    {
      id: "piezo-1",
      type: "Piezo",
      position: { x: 900, y: 450 },
      data: { ...piezoData(8), frequency: 880, duration: 100 },
    },
  ],
  edges: [
    {
      id: "e-button-gate",
      source: "button-1",
      target: "gate-1",
      sourceHandle: "active",
      targetHandle: "check",
      type: "animated",
    },
    {
      id: "e-switch-gate",
      source: "switch-1",
      target: "gate-1",
      sourceHandle: "change",
      targetHandle: "check",
      type: "animated",
    },
    {
      id: "e-gate-relay",
      source: "gate-1",
      target: "relay-1",
      sourceHandle: "true",
      targetHandle: "open",
      type: "animated",
    },
    {
      id: "e-gate-relay-close",
      source: "gate-1",
      target: "relay-1",
      sourceHandle: "false",
      targetHandle: "close",
      type: "animated",
    },
    {
      id: "e-gate-led",
      source: "gate-1",
      target: "led-1",
      sourceHandle: "true",
      targetHandle: "turnOn",
      type: "animated",
    },
    {
      id: "e-gate-led-off",
      source: "gate-1",
      target: "led-1",
      sourceHandle: "false",
      targetHandle: "turnOff",
      type: "animated",
    },
    {
      id: "e-gate-piezo",
      source: "gate-1",
      target: "piezo-1",
      sourceHandle: "true",
      targetHandle: "buzz",
      type: "animated",
    },
  ],
};
