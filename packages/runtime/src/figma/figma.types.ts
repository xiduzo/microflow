import { z } from 'zod';
import { baseDataSchema, rgbaSchema } from '../base.types';

export const valueSchema = z.union([z.string(), z.number(), z.boolean(), rgbaSchema]);
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	variableId: z.string().default('').default(''),
	resolvedType: z.enum(['FLOAT', 'STRING', 'BOOLEAN', 'COLOR']).default('STRING').default('STRING'),
	initialValue: valueSchema.default('').default(''),
	debounceTime: z.number().default(100).default(100),
});

export type Data = z.infer<typeof dataSchema>;
