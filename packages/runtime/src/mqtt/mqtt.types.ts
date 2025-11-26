import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.string();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Mqtt').default('Mqtt'),
	direction: z.enum(['publish', 'subscribe']).default('publish'),
	topic: z.string().default(''),
});

export type Data = z.infer<typeof dataSchema>;
