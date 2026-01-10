import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Calculate').default('Calculate'),
	function: z
		.enum([
			'add',
			'subtract',
			'multiply',
			'divide',
			'modulo',
			'max',
			'min',
			'pow',
			'ceil',
			'floor',
			'round',
		])
		.default('add'),
});

export type Data = z.infer<typeof dataSchema>;
