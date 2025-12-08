import z from 'zod';
import { COLORS, DEFAULT_OFF_PIXEL_COLOR } from './pixel.constants';
import { baseDataSchema } from '../base.types';

const valueSchema = z
	.array(
		z.string().regex(/^#([0-9A-F]{3}|[0-9A-F]{6})$/i, {
			message: 'Invalid hex color format. Expected #RGB or #RRGGBB',
		})
	)
	.default([DEFAULT_OFF_PIXEL_COLOR])
	.describe('The colors of the pixel strip');

export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Pixel').default('Pixel'),
	pin: z.number().default(11).describe('The data pin of the pixel strip'),
	length: z.number().min(1).max(144).default(32).describe('The number of pixels in the strip'),
	controller: z
		.enum(['FIRMATA'])
		.default('FIRMATA')
		.describe('The controller used to communicate with the pixel strip'),
	skip_firmware_check: z.boolean().default(true).describe('Whether to skip the firmware check'),
	gamma: z.number().default(2.8).describe('The gamma correction factor for the pixel strip'),
	color_order: z.enum(COLORS).default('BRG').describe('The color order of the pixel strip'),
	presets: z.array(valueSchema).default([[]]).describe('Preset color patterns for the pixel strip'),
});
export type Data = z.infer<typeof dataSchema>;
