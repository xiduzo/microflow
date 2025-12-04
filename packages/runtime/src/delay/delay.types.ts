import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Delay').default('Delay'),
	delay: z.number().default(1000),
	forgetPrevious: z.boolean().default(false),
});

export type Data = z.infer<typeof dataSchema>;
