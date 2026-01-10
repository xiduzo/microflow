import { z } from 'zod';
import { baseDataSchema } from '../base.types';

/**
 * Function generator is a very versatile way of doing things in mcus
 * it can be used to control timing as well as values. For example a
 * square wave can be used to control on/off cycles of an LED at a
 * specific frequency. As well as values, such as using a
 * sine wave to control a fade value.
 *
 * Function generators can be compounded to produce interesting control signals.
 */
export const waveformTypeSchema = z.enum(['sinus', 'square', 'sawtooth', 'triangle', 'random']);
export type WaveformType = z.infer<typeof waveformTypeSchema>;

export const valueSchema = z.number();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Oscillator').default('Oscillator'),
	waveform: waveformTypeSchema.default('sinus'),
	period: z.number().default(1000),
	amplitude: z.number().default(1),
	phase: z.number().default(0),
	shift: z.number().default(0),
	autoStart: z.boolean().default(true),
});

export type Data = z.infer<typeof dataSchema>;
