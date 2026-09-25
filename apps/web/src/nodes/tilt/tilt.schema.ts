import { dataSchema } from "../sensor/sensor.schema";
export { dataSchema, valueSchema, type Data, type Value } from "../sensor/sensor.schema";

export const defaults = {
  ...dataSchema.parse({}),
  subType: "tilt",
  threshold: 10,
  group: "sense",
  tags: ["value", "trigger", "source"],
  label: "Tilt",
  description: "Detect when an object is tilted or rotated from its normal position",
  icon: "MoveUpIcon",
};
