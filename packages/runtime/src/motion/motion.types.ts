import { z } from 'zod';
import { baseDataSchema } from '../base.types';
import { type Controller, MOTION_CONTROLLERS } from './motion.constants';

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Motion').default('Motion'),
	controller: z.enum(MOTION_CONTROLLERS).default('HCSR501'),
	pin: z.union([z.number(), z.string()]).default('8'),
});

export type Data = z.infer<typeof dataSchema>;
export type { Controller };
