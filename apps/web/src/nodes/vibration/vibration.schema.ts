import { dataSchema } from "../led/led.schema";
export { dataSchema, valueSchema, type Data, type Value } from "../led/led.schema";

export const defaults = {
  ...dataSchema.parse({}),
  subType: "vibration",
  group: "express",
  tags: ["action"],
  label: "Vibration",
  description: "Make a device vibrate with different intensities",
  icon: "VibrateIcon",
};
