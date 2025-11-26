import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const buzzDataSchema = baseDataSchema.extend({
	instance: z.literal('Piezo').default('Piezo'),
	type: z.literal('buzz').default('buzz'),
	duration: z.number().default(500),
	frequency: z.number().default(440),
	pin: z.number().default(11),
});

const noteSchema = z.tuple([z.string().nullable(), z.number()]);

const songDataSchema = baseDataSchema.extend({
	instance: z.literal('Piezo').default('Piezo'),
	type: z.literal('song').default('song'),
	song: z.array(noteSchema).default([]),
	tempo: z.number().default(120),
	pin: z.number().default(11),
});

export const dataSchema = z
	.discriminatedUnion('type', [buzzDataSchema, songDataSchema])
	.default(buzzDataSchema.parse({ type: 'buzz' }));

export type BuzzData = z.infer<typeof buzzDataSchema>;
export type Note = z.infer<typeof noteSchema>;
export type SongData = z.infer<typeof songDataSchema>;
export type Data = z.infer<typeof dataSchema>;
