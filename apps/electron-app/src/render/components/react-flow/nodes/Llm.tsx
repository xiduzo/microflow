import { Position, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeId, useNodeSettings } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { useEffect, useMemo, useRef, useState } from 'react';
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
	const { settings, setHandlesToDelete } = useNodeSettings<LlmData>();
	const id = useNodeId();
	const previousHandles = useRef<string[]>([]);

	const update = useUpdateNodeInternals();

	const handles = useMemo(() => {
		const matches = settings.prompt?.match(/{{(.*?)}}/g) ?? [];
		return Array.from(
			new Set(matches.map(match => match.replace('{{', '').replace('}}', ''))),
		).filter(Boolean);
	}, [settings.prompt]);

	useEffect(() => {
		const difference = handles.filter(handle => !previousHandles.current.includes(handle));
		setHandlesToDelete(difference);
		previousHandles.current = handles;
		update(id);
	}, [handles, id, update, setHandlesToDelete]);

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
	const { settings, addBinding, addFolder } = useNodeSettings<LlmData>();
	const [models, setModels] = useState<string[]>([]);

	useEffect(() => {
		async function getModels() {
			switch (settings.provider) {
				case 'ollama':
					const ollamaModelsResponse = await fetch(`${settings.baseUrl}/api/tags`);
					const ollamaModels = await ollamaModelsResponse.json();
					setModels(ollamaModels.models.map((model: { model: string }) => model.model));
					break;
				default:
					return setModels([]);
			}
		}

		getModels();
	}, [settings.provider, settings.baseUrl]);

	useEffect(() => {
		addBinding('provider', {
			index: 0,
			type: 'list',
			disabled: true,
			options: [{ text: 'ollama', value: 'ollama' }],
		});

		addBinding('model', {
			index: 1,
			type: 'list',
			options: models.map(model => ({ text: model, value: model })),
		});

		addBinding('system', { index: 2, view: 'textarea', rows: 5 });
		addBinding('prompt', { index: 3, view: 'textarea', rows: 5 });

		addFolder({ index: 4, title: 'advanced', expanded: false });

		addBinding('baseUrl', { tag: 'advanced' });
		addBinding('frequencyPenalty', { min: 0, max: 2, step: 0.1, tag: 'advanced' });
		addBinding('temperature', { min: 0.1, max: 2, step: 0.1, tag: 'advanced' });
		addBinding('topK', { min: 1, max: 100, step: 1, tag: 'advanced' });
		addBinding('topP', { min: 0.1, max: 1, step: 0.05, tag: 'advanced' });
		addBinding('mirostat', { min: 0, max: 1, step: 1, tag: 'advanced' });
		addBinding('mirostatTau', { min: 1, max: 10, step: 0.5, tag: 'advanced' });
		addBinding('mirostatEta', { min: 0.01, max: 1, step: 0.05, tag: 'advanced' });
		addBinding('repeatPenalty', { min: 1, max: 2, step: 0.1, tag: 'advanced' });
		addBinding('typicalP', { min: 0.1, max: 1, step: 0.05, tag: 'advanced' });
		addBinding('presencePenalty', { min: 0, max: 2, step: 0.1, tag: 'advanced' });
		addBinding('repeatLastN', { min: 1, max: 256, step: 1, tag: 'advanced' });
	}, [models, addBinding, addFolder]);

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
		baseUrl: 'http://localhost:11434',
		frequencyPenalty: 0.5,
		temperature: 1.0,
		topK: 50,
		topP: 0.9,
		mirostat: 0,
		mirostatTau: 5,
		mirostatEta: 0.1,
		repeatPenalty: 1.1,
		typicalP: 0.9,
		presencePenalty: 0.5,
		repeatLastN: 64,
		description: 'Interact with a Large Language Model (LLM)',
	} satisfies Props['data'],
};
