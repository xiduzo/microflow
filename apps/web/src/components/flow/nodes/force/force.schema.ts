import { dataSchema } from "../sensor/sensor.schema";
export { dataSchema, valueSchema, type Data, type Value } from "../sensor/sensor.schema";

export const defaults = {
  ...dataSchema.parse({}),
  subType: "force",
  group: "sense",
  tags: ["value", "source"],
  label: "Force",
  description: "Measure how hard something is pressed using a force-sensitive resistor (FSR)",
  icon: "BicepsFlexedIcon",
};
