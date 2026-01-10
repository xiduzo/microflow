import { z } from 'zod';
import { baseDataSchema } from '../base.types';
import { COMPARE_SUB_VALIDATORS } from './compare.constants';

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

const booleanDataSchema = baseDataSchema.extend({
	instance: z.literal('Compare').default('Compare'),
	validator: z.literal('boolean').default('boolean'),
	subValidator: z.enum(COMPARE_SUB_VALIDATORS.boolean).default('true'),
});

const textDataSchema = baseDataSchema.extend({
	instance: z.literal('Compare').default('Compare'),
	validator: z.literal('text').default('text'),
	subValidator: z.enum(COMPARE_SUB_VALIDATORS.text).default('equal to'),
	text: z.string(),
});

const oddEvenDataSchema = baseDataSchema.extend({
	instance: z.literal('Compare').default('Compare'),
	validator: z.literal('oddEven').default('oddEven'),
	subValidator: z.enum(COMPARE_SUB_VALIDATORS.oddEven).default('even'),
});

const numberDataSchema = baseDataSchema.extend({
	instance: z.literal('Compare').default('Compare'),
	validator: z.literal('number').default('number'),
	subValidator: z.enum(COMPARE_SUB_VALIDATORS.number).default('equal to'),
	number: z.number().default(0),
});

const rangeDataSchema = baseDataSchema.extend({
	instance: z.literal('Compare').default('Compare'),
	validator: z.literal('range').default('range'),
	subValidator: z.enum(COMPARE_SUB_VALIDATORS.range).default('between'),
	range: z
		.object({
			min: z.number().default(0),
			max: z.number().default(100),
		})
		.default({ min: 0, max: 100 }),
});

export const dataSchema = z
	.discriminatedUnion('validator', [
		booleanDataSchema,
		textDataSchema,
		oddEvenDataSchema,
		numberDataSchema,
		rangeDataSchema,
	])
	.default(booleanDataSchema.parse({ validator: 'boolean' }))
	.catch(error => {
		console.error(error);
		return booleanDataSchema.parse({ validator: 'boolean' });
	});

export type BooleanData = z.infer<typeof booleanDataSchema>;
export type TextData = z.infer<typeof textDataSchema>;
export type NumberData = z.infer<typeof oddEvenDataSchema>;
export type SingleNumberData = z.infer<typeof numberDataSchema>;
export type RangeNumberData = z.infer<typeof rangeDataSchema>;
export type Data = z.infer<typeof dataSchema>;
