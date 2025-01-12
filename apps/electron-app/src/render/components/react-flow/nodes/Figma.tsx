import type { FigmaData, FigmaValueType, RGBA } from '@microflow/components';
import {
	FigmaVariable,
	useFigma,
	useFigmaVariable,
	useMqtt,
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
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { RgbaColorPicker } from 'react-colorful';
import { useDebounceValue } from 'usehooks-ts';

export function Figma(props: Props) {
	const { connectedClients } = useMqtt();

	const { variables, variable, value } = useFigmaVariable(props.data?.variableId);

	const isDisconnected = [undefined, 'disconnected'].includes(connectedClients.get('plugin'));

	useEffect(() => {
		// TODO this sometimes interferes with the publish
		// when the next value is already being send to the plugin
		// and the plugin has not processed the previous value yet
		if (value === undefined || value === null) return;

		window.electron.ipcRenderer.send('ipc-external-value', { nodeId: props.id, value });
	}, [value, props.id]);

	useEffect(() => {
		return window.electron.ipcRenderer.on<{ from: string; variableId: string; value: unknown }>(
			'ipc-deep-link',
			result => {
				console.debug(`[IPC-DEEP-LINK] <<<`, result);

				if (!result.success) return;
				if (result.data.from !== 'figma') return;
				if (result.data.variableId !== variable?.id) return;

				window.electron.ipcRenderer.send('ipc-external-value', {
					nodeId: props.id,
					value: result.data.value,
				});
			},
		);
	}, [variable?.id, props.id]);

	return (
		<NodeContainer {...props} error={isDisconnected ? 'Figma plugin is not connected' : undefined}>
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
					<Handle type="target" position={Position.Left} id="true" offset={-1} />
					<Handle type="target" position={Position.Left} id="toggle" />
					<Handle type="target" position={Position.Left} id="false" offset={1} />
					<Handle type="source" position={Position.Right} id="true" offset={-1} />
					<Handle type="source" position={Position.Right} id="false" offset={1} />
				</>
			)}
			{props.variable?.resolvedType === 'COLOR' && (
				<>
					<Handle type="target" position={Position.Left} id="red" hint="0-255" offset={-1.5} />
					<Handle type="target" position={Position.Left} id="green" hint="0-255" offset={-0.5} />
					<Handle type="target" position={Position.Left} id="blue" hint="0-255" offset={0.5} />
					<Handle type="target" position={Position.Left} id="opacity" hint="0-100" offset={1.5} />
				</>
			)}
			{props.variable?.resolvedType === 'FLOAT' && (
				<>
					<Handle type="target" position={Position.Left} id="increment" offset={-1.5} />
					<Handle type="target" position={Position.Left} id="set" offset={-0.5} />
					<Handle type="target" position={Position.Left} id="decrement" offset={0.5} />
					<Handle type="target" position={Position.Left} id="reset" offset={1.5} />
				</>
			)}
			{props.variable?.resolvedType === 'STRING' && (
				<Handle type="target" position={Position.Left} id="set" />
			)}
			<Handle type="source" position={Position.Right} id="change" />
		</>
	);
}

function Settings() {
	const { pane, settings, setHandlesToDelete } = useNodeSettings<FigmaData>();

	const { variableTypes } = useFigma();

	useEffect(() => {
		if (!pane) return;

		const initialVariableType = Array.from(Object.values(variableTypes)).find(
			({ id }) => id === settings.variableId,
		)?.resolvedType;

		const variableIdbinding = pane
			.addBinding(settings, 'variableId', {
				index: 0,
				view: 'list',
				label: 'variable',
				disabled: !Object.keys(variableTypes).length,
				value: settings.variableId,
				options: Array.from(Object.entries(variableTypes)).map(([, variable]) => ({
					value: variable.id,
					text: variable.name,
				})),
			})
			.on('change', ({ value }) => {
				const selectedVariableType = Array.from(Object.values(variableTypes)).find(
					({ id }) => id === value,
				)?.resolvedType;

				if (selectedVariableType) {
					settings.resolvedType = selectedVariableType;
					settings.initialValue = DEFAULT_FIGMA_VALUE_PER_TYPE[selectedVariableType];
				}

				if (selectedVariableType === initialVariableType) {
					setHandlesToDelete([]);
					return;
				}

				switch (initialVariableType) {
					case 'BOOLEAN':
						setHandlesToDelete(['true', 'toggle', 'false']);
						break;
					case 'COLOR':
						setHandlesToDelete(['red', 'green', 'blue', 'opacity']);
						break;
					case 'FLOAT':
						setHandlesToDelete(['increment', 'set', 'decrement']);
						break;
					case 'STRING':
						setHandlesToDelete(['set']);
						break;
				}
			});

		settings.debounceTime ??= 100; // TODO: in next version make sure this is set in the default props
		const debounceTimeBinding = pane.addBinding(settings, 'debounceTime', {
			index: 1,
			min: 10,
			max: 500,
			step: 10,
			label: 'update frequency (ms)',
		});

		return () => {
			variableIdbinding.dispose();
			debounceTimeBinding.dispose();
		};
	}, [pane, settings, variableTypes]);

	return null;
}

const numberFormat = new Intl.NumberFormat('en-US', {
	maximumFractionDigits: 2,
});

function Value(props: { variable?: FigmaVariable; hasVariables: boolean }) {
	const data = useNodeData<FigmaData>();
	const value = useNodeValue<FigmaValueType>(data.initialValue!);

	const lastPublishedValue = useRef<string>();
	const { publish, appName, uniqueId } = useMqtt();
	const [debouncedValue] = useDebounceValue(value, data.debounceTime ?? 100);

	const topic = useMemo(
		() => `microflow/v1/${uniqueId}/${appName}/variable/${props.variable?.id}/set`,
		[uniqueId, appName, props.variable],
	);

	useEffect(() => {
		if (debouncedValue === undefined) return;

		const valueToPublish = JSON.stringify(debouncedValue);

		if (lastPublishedValue.current === valueToPublish) return;
		lastPublishedValue.current = valueToPublish;

		publish(topic, valueToPublish);
	}, [debouncedValue, topic]);

	if (!props.hasVariables) return <Icons.CloudOff className="text-muted-foreground" size={48} />;
	if (!props.variable) return <Icons.Variable className="text-muted-foreground" size={48} />;

	switch (props.variable.resolvedType) {
		case 'BOOLEAN':
			return (
				<section className="flex flex-col items-center gap-2">
					<Switch className="scale-150 border" checked={Boolean(value)} />
					<span className="text-muted-foreground text-xs">{props.variable?.name}</span>
				</section>
			);
		case 'FLOAT':
			return (
				<section className="flex flex-col items-center gap-1">
					<span className="text-4xl tabular-nums">{numberFormat.format(Number(value))}</span>
					<span className="text-muted-foreground text-xs">{props.variable?.name}</span>
				</section>
			);
		case 'STRING':
			return (
				<section className="flex flex-col items-center gap-1">
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<div className="-mx-8 max-w-48 max-h-32 text-wrap overflow-hidden pointer-events-auto">
									{String(value)}
								</div>
							</TooltipTrigger>
							<TooltipContent className="max-w-64">{String(value)}</TooltipContent>
						</Tooltip>
					</TooltipProvider>
					<span className="text-muted-foreground text-xs">{props.variable?.name}</span>
				</section>
			);
		case 'COLOR':
			return (
				<section className="flex flex-col items-center gap-1">
					<RgbaColorPicker
						color={{
							r: Math.round((value as RGBA).r * 255),
							g: Math.round((value as RGBA).g * 255),
							b: Math.round((value as RGBA).b * 255),
							a: (value as RGBA).a,
						}}
					/>
					<span className="text-muted-foreground text-xs">{props.variable?.name}</span>
				</section>
			);
		default:
			return (
				<section className="flex flex-col items-center gap-1">
					<div>Unknown type</div>
					<span className="text-muted-foreground text-xs">{props.variable?.name}</span>
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
	} satisfies Props['data'],
};

const DEFAULT_FIGMA_VALUE_PER_TYPE: Record<FigmaVariable['resolvedType'], FigmaValueType> = {
	BOOLEAN: false,
	FLOAT: 0,
	STRING: '-',
	COLOR: { r: 0, g: 0, b: 0, a: 1 },
};
