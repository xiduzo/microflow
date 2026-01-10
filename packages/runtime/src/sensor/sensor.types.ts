import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Sensor').default('Sensor'),
	pin: z.union([z.number(), z.string()]).default('A0'),
	type: z.enum(['analog', 'digital']).default('analog'),
	freq: z.number().default(25),
	threshold: z.number().default(1),
});

export type Data = z.infer<typeof dataSchema>;
