import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Servo').default('Servo'),
	pin: z.union([z.number(), z.string()]).default(3),
	range: z
		.object({
			min: z.number().default(0),
			max: z.number().default(180),
		})
		.default({ min: 0, max: 180 }),
	type: z.enum(['standard', 'continuous']).default('standard'),
});

export type Data = z.infer<typeof dataSchema>;
