import type { Template } from "../types";
import { buttonData, counterData, monitorData } from "../data-factories";

export const clickCounter: Template = {
  id: "click-counter",
  name: "Click Counter",
  description:
    "Count button presses and display the total. Great for keeping score!",
  difficulty: "beginner",
  categories: ["Hardware", "Games", "Fun"],
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
