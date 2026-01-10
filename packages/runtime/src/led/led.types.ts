import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Led').default('Led'),
	pin: z.union([z.number(), z.string()]).default(13),
});

export type Data = z.infer<typeof dataSchema>;
