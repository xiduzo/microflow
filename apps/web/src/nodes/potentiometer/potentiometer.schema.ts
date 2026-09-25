import { dataSchema } from "../sensor/sensor.schema";
export { dataSchema, valueSchema, type Data, type Value } from "../sensor/sensor.schema";

export const defaults = {
  ...dataSchema.parse({}),
  subType: "potentiometer",
  group: "sense",
  tags: ["value", "source"],
  label: "Potentiometer",
  description: "Read a knob or slider position — perfect for controlling speed, volume, or brightness",
  icon: "CircleArrowOutUpLeftIcon",
};
