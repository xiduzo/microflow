import { z } from 'zod';
import { baseDataSchema } from '../base.types';

export const valueSchema = z.boolean();
export type Value = z.infer<typeof valueSchema>;

export const dataSchema = baseDataSchema.extend({
	instance: z.literal('Llm').default('Llm'),
	provider: z.literal('ollama').default('ollama'),
	model: z.string().default(''),
	prompt: z.string().default(''),
	system: z.string().default(''),
	baseUrl: z.string().default('http://localhost:11434'),
	frequencyPenalty: z.number().default(0.5),
	temperature: z.number().default(1.0),
	topK: z.number().default(50),
	topP: z.number().default(0.9),
	mirostat: z.number().default(0),
	mirostatTau: z.number().default(5),
	mirostatEta: z.number().default(0.1),
	repeatPenalty: z.number().default(1.1),
	typicalP: z.number().default(0.9),
	presencePenalty: z.number().default(0.5),
	repeatLastN: z.number().default(64),
});

export type Data = z.infer<typeof dataSchema>;
