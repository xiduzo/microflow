import { dataSchema } from "../sensor/sensor.schema";
export { dataSchema, valueSchema, type Data, type Value } from "../sensor/sensor.schema";

export const defaults = {
  ...dataSchema.parse({}),
  subType: "ldr",
  group: "sense",
  tags: ["value", "source"],
  label: "Light Dependent Resistor (LDR)",
  description: "Measure ambient light level using a photoresistor (LDR) — bright outdoors, dim indoors",
  icon: "SunIcon",
};
