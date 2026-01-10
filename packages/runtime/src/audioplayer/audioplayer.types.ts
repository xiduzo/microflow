import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('AudioPlayer').default('AudioPlayer'),
	audioFiles: z.array(z.string()).default([]).describe('Array of file paths'),
	loop: z.boolean().default(false),
	volume: z.number().min(0).max(1).default(1),
});

export type Data = z.infer<typeof dataSchema>;
