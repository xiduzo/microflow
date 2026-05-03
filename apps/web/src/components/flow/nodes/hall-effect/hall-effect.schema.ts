import { dataSchema } from "../sensor/sensor.schema";
export { dataSchema, valueSchema, type Data, type Value } from "../sensor/sensor.schema";

export const defaults = {
  ...dataSchema.parse({}),
  subType: "hall-effect",
  group: "sense",
  tags: ["value", "source"],
  label: "Hall Effect",
  description: "Detect the presence of a magnet or measure magnetic field strength using a Hall effect sensor",
  icon: "MagnetIcon",
};
