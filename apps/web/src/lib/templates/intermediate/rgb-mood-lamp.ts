import type { Template } from "../types";
import { oscillatorData, rgbData, monitorData } from "../data-factories";

export const rgbMoodLamp: Template = {
  id: "rgb-mood-lamp",
  name: "RGB Mood Lamp",
  description:
    "A mesmerizing color-cycling lamp using RGB LED with phase-shifted oscillators.",
  difficulty: "intermediate",
  categories: ["LEDs", "Animation", "Home"],
  nodes: [
    {
      id: "osc-red",
      type: "Oscillator",
      position: { x: 100, y: 100 },
      data: { ...oscillatorData("sinus", 5000), amplitude: 127, shift: 128, phase: 0, label: "Red Wave" },
    },
    {
      id: "osc-green",
      type: "Oscillator",
      position: { x: 100, y: 300 },
      data: { ...oscillatorData("sinus", 5000), amplitude: 127, shift: 128, phase: 120, label: "Green Wave" },
    },
    {
      id: "osc-blue",
      type: "Oscillator",
      position: { x: 100, y: 500 },
      data: { ...oscillatorData("sinus", 5000), amplitude: 127, shift: 128, phase: 240, label: "Blue Wave" },
    },
    {
      id: "rgb-1",
      type: "Rgb",
      position: { x: 600, y: 300 },
      data: rgbData({ red: 9, green: 10, blue: 11 }),
    },
    {
      id: "monitor-1",
      type: "Monitor",
      position: { x: 600, y: 600 },
      data: monitorData("graph"),
    },
  ],
  edges: [
    {
      id: "e-osc-red-rgb",
      source: "osc-red",
      target: "rgb-1",
      sourceHandle: "change",
      targetHandle: "red",
      type: "animated",
    },
    {
      id: "e-osc-green-rgb",
      source: "osc-green",
      target: "rgb-1",
      sourceHandle: "change",
      targetHandle: "green",
      type: "animated",
    },
    {
      id: "e-osc-blue-rgb",
      source: "osc-blue",
      target: "rgb-1",
      sourceHandle: "change",
      targetHandle: "blue",
      type: "animated",
    },
    {
      id: "e-rgb-monitor",
      source: "rgb-1",
      target: "monitor-1",
      sourceHandle: "change",
      targetHandle: "debug",
      type: "animated",
    },
  ],
};
