import type { Template } from "../types";
import { potentiometerData, ledData, rangeMapData } from "../data-factories";

export const knobLed: Template = {
  id: "knob-led",
  name: "Dimmer Knob",
  description:
    "Turn a potentiometer to control LED brightness. Learn analog input and output!",
  difficulty: "beginner",
  categories: ["Hardware", "LEDs", "Control"],
  nodes: [
    {
      id: "pot-1",
      type: "Sensor",
      position: { x: 100, y: 200 },
      data: potentiometerData("A0"),
    },
    {
      id: "map-1",
      type: "RangeMap",
      position: { x: 450, y: 200 },
      data: rangeMapData({ min: 0, max: 1023 }, { min: 0, max: 255 }),
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 800, y: 200 },
      data: { ...ledData(9), label: "Dimmable LED" },
    },
  ],
  edges: [
    {
      id: "e-pot-map",
      source: "pot-1",
      target: "map-1",
      sourceHandle: "change",
      targetHandle: "in",
      type: "animated",
    },
    {
      id: "e-map-led",
      source: "map-1",
      target: "led-1",
      sourceHandle: "change",
      targetHandle: "brightness",
      type: "animated",
    },
  ],
};
