import {
	cn,
	cva,
	Icons,
	Pane,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
	TweakpaneCameraPlugin,
	TweakpaneEssentialPlugin,
	TweakpaneTextareaPlugin,
} from '@microflow/ui';
import { Node, useUpdateNodeInternals } from '@xyflow/react';
import {
	createContext,
	PropsWithChildren,
	ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useUpdateNode } from '../../../hooks/useUpdateNode';
import { useDeleteEdges } from '../../../stores/react-flow';
import { NodeType } from '../../../../common/nodes';

function NodeHeader(props: { error?: string; selected?: boolean }) {
	const data = useNodeData();

	return (
		<header className={header({ selected: props.selected, hasError: !!props.error })}>
			<h1 className="font-bold flex-grow">{data.label}</h1>
			<TooltipProvider>
				{props.error && (
					<Tooltip delayDuration={0}>
						<TooltipTrigger asChild className="cursor-help">
							<Icons.OctagonAlert size={16} />
						</TooltipTrigger>
						<TooltipContent className="text-red-500">{props.error}</TooltipContent>
					</Tooltip>
				)}
			</TooltipProvider>
		</header>
	);
}

const header = cva('p-2 px-4 border-b-2 gap-4 flex items-center transition-all', {
	variants: {
		selected: {
			true: '',
			false: '',
		},
		hasError: {
			true: '',
			false: '',
		},
	},
	compoundVariants: [
		{
			selected: false,
			hasError: false,
			className: 'text-muted-foreground dark:border-muted border-muted-foreground/20',
		},
		{
			selected: true,
			hasError: false,
			className: 'bg-blue-600 text-blue-200 border-blue-600',
		},
		{
			selected: false,
			hasError: true,
			className: 'bg-red-600 text-red-200 border-red-600',
		},
		{
			selected: true,
			hasError: true,
			className: 'bg-blue-600 text-blue-200 border-blue-600',
		},
	],
});

function NodeFooter() {
	const data = useNodeData();

	const hasData = 'pin' in data || 'pins' in data;

	if (!hasData) return null;

	return (
		<footer className="text-muted-foreground border-t-2 p-1 px-2 flex items-center gap-2">
			{'pin' in data && (
				<div className="flex items-center mr-1">
					<Icons.Cable size={12} className="mr-0.5 stroke-1" />
					<span className="text-xs font-extralight">{String(data.pin)}</span>
				</div>
			)}
			{'pins' in data &&
				Object.entries(data.pins).map(([key, value]) => (
					<div key={key} className="flex items-center mr-1">
						<Icons.Cable size={12} className="mr-0.5 stroke-1" />
						<span className="text-xs font-extralight">
							{key}: {String(value)}
						</span>
					</div>
				))}
		</footer>
	);
}

type SettingsContextProps<T extends Record<string, any>> = {
	pane: Pane | null;
	settings: T;
	setHandlesToDelete: (handles: string[]) => void;
	saveSettings: () => void;
};

const NodeSettingsPaneContext = createContext<SettingsContextProps<{}>>(
	{} as SettingsContextProps<{}>,
);

export function useNodeSettings<T extends Record<string, any>>() {
	// @ts-ignore-next-line
	return useContext(NodeSettingsPaneContext as React.Context<SettingsContextProps<T>>);
}

function NodeSettingsPane<T extends Record<string, unknown>>(
	props: PropsWithChildren & { options?: unknown },
) {
	const [pane, setPane] = useState<Pane | null>(null);
	const updateNodeInternals = useUpdateNodeInternals();
	const deleteEdes = useDeleteEdges();

	const { data, id, type, selected } = useNode<T>();
	const updateNode = useUpdateNode(id);

	const ref = useRef<HTMLDivElement>(null);
	const [settings, setSettings] = useState<T & { label: string }>({} as T & { label: string });
	const handlesToDelete = useRef<string[]>([]);

	const setHandlesToDelete = useCallback((handles: string[]) => {
		handlesToDelete.current = handles;
	}, []);

	const saveSettings = useCallback(() => {
		if (handlesToDelete.current.length > 0) {
			deleteEdes(id, handlesToDelete.current);
			updateNodeInternals(id); // for xyflow to apply the changes of the removed edges
		}

		updateNode(settings, type !== 'Note');
	}, [updateNode, deleteEdes, updateNodeInternals, id, settings]);

	// TODO: update this after undo / redo
	useEffect(() => {
		if (selected) return;
		// Create a copy of the data when the settings are closed
		setSettings(JSON.parse(JSON.stringify(data)));
	}, [selected, data]);

	useEffect(() => {
		if (!selected) return;
		if (!settings.label) return;

		const pane = new Pane({
			title: `${settings.label} (${id})`,
			container: ref.current ?? undefined,
		});

		pane.registerPlugin(TweakpaneEssentialPlugin);
		pane.registerPlugin(TweakpaneTextareaPlugin);
		pane.registerPlugin(TweakpaneCameraPlugin);

		pane.addBinding(settings, 'label', {
			index: 9997,
		});

		pane.addBlade({
			view: 'separator',
			index: 9998,
		});

		pane
			.addButton({
				title: 'Close',
				index: 9999,
			})
			.on('click', () => {
				// TODO: close the settings pane
				// setSettingsOpened(false);
			});

		pane.on('change', event => {
			if (!event.last) return;
			saveSettings();
		});

		setPane(pane);

		return () => {
			setPane(null);
			pane.dispose();
		};
	}, [selected, type, id, saveSettings]);

	return (
		<NodeSettingsPaneContext.Provider value={{ pane, settings, saveSettings, setHandlesToDelete }}>
			{props.children}
			{selected &&
				(createPortal(
					<div ref={ref} onClick={e => e.stopPropagation()} />,
					document.getElementById('settings-panels')!,
				) as ReactNode)}
		</NodeSettingsPaneContext.Provider>
	);
}

type ContainerProps<T extends Record<string, unknown>> = BaseNode<T>;

const NodeContainerContext = createContext<ContainerProps<Record<string, unknown>>>(
	{} as ContainerProps<Record<string, unknown>>,
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
				className={cn(
					node({
						className: props.className,
						deletabled: props.deletable,
						draggable: props.draggable,
						dragging: props.dragging,
						selectable: props.selectable,
						selected: props.selected,
						hasError: !!props.error,
					}),
				)}
			>
				<NodeHeader error={props.error} selected={props.selected} />
				<main className="flex grow justify-center items-center fark:bg-muted/40 bg-muted-foreground/5">
					<NodeSettingsPane>{props.children}</NodeSettingsPane>
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
	'border border-2 rounded-sm backdrop-blur-sm min-w-52 min-h-44 flex flex-col transition-all',
	{
		variants: {
			selectable: { true: '', false: '' },
			selected: { true: 'border-blue-600', false: '' },
			draggable: { true: 'active:cursor-grabbing', false: '' },
			dragging: { true: '', false: '' },
			deletabled: { true: '', false: '' },
			hasError: { true: '', false: '' },
		},
		defaultVariants: {
			selectable: false,
			selected: false,
			draggable: false,
			dragging: false,
			deletabled: false,
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
	},
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
