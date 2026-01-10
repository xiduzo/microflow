import { z } from 'zod';
import { baseDataSchema, rgbaSchema } from '../base.types';

export const valueSchema = rgbaSchema;
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Rgb').default('Rgb'),
	pins: z
		.object({
			red: z.number().default(9),
			green: z.number().default(10),
			blue: z.number().default(11),
		})
		.default({ red: 9, green: 10, blue: 11 }),
	isAnode: z.boolean().default(false),
});

export type Data = z.infer<typeof dataSchema>;
