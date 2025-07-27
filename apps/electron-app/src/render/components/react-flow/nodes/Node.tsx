import {
	cva,
	Icons,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from '@microflow/ui';
import { LevaPanel, useControls, useCreateStore } from 'leva';
import { Node, useUpdateNodeInternals } from '@xyflow/react';
import { createContext, PropsWithChildren, useCallback, useContext, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useUpdateNode } from '../../../hooks/useUpdateNode';
import { useDeleteEdges } from '../../../stores/react-flow';
import { NodeType } from '../../../../common/nodes';
import { useDebounceValue } from 'usehooks-ts';

function NodeHeader(props: { error?: string }) {
	const data = useNodeData();

	return (
		<header className='p-2 border-b-2 gap-4 flex items-center transition-all'>
			<h1 className='text-xs flex-grow font-bold'>{data.label}</h1>
			<TooltipProvider>
				{props.error && (
					<Tooltip delayDuration={0}>
						<TooltipTrigger asChild className='cursor-help'>
							<Icons.OctagonAlert size={16} />
						</TooltipTrigger>
						<TooltipContent className='text-red-500'>{props.error}</TooltipContent>
					</Tooltip>
				)}
			</TooltipProvider>
		</header>
	);
}

function NodeFooter() {
	const data = useNodeData();

	const hasData = 'pin' in data || 'pins' in data;

	if (!hasData) return null;

	return (
		<footer className='text-muted-foreground border-t-2 p-1 px-2 flex items-center gap-2'>
			{'pin' in data && (
				<div className='flex items-center mr-1'>
					<Icons.Cable size={12} className='mr-0.5 stroke-1' />
					<span className='text-xs font-extralight'>{String(data.pin)}</span>
				</div>
			)}
			{'pins' in data &&
				Object.entries(data.pins).map(([key, value]) => (
					<div key={key} className='flex items-center mr-1'>
						<Icons.Cable size={12} className='mr-0.5 stroke-1' />
						<span className='text-xs font-extralight'>
							{key}: {String(value)}
						</span>
					</div>
				))}
		</footer>
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
	const updateNode = useUpdateNode(id);

	const [controlsData, set] = useControls(
		() => ({ label: data.label, ...controls }),
		{ store },
		dependencies
	);

	const [debouncedControlData] = useDebounceValue(controlsData, 500);
	const [selectedDebounce] = useDebounceValue(selected, 30);

	const render = useCallback(() => {
		return createPortal(
			<LevaPanel store={store} hideCopyButton fill titleBar={false} hidden={!selectedDebounce} />,
			document.getElementById('settings-panels')!
		);
	}, [store, selectedDebounce]);

	/**
	 * Sometimes it is impossible to set the node data using the controls,
	 * use this handler to forcefully update the node
	 * ⚠️ this might cause descrepencies between the `data` from `useNodeData` and the actual data
	 */
	const setNodeData = useCallback(
		<T extends Record<string, unknown>>(node: Partial<Data>) => {
			updateNode(node as T);
		},
		[updateNode]
	);

	useEffect(() => {
		console.debug('<controlsData>', controlsData);
		updateNode(controlsData as Record<string, unknown>);
	}, [controlsData, updateNode]);

	useEffect(() => {
		// TODO use for code upload
		console.debug('<debouncedControlData>', debouncedControlData);
	}, [debouncedControlData]);

	return { render, set, setNodeData };
};

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
			<article
				className={node({
					className: props.className,
					deletable: props.deletable,
					draggable: props.draggable,
					dragging: props.dragging,
					selectable: props.selectable,
					selected: props.selected,
					hasError: !!props.error,
				})}
			>
				<NodeHeader error={props.error} />
				<main className='flex grow justify-center items-center dark:bg-muted/40 bg-muted-foreground/5 px-12'>
					{props.children}
				</main>
				<NodeFooter />
			</article>
		</NodeContainerContext.Provider>
	);
}

export function BlankNodeContainer(props: PropsWithChildren & BaseNode) {
	return (
		<NodeContainerContext.Provider value={props}>{props.children}</NodeContainerContext.Provider>
	);
}

const node = cva(
	'round border-2 rounded-sm backdrop-blur-sm min-w-52 min-h-44 flex flex-col transition-all',
	{
		variants: {
			selectable: { true: '', false: '' },
			selected: { true: 'border-blue-600', false: '' },
			draggable: { true: 'active:cursor-grabbing', false: '' },
			dragging: { true: '', false: '' },
			deletable: { true: '', false: '' },
			hasError: { true: '', false: '' },
		},
		defaultVariants: {
			selectable: false,
			selected: false,
			draggable: false,
			dragging: false,
			deletable: false,
			hasError: false,
		},
		compoundVariants: [
			{
				selected: false,
				hasError: false,
				className: 'dark:border-muted border-muted-foreground/20',
			},
			{
				selected: true,
				hasError: false,
				className: 'border-blue-600',
			},
			{
				selected: false,
				hasError: true,
				className: 'border-red-600',
			},
			{
				selected: true,
				hasError: true,
				className: 'border-blue-600',
			},
		],
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
