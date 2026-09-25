import { z } from "zod";
import { baseDataSchema } from "../_base/_base.schema";

export const valueSchema = z.string();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
  instance: z.literal("Mqtt").default("Mqtt"),
  direction: z.enum(["publish", "subscribe"]).default("subscribe"),
  brokerId: z.string().default(""),
  topic: z.string().default(""),
  qos: z.enum(["0", "1", "2"]).default("1"),
  retain: z.boolean().default(false),
});

export type Data = z.infer<typeof dataSchema>;

export const defaults = {
  ...dataSchema.parse({}),
  group: "sense",
  tags: ["value", "source", "action", "external"],
  label: "MQTT",
  description: "Send and receive real-time messages over a network using MQTT protocol",
  icon: "RadioTowerIcon",
};
