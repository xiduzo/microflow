import { Position, useUpdateNodeInternals } from '@xyflow/react';
import { Handle } from '../Handle';
import {
	BaseNode,
	NodeContainer,
	useDeleteHandles,
	useNodeControls,
	useNodeData,
	useNodeId,
} from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LlmData, LlmValueType } from '@microflow/components';
import { IconWithValue } from '../IconWithValue';
import { folder } from 'leva';

export function Llm(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='invoke' />
			<Handle type='source' position={Position.Right} id='output' />
			<DynamicHandles />
		</NodeContainer>
	);
}

function DynamicHandles() {
	const data = useNodeData<LlmData>();
	const id = useNodeId();
	const previousHandles = useRef<string[]>([]);
	const deleteHandles = useDeleteHandles();

	const update = useUpdateNodeInternals();

	const handles = useMemo(() => {
		const matches = data.prompt?.match(/{{(.*?)}}/g) ?? [];
		return Array.from(
			new Set(matches.map(match => match.replace('{{', '').replace('}}', '')))
		).filter(Boolean);
	}, [data.prompt]);

	useEffect(() => {
		const difference = handles.filter(handle => !previousHandles.current.includes(handle));
		deleteHandles(difference);
		previousHandles.current = handles;
		update(id);
	}, [handles, id, update, deleteHandles]);

	return (
		<>
			{handles.slice(0, 7).map((handle, index) => (
				<Handle
					key={handle}
					type='target'
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
	const [models, setModels] = useState<string[]>([]);
	const data = useNodeData<LlmData>();

	const { render } = useNodeControls(
		{
			provider: { value: data.provider, options: ['ollama'], disabled: true },
			models: { value: data.model, options: models },
			system: { value: data.system, rows: 5 },
			prompt: { value: data.prompt, rows: 5 },
			advanced: folder(
				{
					baseUrl: { value: data.baseUrl!, label: 'Base URL' },
					frequencyPenalty: {
						value: data.frequencyPenalty!,
						label: 'Frequency Penalty',
					},
					temperature: { value: data.temperature!, label: 'Temperature' },
					topK: { value: data.topK!, label: 'Top K' },
					topP: { value: data.topP!, label: 'Top P' },
					mirostat: { value: data.mirostat!, label: 'Mirostat' },
					mirostatTau: { value: data.mirostatTau!, label: 'Mirostat Tau' },
					mirostatEta: { value: data.mirostatEta!, label: 'Mirostat Eta' },
					repeatPenalty: {
						value: data.repeatPenalty!,
						label: 'Repeat Penalty',
					},
					typicalP: { value: data.typicalP!, label: 'Typical P' },
					presencePenalty: {
						value: data.presencePenalty!,
						label: 'Presence Penalty',
					},
					repeatLastN: { value: data.repeatLastN!, label: 'Repeat Last N' },
				},
				{ collapsed: true }
			),
		},
		[models]
	);

	useEffect(() => {
		async function getModels() {
			switch (data.provider) {
				case 'ollama':
					const ollamaModelsResponse = await fetch(`${data.baseUrl}/api/tags`);
					const ollamaModels = await ollamaModelsResponse.json();
					setModels(ollamaModels.models.map((model: { model: string }) => model.model));
					break;
				default:
					return setModels([]);
			}
		}

		getModels();
	}, [data.provider, data.baseUrl]);

	return <>{render()}</>;
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
