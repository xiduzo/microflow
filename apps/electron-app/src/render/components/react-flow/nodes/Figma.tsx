import type { FigmaData, FigmaValueType, RGBA } from '@microflow/components';
import { FigmaVariable, useFigmaVariable, useMqttStore } from '@microflow/mqtt-provider/client';
import {
	Icons,
	Switch,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from '@microflow/ui';
import { Position, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect, useMemo, useRef } from 'react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useDeleteHandles, useNodeControls, useNodeData } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { RgbaColorPicker } from 'react-colorful';
import { useDebounceValue } from 'usehooks-ts';

export function Figma(props: Props) {
	const { connectedClients } = useMqttStore();
	const pluginConnected =
		connectedClients.find(({ appName }) => appName === 'plugin')?.status === 'connected';

	const { variables, variable, value } = useFigmaVariable(props.data?.variableId);

	useEffect(() => {
		// TODO this sometimes interferes with the publish
		// when the next value is already being send to the plugin
		// and the plugin has not processed the previous value yet
		if (value === undefined || value === null) return;

		window.electron.ipcRenderer.send('ipc-external-value', {
			nodeId: props.id,
			value,
		});
	}, [value, props.id]);

	return (
		<NodeContainer
			{...props}
			error={!pluginConnected ? 'Figma plugin is not connected' : undefined}
		>
			<Value variable={variable} hasVariables={!!Array.from(Object.values(variables)).length} />
			<Settings />
			<FigmaHandles variable={variable} id={props.id} />
		</NodeContainer>
	);
}

function FigmaHandles(props: { variable?: FigmaVariable; id: string }) {
	const updateNodeInternals = useUpdateNodeInternals();

	useEffect(() => {
		if (!props.variable?.resolvedType) return;
		// We need to update the internals when we have the resolvedType
		// So that we do not get the xyflow error: `Couldn't create edge for target handle id...`
		updateNodeInternals(props.id);
	}, [props.id, props.variable?.resolvedType, updateNodeInternals]);

	return (
		<>
			{props.variable?.resolvedType === 'BOOLEAN' && (
				<>
					<Handle type='target' position={Position.Left} id='true' offset={-1} />
					<Handle type='target' position={Position.Left} id='toggle' />
					<Handle type='target' position={Position.Left} id='false' offset={1} />
					<Handle type='source' position={Position.Right} id='true' offset={-1} />
					<Handle type='source' position={Position.Right} id='false' offset={1} />
				</>
			)}
			{props.variable?.resolvedType === 'COLOR' && (
				<>
					<Handle type='target' position={Position.Left} id='red' hint='0-255' offset={-1.5} />
					<Handle type='target' position={Position.Left} id='green' hint='0-255' offset={-0.5} />
					<Handle type='target' position={Position.Left} id='blue' hint='0-255' offset={0.5} />
					<Handle type='target' position={Position.Left} id='opacity' hint='0-100' offset={1.5} />
				</>
			)}
			{props.variable?.resolvedType === 'FLOAT' && (
				<>
					<Handle type='target' position={Position.Left} id='increment' offset={-1.5} />
					<Handle type='target' position={Position.Left} id='set' offset={-0.5} />
					<Handle type='target' position={Position.Left} id='decrement' offset={0.5} />
					<Handle type='target' position={Position.Left} id='reset' offset={1.5} />
				</>
			)}
			{props.variable?.resolvedType === 'STRING' && (
				<Handle type='target' position={Position.Left} id='set' />
			)}
			<Handle type='source' position={Position.Right} id='change' />
		</>
	);
}

function Settings() {
	const data = useNodeData<FigmaData>();
	const { variables } = useFigmaVariable();
	console.log('[Figma] variables', variables);
	const deleteHandles = useDeleteHandles();

	const { render } = useNodeControls(
		{
			variableId: {
				label: 'variable',
				value: data.variableId!,
				options: Object.values(variables).reduce(
					(curr, variable) => {
						curr[variable.name] = variable.id;
						return curr;
					},
					{} as Record<string, string>
				),
				onChange: event => {
					const selectedVariableType = Array.from(Object.values(variables)).find(
						({ id }) => id === event
					)?.resolvedType;

					const booleanHandles = ['true', 'toggle', 'false'] as const;
					const colorHandles = ['red', 'green', 'blue', 'opacity'] as const;
					const floatHandles = ['increment', 'set', 'decrement', 'reset'] as const;
					const allHandles = [...booleanHandles, ...colorHandles, ...floatHandles] as const;

					switch (selectedVariableType) {
						case 'BOOLEAN':
							deleteHandles(
								allHandles.filter(handle => !['true', 'toggle', 'false'].includes(handle))
							);
							break;
						case 'COLOR':
							deleteHandles(
								allHandles.filter(handle => !['red', 'green', 'blue', 'opacity'].includes(handle))
							);
							break;
						case 'FLOAT':
							deleteHandles(
								allHandles.filter(handle => !['increment', 'set', 'decrement'].includes(handle))
							);
							break;
						case 'STRING':
							deleteHandles(allHandles.filter(handle => !['set'].includes(handle)));
							break;
					}
					// IDEA set initial value?
				},
			},
			debounceTime: {
				value: data.debounceTime!,
				min: 10,
				max: 500,
				step: 10,
				label: 'debounce (ms)',
			},
		},
		[variables]
	);

	return <>{render()}</>;
}

const numberFormat = new Intl.NumberFormat('en-US', {
	maximumFractionDigits: 2,
});

function Value(props: { variable?: FigmaVariable; hasVariables: boolean }) {
	const data = useNodeData<FigmaData>();
	const value = useNodeValue<FigmaValueType>(data.initialValue!);

	const lastPublishedValue = useRef<string>();
	const { publish, appName, uniqueId } = useMqttStore();
	const [debouncedValue] = useDebounceValue(value, data.debounceTime ?? 100);

	const topic = useMemo(
		() => `microflow/v1/${uniqueId}/${appName}/variable/${props.variable?.id}/set`,
		[uniqueId, appName, props.variable]
	);

	useEffect(() => {
		if (debouncedValue === undefined) return;

		const valueToPublish = JSON.stringify(debouncedValue);

		if (lastPublishedValue.current === valueToPublish) return;
		lastPublishedValue.current = valueToPublish;

		publish(topic, valueToPublish);
	}, [debouncedValue, topic]);

	if (!props.hasVariables) return <Icons.CloudOff className='text-muted-foreground' size={48} />;
	if (!props.variable) return <Icons.Variable className='text-muted-foreground' size={48} />;

	switch (props.variable.resolvedType) {
		case 'BOOLEAN':
			return (
				<section className='flex flex-col items-center gap-2'>
					<Switch className='scale-150 border' checked={Boolean(value)} />
					<span className='text-muted-foreground text-xs'>{props.variable?.name}</span>
				</section>
			);
		case 'FLOAT':
			return (
				<section className='flex flex-col items-center gap-1'>
					<span className='text-4xl tabular-nums'>{numberFormat.format(Number(value))}</span>
					<span className='text-muted-foreground text-xs'>{props.variable?.name}</span>
				</section>
			);
		case 'STRING':
			return (
				<section className='flex flex-col items-center gap-1'>
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<div className='-mx-8 max-w-48 max-h-32 text-wrap overflow-hidden pointer-events-auto'>
									{String(value)}
								</div>
							</TooltipTrigger>
							<TooltipContent className='max-w-64'>{String(value)}</TooltipContent>
						</Tooltip>
					</TooltipProvider>
					<span className='text-muted-foreground text-xs'>{props.variable?.name}</span>
				</section>
			);
		case 'COLOR':
			return (
				<section className='flex flex-col items-center gap-1'>
					<RgbaColorPicker
						color={{
							r: Math.round((value as RGBA).r * 255),
							g: Math.round((value as RGBA).g * 255),
							b: Math.round((value as RGBA).b * 255),
							a: (value as RGBA).a,
						}}
					/>
					<span className='text-muted-foreground text-xs'>{props.variable?.name}</span>
				</section>
			);
		default:
			return (
				<section className='flex flex-col items-center gap-1'>
					<div>Unknown type</div>
					<span className='text-muted-foreground text-xs'>{props.variable?.name}</span>
				</section>
			);
	}
}

type Props = BaseNode<FigmaData>;
Figma.defaultProps = {
	data: {
		group: 'external',
		tags: ['input', 'output'],
		label: 'Figma',
		variableId: '',
		resolvedType: 'STRING',
		initialValue: '',
		debounceTime: 100,
		description: 'Connect and manipulate Figma variables',
	} satisfies Props['data'],
};

const DEFAULT_FIGMA_VALUE_PER_TYPE: Record<FigmaVariable['resolvedType'], FigmaValueType> = {
	BOOLEAN: false,
	FLOAT: 0,
	STRING: '-',
	COLOR: { r: 0, g: 0, b: 0, a: 1 },
};
