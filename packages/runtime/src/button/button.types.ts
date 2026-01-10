import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.union([z.boolean(), z.number()]);
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Button').default('Button'),
	pin: z.union([z.number(), z.string()]).default(6),
	isPullup: z.boolean().default(false),
	isPulldown: z.boolean().default(false),
	holdtime: z.number().default(500),
	invert: z.boolean().default(false),
});
export type Data = z.infer<typeof dataSchema>;
