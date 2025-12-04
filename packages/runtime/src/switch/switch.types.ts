import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Switch').default('Switch'),
	pin: z.union([z.number(), z.string()]).default(2),
	type: z.enum(['NC', 'NO']).default('NC'),
});

export type Data = z.infer<typeof dataSchema>;
