import { BaseComponent, BaseComponentData } from './BaseComponent';
import { ChatOllama } from '@langchain/ollama';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

export type LlmData = {
	provider: 'ollama';
	model: string;
	prompt: string;
	system: string;
};
export type LlmValueType = boolean;

export class Llm extends BaseComponent<LlmValueType> {
	private readonly model: BaseChatModel;
	private promptVariables = new Map<string, string>();

	constructor(private readonly data: BaseComponentData & LlmData) {
		super(data, false);

		this.model = new ChatOllama({
			model: data.model,
		});
	}

	setVariable(key: string, value: unknown) {
		this.promptVariables.set(key, String(value));
	}

	async invoke() {
		this.value = true;
		const messages: (SystemMessage | HumanMessage)[] = [];

		if (!!this.data.system) {
			messages.push(new SystemMessage(this.data.system));
		}

		let prompt = this.data.prompt;
		this.promptVariables.forEach((value, key) => {
			prompt = prompt.replace(new RegExp(`{{${key}}}`, 'g'), value);
		});

		messages.push(new HumanMessage(prompt));

		const result = await this.model.invoke(messages);
		this.eventEmitter.emit('output', result.content);
		this.value = false;
	}
}
