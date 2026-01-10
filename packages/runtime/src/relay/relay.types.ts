import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Relay').default('Relay'),
	pin: z.union([z.number(), z.string()]).default(10),
	type: z.enum(['NO', 'NC']).default('NO'),
});

export type Data = z.infer<typeof dataSchema>;
