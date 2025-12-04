import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Constant').default('Constant'),
	value: z.number().default(1337),
});

export type Data = z.infer<typeof dataSchema>;
