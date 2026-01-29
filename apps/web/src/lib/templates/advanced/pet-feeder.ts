import type { Template } from "../types";
import { intervalData, buttonData, servoData, delayData, piezoData, counterData } from "../data-factories";

export const petFeeder: Template = {
  id: "pet-feeder",
  name: "Pet Feeder",
  description:
    "Automated pet feeder with servo-controlled dispenser and feeding counter.",
  difficulty: "advanced",
  categories: ["Home", "Motors", "Automation"],
  nodes: [
    {
      id: "interval-1",
      type: "Interval",
      position: { x: 100, y: 200 },
      data: { ...intervalData(28800000), label: "8hr Timer" },
    },
    {
      id: "button-1",
      type: "Button",
      position: { x: 100, y: 450 },
      data: { ...buttonData(6), label: "Manual Feed" },
    },
    {
      id: "servo-1",
      type: "Servo",
      position: { x: 550, y: 200 },
      data: { ...servoData(9), label: "Dispenser" },
    },
    {
      id: "delay-1",
      type: "Delay",
      position: { x: 550, y: 450 },
      data: { ...delayData(1000), label: "Dispense Time" },
    },
    {
      id: "piezo-1",
      type: "Piezo",
      position: { x: 950, y: 200 },
      data: { ...piezoData(8), frequency: 660, label: "Dinner Bell" },
    },
    {
      id: "counter-1",
      type: "Counter",
      position: { x: 950, y: 450 },
      data: { ...counterData(), label: "Feedings" },
    },
  ],
  edges: [
    {
      id: "e-interval-servo",
      source: "interval-1",
      target: "servo-1",
      sourceHandle: "change",
      targetHandle: "max",
      type: "animated",
    },
    {
      id: "e-button-servo",
      source: "button-1",
      target: "servo-1",
      sourceHandle: "active",
      targetHandle: "max",
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
      id: "e-delay-servo-reset",
      source: "delay-1",
      target: "servo-1",
      sourceHandle: "bang",
      targetHandle: "min",
      type: "animated",
    },
    {
      id: "e-interval-piezo",
      source: "interval-1",
      target: "piezo-1",
      sourceHandle: "change",
      targetHandle: "buzz",
      type: "animated",
    },
    {
      id: "e-interval-counter",
      source: "interval-1",
      target: "counter-1",
      sourceHandle: "change",
      targetHandle: "increment",
      type: "animated",
    },
  ],
};
