import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Hotkey').default('Hotkey'),
	accelerator: z.string().default('X'),
});
export type Data = z.infer<typeof dataSchema>;
