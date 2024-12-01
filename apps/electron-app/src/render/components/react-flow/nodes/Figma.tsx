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
import { useEffect, useRef } from 'react';
import { useUpdateNode } from '../../../hooks/useUpdateNode';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { useUploadResult } from '../../../stores/board';
import { RgbaColorPicker } from 'react-colorful';

export function Figma(props: Props) {
	const updateNodeInternals = useUpdateNodeInternals();
	const uploadResult = useUploadResult();
	const lastPublishedValue = useRef<string>();

	const { status, publish, appName, connectedClients, uniqueId } = useMqtt();
	const componentValue = useNodeValue<FigmaValueType>(props.id, undefined);

	const updateNode = useUpdateNode<FigmaData>(props.id);

	const { variables, variable, value } = useFigmaVariable(props.data?.variableId);

	const isDisconnected = [undefined, 'disconnected'].includes(connectedClients.get('plugin'));

	useEffect(() => {
		// TODO this sometimes interferes with the publish
		// when the next value is already being send to the plugin
		// and the plugin has not processed the previous value yet
		if (value === undefined || value === null) return;

		console.debug('<<<', value);

		window.electron.ipcRenderer.send('ipc-external-value', props.id, value);
	}, [value, props.id]);

	useEffect(() => {
		if (status !== 'connected') return;
		if (componentValue === undefined) return;
		if (!variable) return;

		const valueToPublish = JSON.stringify(componentValue);

		if (lastPublishedValue.current === valueToPublish) return;
		lastPublishedValue.current = valueToPublish;

		console.debug('>>>', valueToPublish);
		publish(`microflow/v1/${uniqueId}/${appName}/variable/${variable.id}/set`, valueToPublish);
	}, [componentValue, variable, status, appName, uniqueId]);

	useEffect(() => {
		if (!variable?.resolvedType) return;

		updateNodeInternals(props.id);
		updateNode({}); // Make sure the handles are updated when connection takes place
	}, [variable?.resolvedType, props.id]);

	useEffect(() => {
		if (uploadResult !== 'ready') return;
		if (!variable?.resolvedType) return;

		const value = DEFAULT_FIGMA_VALUE_PER_TYPE[variable.resolvedType];
		window.electron.ipcRenderer.send('ipc-external-value', props.id, value);
	}, [uploadResult, variable?.resolvedType, props.id]);

	useEffect(() => {
		return window.electron.ipcRenderer.on('ipc-deep-link', (event, id, value) => {
			if (event !== 'figma') return;
			if (id !== variable?.id) return;

			// TODO: do some processing on the value received from the plugin
			// Eg. convert the color value to rgba
			// +<number> of -<number> to increment or decrement the value
			// true/false values
			window.electron.ipcRenderer.send('ipc-external-value', props.id, value);

			// TODO: should we already publish the value?
			// this would probably mean we publish it twice but it does not require a
			// microcontroller to be connected and active
		});
	}, [variable?.id, props.id]);

	return (
		<NodeContainer {...props} error={isDisconnected && 'Figma plugin is not connected'}>
			<Value variable={variable} hasVariables={!!Array.from(Object.values(variables)).length} />
			<Settings />
			<FigmaHandles variable={variable} />
		</NodeContainer>
	);
}

function FigmaHandles(props: { variable?: FigmaVariable }) {
	return (
		<>
			{props.variable?.resolvedType === 'BOOLEAN' && (
				<>
					<Handle type="target" position={Position.Left} id="true" offset={-1} />
					<Handle type="target" position={Position.Left} id="toggle" />
					<Handle type="target" position={Position.Left} id="false" offset={1} />
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
					<Handle type="target" position={Position.Left} id="increment" offset={-1} />
					<Handle type="target" position={Position.Left} id="set" />
					<Handle type="target" position={Position.Left} id="decrement" offset={1} />
				</>
			)}
			{props.variable?.resolvedType === 'STRING' && (
				<Handle type="target" position={Position.Left} id="set" />
			)}
			<Handle type="source" position={Position.Bottom} id="change" />
		</>
	);
}

function Settings() {
	const { pane, settings, setHandlesToDelete } = useNodeSettingsPane<FigmaData>();

	const { variableTypes } = useFigma();

	useEffect(() => {
		if (!pane) return;

		const initialVariableType = Array.from(Object.values(variableTypes)).find(
			({ id }) => id === settings.variableId,
		)?.resolvedType;

		pane
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
				if (selectedVariableType === initialVariableType) setHandlesToDelete([]);
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
	}, [pane, settings, variableTypes]);

	return null;
}

function Value(props: { variable?: FigmaVariable; hasVariables: boolean }) {
	const { id } = useNode();
	const value = useNodeValue<FigmaValueType>(id, '');

	if (!props.hasVariables) return <Icons.CloudOff className="text-muted-foreground" size={48} />;
	if (!props.variable) return <Icons.Variable className="text-muted-foreground" size={48} />;

	switch (props.variable.resolvedType) {
		case 'BOOLEAN':
			return (
				<Switch
					className="scale-150 border border-muted-foreground/10"
					disabled
					checked={Boolean(value)}
				/>
			);
		case 'FLOAT':
			return <span className="text-4xl tabular-nums">{Number(value)}</span>;
		case 'STRING':
			return (
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
			);
		case 'COLOR':
			return <RgbaColorPicker color={value as RGBA} />;
		default:
			return <div>Unknown type</div>;
	}
}

type Props = BaseNode<FigmaData, FigmaValueType>;
const DEFAULT_COLOR: RGBA = { r: 0, g: 0, b: 0, a: 1 };
export const DEFAULT_FIGMA_DATA: Props['data'] = {
	label: 'Figma',
	variableId: '',
};
export const DEFAULT_FIGMA_VALUE_PER_TYPE: Record<FigmaVariable['resolvedType'], unknown> = {
	BOOLEAN: false,
	FLOAT: 0,
	STRING: '-',
	COLOR: DEFAULT_COLOR,
};
