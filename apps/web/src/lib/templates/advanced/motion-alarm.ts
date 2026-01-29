import type { Template } from "../types";
import { motionData, delayData, piezoData, ledData, counterData } from "../data-factories";

export const motionAlarm: Template = {
  id: "motion-alarm",
  name: "Intruder Alert",
  description:
    "A PIR sensor detects motion and triggers a multi-stage alarm with LED and buzzer.",
  difficulty: "advanced",
  categories: ["Sensors", "Audio", "Security"],
  nodes: [
    {
      id: "motion-1",
      type: "Motion",
      position: { x: 100, y: 250 },
      data: motionData(7),
    },
    {
      id: "delay-1",
      type: "Delay",
      position: { x: 500, y: 150 },
      data: { ...delayData(1000), label: "Warning Delay" },
    },
    {
      id: "piezo-1",
      type: "Piezo",
      position: { x: 900, y: 150 },
      data: { ...piezoData(8), frequency: 1000, duration: 2000 },
    },
    {
      id: "led-1",
      type: "Led",
      position: { x: 500, y: 400 },
      data: { ...ledData(13), label: "Alert LED" },
    },
    {
      id: "counter-1",
      type: "Counter",
      position: { x: 900, y: 400 },
      data: { ...counterData(), label: "Detections" },
    },
  ],
  edges: [
    {
      id: "e-motion-delay",
      source: "motion-1",
      target: "delay-1",
      sourceHandle: "motionstart",
      targetHandle: "signal",
      type: "animated",
    },
    {
      id: "e-delay-piezo",
      source: "delay-1",
      target: "piezo-1",
      sourceHandle: "bang",
      targetHandle: "buzz",
      type: "animated",
    },
    {
      id: "e-motion-led",
      source: "motion-1",
      target: "led-1",
      sourceHandle: "motionstart",
      targetHandle: "turnOn",
      type: "animated",
    },
    {
      id: "e-motion-led-off",
      source: "motion-1",
      target: "led-1",
      sourceHandle: "motionend",
      targetHandle: "turnOff",
      type: "animated",
    },
    {
      id: "e-motion-counter",
      source: "motion-1",
      target: "counter-1",
      sourceHandle: "motionstart",
      targetHandle: "increment",
      type: "animated",
    },
  ],
};
