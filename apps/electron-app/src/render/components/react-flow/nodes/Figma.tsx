import type { FigmaData, FigmaValueType, RGBA } from '@microflow/components';
import { FigmaVariable, useFigmaVariable, useMqtt } from '@microflow/mqtt-provider/client';
import {
	Badge,
	Icons,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	Switch,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from '@microflow/ui';
import { Position, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUpdateNode } from '../../../hooks/nodeUpdater';
import { useBoard } from '../../../providers/BoardProvider';
import { deleteEdgesSelector, useNodesEdgesStore } from '../../../store';
import { Handle } from './Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
	useNodeSettings,
} from './Node';

export function Figma(props: Props) {
	const updateNodeInternals = useUpdateNodeInternals();
	const { deleteEdges } = useNodesEdgesStore(useShallow(deleteEdgesSelector));
	const { uploadResult } = useBoard();
	const lastPublishedValue = useRef<string>();

	const { status, publish, appName, connectedClients, uniqueId } = useMqtt();

	const updateNode = useUpdateNode<FigmaData>(props.id);

	const { variables, variable, value } = useFigmaVariable(props.data?.variableId);

	const isDisconnected = [undefined, 'disconnected'].includes(connectedClients.get('plugin'));

	useEffect(() => {
		// TODO this sometimes interferes with the publish
		// when the next value is already being send to the plugin
		// and the plugin has not processed the previous value yet
		if (value !== undefined || value !== null) return;

		window.electron.ipcRenderer.send('ipc-external-value', props.id, value);
	}, [value, props.id]);

	useEffect(() => {
		if (status !== 'connected') return;
		if (props.data?.value === undefined || props.data?.value === null) return;
		if (!variable) return;

		const valueToPublish = JSON.stringify(props.data.value);

		if (lastPublishedValue.current === valueToPublish) return;
		lastPublishedValue.current = valueToPublish;

		publish(`microflow/v1/${uniqueId}/${appName}/variable/${variable.id}/set`, valueToPublish);
	}, [props.data?.value, variable, status, appName, uniqueId]);

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

	return (
		<NodeContainer {...props}>
			<NodeContent>
				{isDisconnected && <Badge variant="destructive">Figma plugin not connected</Badge>}
				<NodeValue className="max-w-48 text-wrap">
					<FigmaHeaderContent
						variable={variable}
						hasVariables={!!Array.from(Object.values(variables)).length}
						value={props.data.value ?? value}
					/>
				</NodeValue>
			</NodeContent>
			<NodeSettings<FigmaData>
				onClose={() => {
					deleteEdges(props.id, ['change']);
				}}
			>
				<FigmaSettings />
			</NodeSettings>
			{variable?.resolvedType === 'BOOLEAN' && (
				<>
					<Handle type="target" position={Position.Left} id="true" offset={-1} />
					<Handle type="target" position={Position.Left} id="toggle" />
					<Handle type="target" position={Position.Left} id="false" offset={1} />
				</>
			)}
			{variable?.resolvedType === 'COLOR' && (
				<>
					<Handle type="target" position={Position.Left} id="red" hint="0-255" offset={-1.5} />
					<Handle type="target" position={Position.Left} id="green" hint="0-255" offset={-0.5} />
					<Handle type="target" position={Position.Left} id="blue" hint="0-255" offset={0.5} />
					<Handle type="target" position={Position.Left} id="opacity" hint="0-100" offset={1.5} />
				</>
			)}
			{variable?.resolvedType === 'FLOAT' && (
				<>
					<Handle type="target" position={Position.Left} id="increment" offset={-1} />
					<Handle type="target" position={Position.Left} id="set" />
					<Handle type="target" position={Position.Left} id="decrement" offset={1} />
				</>
			)}
			{variable?.resolvedType === 'STRING' && (
				<Handle type="target" position={Position.Left} id="set" />
			)}
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function FigmaSettings() {
	const { settings, setSettings } = useNodeSettings<FigmaData>();

	const { variables, variable } = useFigmaVariable(settings?.variableId);

	return (
		<>
			<Select
				disabled={!Array.from(Object.values(variables)).length}
				value={settings.variableId}
				onValueChange={variableId => {
					setSettings({ variableId });
				}}
			>
				<SelectTrigger>{variable?.name ?? 'Select variable'}</SelectTrigger>
				<SelectContent>
					{Array.from(Object.values(variables)).map((variable: FigmaVariable) => (
						<SelectItem key={variable.id} value={variable.id}>
							{variable.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</>
	);
}

function FigmaHeaderContent(props: {
	variable?: FigmaVariable;
	value: unknown;
	hasVariables: boolean;
}) {
	if (!props.hasVariables) {
		return <Icons.Loader2 className="w-12 h-12 animate-spin" />;
	}

	if (!props.variable) {
		return <Icons.Variable className="w-12 h-12 opacity-40" />;
	}

	switch (props.variable.resolvedType) {
		case 'BOOLEAN':
			return (
				<Switch
					className="scale-150 border border-muted-foreground/10"
					disabled
					checked={Boolean(props.value)}
				/>
			);
		case 'FLOAT':
			return <span className="text-4xl tabular-nums">{Number(props.value ?? 0)}</span>;
		case 'STRING':
			return (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<div className="-mx-8 max-w-48 max-h-32 text-wrap overflow-hidden pointer-events-auto">
								{String(props.value ?? '-')}
							</div>
						</TooltipTrigger>
						<TooltipContent className="max-w-64">{String(props.value)}</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			);
		case 'COLOR':
			const { r, g, b, a } = (props.value ?? DEFAULT_COLOR) as RGBA;
			return (
				<div
					className="w-full h-14 rounded-sm bg-green-50 border-2 border-black ring-2 ring-white"
					style={{
						backgroundColor: `rgba(${r * 255},${g * 255},${b * 255},${a * 255})`,
					}}
				></div>
			);
		default:
			return <div>Unknown type</div>;
	}
}

type Props = BaseNode<FigmaData, FigmaValueType>;
const DEFAULT_COLOR: RGBA = { r: 0, g: 0, b: 0, a: 1 };
export const DEFAULT_FIGMA_DATA: Props['data'] = {
	label: 'Figma',
	value: null,
};
export const DEFAULT_FIGMA_VALUE_PER_TYPE: Record<FigmaVariable['resolvedType'], unknown> = {
	BOOLEAN: false,
	FLOAT: 0,
	STRING: '-',
	COLOR: DEFAULT_COLOR,
};
