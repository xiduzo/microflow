import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const rangeSchema = z.object({
	min: z.number(),
	max: z.number(),
});

export type Range = z.infer<typeof rangeSchema>;

export const valueSchema = z.tuple([z.number(), z.number()]);
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('RangeMap').default('RangeMap'),
	from: rangeSchema.default({ min: 0, max: 1023 }),
	to: rangeSchema.default({ min: 0, max: 1023 }),
});

export type Data = z.infer<typeof dataSchema>;
