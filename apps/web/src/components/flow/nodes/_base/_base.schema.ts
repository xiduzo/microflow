import { z } from "zod";
import { COMPONENT_TYPES} from "./_base.types";

// Re-export for convenience
export { COMPONENT_TYPES, type ComponentType, isComponentType } from "./_base.types";

/**
 * Zod schema for validating component type strings.
 * This ensures the `instance` field only accepts valid component types.
 */
export const componentTypeSchema = z.enum(COMPONENT_TYPES);

export const baseDataSchema = z.looseObject({
  id: z.string().optional(),
  instance: componentTypeSchema.optional(),
  subType: z.string().optional(),
  board: z.any().optional(),
});

export type BaseData = z.infer<typeof baseDataSchema>;

export const messageSchema = z.object({
  type: z.literal("message").default("message"),
  source: z.string(),
  sourceHandle: z.string(),
  value: z.unknown(),
  edgeId: z.string().optional(),
});

export const rgbaSchema = z.looseObject({
  r: z.number(),
  g: z.number(),
  b: z.number(),
  a: z.number(),
});

export type RGBA = z.infer<typeof rgbaSchema>;
