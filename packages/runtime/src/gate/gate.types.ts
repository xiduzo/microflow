import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Gate').default('Gate'),
	gate: z.enum(['or', 'and', 'xor', 'nor', 'nand', 'xnor']).default('and'),
});

export type Data = z.infer<typeof dataSchema>;
