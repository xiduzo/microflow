import type { FigmaData, FigmaValueType, RGBA } from '@microflow/hardware';
import {
	FigmaVariable,
	useFigmaVariable,
	useFigmaVariables,
	useMqttStore,
} from '@microflow/mqtt-provider/client';
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
import { RgbaColorPicker } from 'react-colorful';
import { useNodeValue } from '../../../stores/node-data';

export function Figma(props: Props) {
	const { connectedClients } = useMqttStore();
	const pluginConnected =
		connectedClients.find(({ appName }) => appName === 'plugin')?.status === 'connected';

	useValueSync({ variableId: props.data?.variableId, nodeId: props.id });

	return (
		<NodeContainer
			{...props}
			error={!pluginConnected ? 'Figma plugin is not connected' : undefined}
		>
			<Value />
			<Settings />
			<FigmaHandles variableId={props.data?.variableId} id={props.id} />
		</NodeContainer>
	);
}

function useValueSync(props: { variableId?: string; nodeId: string }) {
	const { value: figmaValue } = useFigmaVariable(props.variableId);
	const nodeValue = useNodeValue(props.nodeId);
	const { publish, appName, uniqueId } = useMqttStore();

	const lastNodeValue = useRef(nodeValue);
	const lastFigmaValue = useRef(figmaValue);

	console.log(figmaValue, nodeValue);
	// Option 1; the flow updates the node value
	useEffect(() => {
		const stringifiedValue = JSON.stringify(figmaValue);
		console.log({
			stringifiedValue,
			lastFigmaValue: lastFigmaValue.current,
		});
		if (stringifiedValue === lastFigmaValue.current) return;

		lastFigmaValue.current = stringifiedValue;

		// Set the node value
		window.electron.ipcRenderer.send('ipc-external-value', {
			nodeId: props.nodeId,
			value: stringifiedValue,
		});
	}, [figmaValue, props.nodeId]);

	// Option 2; the plugin updates the node value
	useEffect(() => {
		const stringifiedValue = JSON.stringify(nodeValue);
		console.log({
			stringifiedValue,
			lastNodeValue: lastNodeValue.current,
		});
		if (stringifiedValue === lastNodeValue.current) return;

		lastNodeValue.current = stringifiedValue;

		// Set the figma value
		publish(
			`microflow/v1/${uniqueId}/${appName}/variable/${props.variableId}/set`,
			stringifiedValue
		);
	}, [nodeValue, props.variableId, uniqueId, appName, publish]);
}

function FigmaHandles(props: { variableId?: string; id: string }) {
	const updateNodeInternals = useUpdateNodeInternals();
	const { variable } = useFigmaVariable(props.variableId);

	useEffect(() => {
		if (!variable?.resolvedType) return;
		// We need to update the internals when we have the resolvedType
		// So that we do not get the xyflow error: `Couldn't create edge for target handle id...`
		updateNodeInternals(props.id);
	}, [props.id, variable?.resolvedType, updateNodeInternals]);

	return (
		<>
			{variable?.resolvedType === 'BOOLEAN' && (
				<>
					<Handle type='target' position={Position.Left} id='true' offset={-1} />
					<Handle type='target' position={Position.Left} id='toggle' />
					<Handle type='target' position={Position.Left} id='false' offset={1} />
					<Handle type='source' position={Position.Right} id='true' offset={-1} />
					<Handle type='source' position={Position.Right} id='false' offset={1} />
				</>
			)}
			{variable?.resolvedType === 'COLOR' && (
				<>
					<Handle type='target' position={Position.Left} id='red' hint='0-255' offset={-1.5} />
					<Handle type='target' position={Position.Left} id='green' hint='0-255' offset={-0.5} />
					<Handle type='target' position={Position.Left} id='blue' hint='0-255' offset={0.5} />
					<Handle type='target' position={Position.Left} id='opacity' hint='0-100' offset={1.5} />
				</>
			)}
			{variable?.resolvedType === 'FLOAT' && (
				<>
					<Handle type='target' position={Position.Left} id='increment' offset={-1.5} />
					<Handle type='target' position={Position.Left} id='set' offset={-0.5} />
					<Handle type='target' position={Position.Left} id='decrement' offset={0.5} />
					<Handle type='target' position={Position.Left} id='reset' offset={1.5} />
				</>
			)}
			{variable?.resolvedType === 'STRING' && (
				<Handle type='target' position={Position.Left} id='set' />
			)}
			<Handle type='source' position={Position.Right} id='change' />
		</>
	);
}

function Settings() {
	const data = useNodeData<FigmaData>();
	const variables = useFigmaVariables();
	const deleteHandles = useDeleteHandles();

	const { render } = useNodeControls(
		{
			variableId: {
				label: 'variable',
				value: data.variableId!,
				transient: false,
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

function Value() {
	const data = useNodeData<FigmaData>();
	const value = useNodeValue<FigmaValueType>(data.initialValue!);
	const { variable } = useFigmaVariable(data.variableId);
	const variables = useFigmaVariables();

	if (!Object.values(variables).length)
		return <Icons.CloudOff className='text-muted-foreground' size={48} />;
	if (!variable) return <Icons.Variable className='text-muted-foreground' size={48} />;

	switch (variable.resolvedType) {
		case 'BOOLEAN':
			return (
				<section className='flex flex-col items-center gap-2'>
					<Switch className='scale-150 border' checked={Boolean(value)} />
					<span className='text-muted-foreground text-xs'>{variable?.name}</span>
				</section>
			);
		case 'FLOAT':
			return (
				<section className='flex flex-col items-center gap-1'>
					<span className='text-4xl tabular-nums'>{numberFormat.format(Number(value))}</span>
					<span className='text-muted-foreground text-xs'>{variable?.name}</span>
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
					<span className='text-muted-foreground text-xs'>{variable?.name}</span>
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
					<span className='text-muted-foreground text-xs'>{variable?.name}</span>
				</section>
			);
		default:
			return (
				<section className='flex flex-col items-center gap-1'>
					<div>Unknown type</div>
					<span className='text-muted-foreground text-xs'>{variable?.name}</span>
				</section>
			);
	}
}

type Props = BaseNode<FigmaData>;
Figma.defaultProps = {
	data: {
		group: 'external',
		tags: ['output', 'input'],
		label: 'Figma',
		variableId: '',
		icon: 'FigmaIcon',
		resolvedType: 'STRING',
		initialValue: '',
		debounceTime: 100,
		description:
			'Connect your flow to Figma design files to control colors, numbers, and text from your device',
	} satisfies Props['data'],
};

const DEFAULT_FIGMA_VALUE_PER_TYPE: Record<FigmaVariable['resolvedType'], FigmaValueType> = {
	BOOLEAN: false,
	FLOAT: 0,
	STRING: '-',
	COLOR: { r: 0, g: 0, b: 0, a: 1 },
};
