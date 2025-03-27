import { Position, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeId, useNodeSettings } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { useEffect, useMemo, useState } from 'react';
import { LlmData, LlmValueType } from '@microflow/components';
import { IconWithValue } from '../IconWithValue';

export function Llm(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="invoke" />
			<Handle type="source" position={Position.Right} id="output" />
			<DynamicHandles />
		</NodeContainer>
	);
}

function DynamicHandles() {
	const { settings } = useNodeSettings<LlmData>();
	const id = useNodeId();

	const update = useUpdateNodeInternals();

	const handles = useMemo(() => {
		const matches = settings.prompt?.match(/{{(.*?)}}/g) ?? [];
		return Array.from(new Set(matches.map(match => match.replace('{{', '').replace('}}', ''))));
	}, [settings.prompt]);

	useEffect(() => {
		update(id);
	}, [handles, id, update]);

	return (
		<>
			{handles.slice(0, 7).map((handle, index) => (
				<Handle
					key={handle}
					type="target"
					position={Position.Bottom}
					id={handle}
					offset={index * 1 - 3}
				/>
			))}
		</>
	);
}

function Value() {
	const data = useNodeData<LlmData>();
	const value = useNodeValue<LlmValueType>(false);

	return (
		<IconWithValue
			icon={value ? 'BotMessageSquare' : 'Bot'}
			iconClassName={value ? 'animate-pulse' : ''}
			value={value ? 'Thinking...' : !!data.model ? data.model : 'No model selected'}
		/>
	);
}

function Settings() {
	const { pane, settings } = useNodeSettings<LlmData>();
	const [models, setModels] = useState<string[]>([]);

	useEffect(() => {
		async function getModels() {
			switch (settings.provider) {
				case 'ollama':
					const ollamaModelsResponse = await fetch('http://localhost:11434/api/tags');
					const ollamaModels = await ollamaModelsResponse.json();
					setModels(ollamaModels.models.map((model: { model: string }) => model.model));
					break;
				default:
					return setModels([]);
			}
		}

		getModels();
	}, [settings.provider]);

	useEffect(() => {
		if (!pane) return;

		const provider = pane.addBinding(settings, 'provider', {
			type: 'list',
			disabled: true,
			index: 0,
			options: [{ text: 'ollama', value: 'ollama' }],
		});

		const model = pane.addBinding(settings, 'model', {
			index: 1,
			type: 'list',
			options: models.map((model: string) => ({ text: model, value: model })),
		});

		const system = pane.addBinding(settings, 'system', {
			index: 2,
			view: 'textarea',
			rows: 5,
		});

		const prompt = pane.addBinding(settings, 'prompt', {
			index: 3,
			view: 'textarea',
			rows: 5,
		});

		return () => {
			provider.dispose();
			model.dispose();
			system.dispose();
			prompt.dispose();
		};
	}, [pane, settings, models]);

	return null;
}

type Props = BaseNode<LlmData>;
Llm.defaultProps = {
	data: {
		group: 'external',
		tags: ['output'],
		label: 'LLM',
		provider: 'ollama',
		model: '',
		prompt: '',
		system: '',
		description: 'Interact with a Large Language Model (LLM)',
	},
};
