import {
	Button,
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	cva,
	Icon,
	Icons,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from '@microflow/ui';
import { LevaPanel, useControls, useCreateStore } from 'leva';
import { Node, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import {
	createContext,
	PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useRef,
} from 'react';
import { createPortal } from 'react-dom';
import { useDeleteEdges, useNodesChange } from '../../../stores/react-flow';
import { NodeType } from '../../../../common/nodes';
import { useDebounceValue } from 'usehooks-ts';
import { useFlowSync } from '../../../hooks/useFlowSync';
import { usePins } from '../../../stores/board';
import { pinDisplayValue } from '../../../../common/pin';

function NodeHeader(props: { error?: string }) {
	const data = useNodeData();

	return (
		<CardHeader>
			<CardTitle>{data.label}</CardTitle>
			<NodeDescription />
			{props.error && (
				<CardAction>
					<TooltipProvider>
						<Tooltip delayDuration={0}>
							<TooltipTrigger className='cursor-help'>
								<Icon icon='OctagonAlert' className='text-red-500' />
							</TooltipTrigger>
							<TooltipContent className='text-red-500'>{props.error}</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				</CardAction>
			)}
		</CardHeader>
	);
}

function NodeDescription() {
	const data = useNodeData();
	const pins = usePins();

	return (
		<CardDescription className='flex gap-4'>
			{'pin' in data && (
				<div className='flex items-center gap-1'>
					<Icons.Cable size={12} />
					<span className='font-extralight'>{pinDisplayValue(data.pin, pins)}</span>
				</div>
			)}
			{'pins' in data &&
				Object.entries(data.pins).map(([key, value]) => (
					<div key={key} className='flex items-center gap-1'>
						<Icons.Cable size={12} />
						<span className='font-extralight'>
							{key}: {String(value)}
						</span>
					</div>
				))}
		</CardDescription>
	);
}

type UseControlParameters = Parameters<typeof useControls>;
export type Controls = Exclude<UseControlParameters[0], string | Function>;

export const useNodeControls = <
	Data extends Record<string, any> = Record<string, any>,
	S extends Controls = Controls,
>(
	controls: S,
	dependencies: unknown[] = []
) => {
	const store = useCreateStore();
	const { selected, id, data } = useNode();
	const isFirstRender = useRef(true);
	const { getNode } = useReactFlow();
	const onNodesChange = useNodesChange();
	const updateNodeInternals = useUpdateNodeInternals();
	const { flowChanged } = useFlowSync();

	const [controlsData, set] = useControls(
		() => ({ label: data.label, ...controls }),
		{ store },
		dependencies
	);
	const lastControlData = useRef(controlsData);

	const [debouncedControlData] = useDebounceValue(controlsData, 500);
	const [selectedDebounce] = useDebounceValue(selected, 30);

	const updateNodeData = useCallback(
		async (data: Record<string, unknown>) => {
			console.debug('[useNodeControls] <updateNodeData>', data);
			const node = getNode(id);
			if (!node) return;

			onNodesChange([
				{
					id: node.id,
					type: 'replace',
					item: {
						...node,
						data: { ...node.data, ...(data as Record<string, unknown>) },
					},
				},
			]);

			updateNodeInternals(node.id);
			await new Promise(resolve => setTimeout(resolve, 500)); // Give react-flow time to apply the changes
			flowChanged();
		},
		[id, getNode, onNodesChange, updateNodeInternals, flowChanged]
	);

	/**
	 * Sometimes it is impossible to set the node data using the controls,
	 * use this handler to forcefully update the node
	 * ⚠️ this might cause descrepencies between the `data` from `useNodeData` and the actual data
	 */
	const setNodeData = useCallback(
		<T extends Record<string, unknown>>(node: Partial<Data>) => {
			updateNodeData(node as T);
		},
		[updateNodeData]
	);

	const render = useCallback(() => {
		if (!selectedDebounce) return null;

		return createPortal(
			<LevaPanel store={store} hideCopyButton fill titleBar={false} />,
			document.getElementById('settings-panels')!
		);
	}, [selectedDebounce, store]);

	useEffect(() => {
		if (isFirstRender.current) {
			isFirstRender.current = false;
			lastControlData.current = controlsData;
			return;
		}

		if (JSON.stringify(lastControlData.current) === JSON.stringify(controlsData)) return;

		lastControlData.current = controlsData;
		updateNodeData(debouncedControlData as Record<string, unknown>);
	}, [debouncedControlData, updateNodeData]);

	/**
	 * Sync the data back to the controls when history is reverted
	 */
	useEffect(() => {
		if (isFirstRender.current) return;

		// Only compare keys which are in the controls data
		const keys = Object.keys(lastControlData.current as Record<string, unknown>);
		const dataKeys = Object.keys(data);

		// Check if any value has changed
		const hasChanged = keys.some(
			key =>
				dataKeys.includes(key) &&
				lastControlData.current[key as keyof typeof lastControlData.current] !==
					data[key as keyof typeof data]
		);
		if (!hasChanged) return;

		if (JSON.stringify(lastControlData.current) === JSON.stringify(data)) return;

		// Only get the keys which are in the controls data
		const newData = Object.fromEntries(Object.entries(data).filter(([key]) => keys.includes(key)));
		// Prevent other effects from running
		lastControlData.current = newData as typeof lastControlData.current;
		set(newData as Parameters<typeof set>[0]);
		console.debug('[useNodeControls] <useEffect>', lastControlData.current, { data, newData });
		flowChanged();
	}, [data, set, flowChanged]);

	return { render, set, setNodeData };
};

/**
 * Forces to delete rendered handles, and connected edges, from an node
 */
export function useDeleteHandles() {
	const id = useNodeId();
	const deleteEdes = useDeleteEdges();

	const updateNodeInternals = useUpdateNodeInternals();

	const deleteHandles = useCallback(
		(handles: string[]) => {
			deleteEdes(id, handles);
			updateNodeInternals(id); // for xyflow to apply the changes of the removed edges
		},
		[id, updateNodeInternals, deleteEdes]
	);

	return deleteHandles;
}

type ContainerProps<T extends Record<string, unknown>> = BaseNode<T>;

const NodeContainerContext = createContext<ContainerProps<Record<string, unknown>>>(
	{} as ContainerProps<Record<string, unknown>>
);

const useNode = <T extends Record<string, unknown>>() =>
	useContext(NodeContainerContext as React.Context<ContainerProps<T>>);

export const useNodeId = () => {
	const { id } = useNode();
	return id;
};

export const useNodeData = <T extends Record<string, any>>() => {
	const { data } = useNode<T>();
	return data;
};

export function NodeContainer(props: PropsWithChildren & BaseNode & { error?: string }) {
	return (
		<NodeContainerContext.Provider value={props}>
			<Card
				className={node({
					className: props.className,
					draggable: props.draggable,
					selected: props.selected,
					hasError: !!props.error,
				})}
			>
				<NodeHeader error={props.error} />
				<CardContent className='min-h-32 flex justify-center items-center'>
					{props.children}
				</CardContent>
			</Card>
		</NodeContainerContext.Provider>
	);
}

export function BlankNodeContainer(props: PropsWithChildren & BaseNode) {
	return (
		<NodeContainerContext.Provider value={props}>{props.children}</NodeContainerContext.Provider>
	);
}

const node = cva(
	'border-none backdrop-blur-sm min-w-80 transition-all duration-300 bg-muted-foreground/10',
	{
		variants: {
			draggable: { true: 'active:cursor-grabbing', false: '' },
			hasError: { true: 'bg-red-500/20', false: '' },
			selected: { true: 'bg-blue-500/20', false: '' },
		},
		defaultVariants: {
			selected: false,
			draggable: false,
			hasError: false,
		},
	}
);

/**
 * Internal nodes should only be used by Microflow and not exposed to the end-user
 */
type NodeGroup = 'flow' | 'hardware' | 'external' | 'internal';
export type NodeTags =
	| 'digital'
	| 'analog'
	| 'input'
	| 'output'
	| 'event'
	| 'generator'
	| 'transformation'
	| 'control'
	| 'information';

export type BaseNode<Data extends Record<string, any> = {}> = Node<
	Data & {
		group: NodeGroup;
		tags: NodeTags[];
		subType?: string;
		baseType?: NodeType;
		label: string;
		description: string;
	}
>;
