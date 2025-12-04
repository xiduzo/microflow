import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Trigger').default('Trigger'),
	relative: z.boolean().default(false),
	behaviour: z.enum(['increasing', 'decreasing']).default('decreasing'),
	threshold: z.number().default(5),
	within: z.number().default(250),
});

export type Data = z.infer<typeof dataSchema>;
