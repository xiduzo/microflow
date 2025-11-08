import { Code, BaseComponentData } from './BaseComponent';
import { ChatOllama, ChatOllamaInput } from '@langchain/ollama';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import logger from 'electron-log/node';

export type LlmData = {
	provider: 'ollama';
	prompt: string;
	system: string;
} & ChatOllamaInput;

export type LlmValueType = boolean;

export class Llm extends Code<LlmValueType, LlmData> {
	private readonly model: BaseChatModel;
	private abortController = new AbortController();

	constructor(data: BaseComponentData & LlmData) {
		super(data, false);

		switch (data.provider) {
			case 'ollama':
				this.model = new ChatOllama(data);
				break;
			default:
				throw new Error(`Unsupported provider: ${data.provider}`);
		}
	}

	async invoke(values: Record<string, unknown>) {
		this.abortController.abort('Next invocation');
		this.abortController = new AbortController();
		if (!this.model) return;
		this.value = true;
		const messages: (SystemMessage | HumanMessage)[] = [];

		if (!!this.data.system) {
			messages.push(new SystemMessage(this.data.system));
		}

		let prompt = this.data.prompt;
		for (const [key, value] of Object.entries(values)) {
			prompt = prompt.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
		}

		messages.push(new HumanMessage(prompt));

		try {
			const result = await this.model.invoke(messages, {
				signal: this.abortController.signal,
			});
			this.emit('output', result.content);
			this.value = false;
		} catch (e) {
			logger.warn(e);
			this.value = false;
		}
	}
}
