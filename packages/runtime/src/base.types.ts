import { Board } from 'johnny-five';
import { z } from 'zod';

export const baseDataSchema = z.looseObject({
	id: z.string().optional(),
	instance: z.string().optional(),
	board: z.instanceof(Board).optional(),
});

export type BaseData = z.infer<typeof baseDataSchema>;

export const messageSchema = z.object({
	type: z.literal('message').default('message'),
	source: z.string(),
	sourceHandle: z.string(),
	value: z.unknown(),
	edgeId: z.string().optional(),
});

export const rgbaSchema = z.looseObject({
	r: z.number(),
	g: z.number(),
	b: z.number(),
	a: z.number(),
});

export type RGBA = z.infer<typeof rgbaSchema>;
