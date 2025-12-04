import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

const smoothAverageSchema = baseDataSchema.extend({
	instance: z.literal('Smooth').default('Smooth'),
	type: z.literal('smooth').default('smooth'),
	attenuation: z.number().default(0.995),
});

const movingAverageSchema = baseDataSchema.extend({
	instance: z.literal('MovingAverage').default('MovingAverage'),
	type: z.literal('movingAverage').default('movingAverage'),
	windowSize: z.number().default(25),
});

export const dataSchema = z
	.discriminatedUnion('type', [smoothAverageSchema, movingAverageSchema])
	.default(smoothAverageSchema.parse({ type: 'smooth' }));

export type SmoothAverage = z.infer<typeof smoothAverageSchema>;
export type MovingAverage = z.infer<typeof movingAverageSchema>;
export type Data = z.infer<typeof dataSchema>;
