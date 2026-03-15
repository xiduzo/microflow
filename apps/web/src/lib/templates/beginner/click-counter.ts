import type { Template } from "../types";
import { buttonData, counterData, monitorData } from "../data-factories";

export const clickCounter: Template = {
  id: "click-counter",
  name: "State Change Detection",
  description:
    "Count the number of times a button transitions from off to on. Detects rising-edge state changes rather than holding the button down.",
  difficulty: "beginner",
  categories: ["Digital", "Hardware"],
  nodes: [
    {
      id: "button-1",
      type: "Button",
      position: { x: 100, y: 200 },
      data: { ...buttonData(6), label: "Click!" },
    },
    {
      id: "counter-1",
      type: "Counter",
      position: { x: 450, y: 200 },
      data: { ...counterData(), label: "Clicks" },
    },
    {
      id: "monitor-1",
      type: "Monitor",
      position: { x: 800, y: 200 },
      data: { ...monitorData("raw"), label: "Total" },
    },
  ],
  edges: [
    {
      id: "e-button-counter",
      source: "button-1",
      target: "counter-1",
      sourceHandle: "active",
      targetHandle: "increment",
      type: "animated",
    },
    {
      id: "e-counter-monitor",
      source: "counter-1",
      target: "monitor-1",
      sourceHandle: "change",
      targetHandle: "in",
      type: "animated",
    },
  ],
};
