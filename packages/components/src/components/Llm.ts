import { BaseComponent, BaseComponentData } from './BaseComponent';
import { ChatOllama, ChatOllamaInput } from '@langchain/ollama';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

export type LlmData = {
	provider: 'ollama';
	prompt: string;
	system: string;
} & ChatOllamaInput;

export type LlmValueType = boolean;

export class Llm extends BaseComponent<LlmValueType> {
	private readonly model: BaseChatModel;
	private promptVariables = new Map<string, string>();
	private abortController = new AbortController();

	constructor(private readonly data: BaseComponentData & LlmData) {
		super(data, false);

		this.model = new ChatOllama(data);
	}

	setVariable(key: string, value: unknown) {
		this.promptVariables.set(key, String(value));
	}

	async invoke() {
		this.abortController.abort('Next invocation');
		this.abortController = new AbortController();
		if (!this.model) return;
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

		try {
			const result = await this.model.invoke(messages, {
				signal: this.abortController.signal,
			});
			this.eventEmitter.emit('output', result.content);
			this.value = false;
		} catch (e) {
			console.log(e);
			this.value = false;
		}
	}
}
