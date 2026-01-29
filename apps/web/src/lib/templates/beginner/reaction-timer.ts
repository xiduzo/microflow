import type { Template } from "../types";
import { buttonData, ledData, intervalData, counterData, gateData, delayData } from "../data-factories";

export const reactionTimer: Template = {
  id: "reaction-timer",
  name: "Reaction Game",
  description:
    "Test your reflexes! Wait for the LED, then press the button as fast as you can. Only scores when the LED is on!",
  difficulty: "beginner",
  categories: ["Games", "Fun", "Hardware"],
  nodes: [
    {
      id: "interval-1",
      type: "Interval",
      position: { x: 100, y: 200 },
      data: { ...intervalData(3000), label: "Random Trigger" },
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 400, y: 200 },
      data: { ...ledData(13), label: "GO!" },
    },
    {
      id: "delay-1",
      type: "Delay",
      position: { x: 400, y: 50 },
      data: { ...delayData(1500), label: "LED Timeout" },
    },
    {
      id: "button-1",
      type: "Button",
      position: { x: 400, y: 400 },
      data: { ...buttonData(6), label: "React!" },
    },
    {
      id: "gate-1",
      type: "Gate",
      position: { x: 700, y: 300 },
      data: { ...gateData("and"), label: "LED On + Pressed?" },
    },
    {
      id: "counter-1",
      type: "Counter",
      position: { x: 1000, y: 300 },
      data: { ...counterData(), label: "Score" },
    },
  ],
  edges: [
    {
      id: "e-interval-led",
      source: "interval-1",
      target: "led-1",
      sourceHandle: "change",
      targetHandle: "turnOn",
      type: "animated",
    },
    {
      id: "e-interval-delay",
      source: "interval-1",
      target: "delay-1",
      sourceHandle: "change",
      targetHandle: "signal",
      type: "animated",
    },
    {
      id: "e-delay-led-off",
      source: "delay-1",
      target: "led-1",
      sourceHandle: "bang",
      targetHandle: "turnOff",
      type: "animated",
    },
    {
      id: "e-led-gate",
      source: "led-1",
      target: "gate-1",
      sourceHandle: "change",
      targetHandle: "check",
      type: "animated",
    },
    {
      id: "e-button-gate",
      source: "button-1",
      target: "gate-1",
      sourceHandle: "active",
      targetHandle: "check",
      type: "animated",
    },
    {
      id: "e-gate-counter",
      source: "gate-1",
      target: "counter-1",
      sourceHandle: "true",
      targetHandle: "increment",
      type: "animated",
    },
  ],
};
