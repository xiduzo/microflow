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
import { useHotkey } from '../../../hooks/useHotkey';

export function NodeSettingsButton() {
	const { settingsOpened, setSettingsOpened } = useNode();

	useHotkey({ code: 'KeyP', withMetaKey: true }, () => {
		setSettingsOpened(false);
	});

	return (
		<button
			onClick={e => {
				e.stopPropagation();
				setSettingsOpened(!settingsOpened);
			}}
			className={settingsButton({ settingsOpened })}
		>
			<Icons.SlidersHorizontal size={16} />
		</button>
	);
}

const settingsButton = cva(
	'h-10 w-10 inline-flex items-center justify-center rounded-md transition-all',
	{
		variants: {
			settingsOpened: {
				true: 'dark:bg-black/40 bg-black/10 dark:hover:bg-black/30 hover:bg-black/5',
				false: 'dark:hover:bg-black/40 hover:bg-black/10',
			},
		},
	},
);

function NodeHeader(props: { error?: string; selected?: boolean }) {
	const id = useNodeId();
	const data = useNodeData();

	return (
		<header className={header({ selected: props.selected, hasError: !!props.error })}>
			<div className="flex flex-col flex-grow">
				<div className="flex items-center space-x-2">
					<h1 className="font-bold">{data.label}</h1>
					{props.error && (
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild className="cursor-help">
									<Icons.OctagonAlert size={16} />
								</TooltipTrigger>
								<TooltipContent className="text-red-500">{props.error}</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)}
				</div>
				<div
					className={subheader({
						selected: props.selected,
						hasError: !!props.error,
					})}
				>
					{id}
					{'pin' in data && (
						<div className="flex items-center mr-1">
							<Icons.Cable size={12} className="mr-0.5 stroke-1" />
							<span className="text-xs font-extralight">{String(data.pin)}</span>
						</div>
					)}
				</div>
			</div>
			<NodeSettingsButton />
		</header>
	);
}

const header = cva(
	'p-2 pl-3.5 border-b-2 gap-3 flex justify-between items-center rounded-t-md transition-all',
	{
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
	},
);

const subheader = cva('text-xs font-extralight transition-all flex gap-3 items-center', {
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
			className: 'text-muted-foreground',
		},
		{
			selected: true,
			hasError: false,
			className: 'text-blue-200',
		},
		{
			selected: false,
			hasError: true,
			className: 'text-red-200',
		},
		{
			selected: true,
			hasError: true,
			className: 'text-blue-200',
		},
	],
});

type SettingsContextProps<T extends Record<string, unknown>> = {
	pane: Pane | null;
	settings: T;
	setHandlesToDelete: (handles: string[]) => void;
	saveSettings: () => void;
};

const NodeSettingsPaneContext = createContext<SettingsContextProps<{}>>(
	{} as SettingsContextProps<{}>,
);

export function useNodeSettings<T extends Record<string, unknown>>() {
	// @ts-ignore-next-line
	return useContext(NodeSettingsPaneContext as React.Context<SettingsContextProps<T>>);
}

function NodeSettingsPane<T extends Record<string, unknown>>(
	props: PropsWithChildren & { options?: unknown },
) {
	const [pane, setPane] = useState<Pane | null>(null);
	const updateNodeInternals = useUpdateNodeInternals();
	const deleteEdes = useDeleteEdges();

	const { data, settingsOpened, setSettingsOpened, id, type } = useNode<T>();
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
		if (settingsOpened) return;
		// Create a copy of the data when the settings are closed
		setSettings(JSON.parse(JSON.stringify(data)));
	}, [settingsOpened, data]);

	useEffect(() => {
		if (!settingsOpened) return;

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
				setSettingsOpened(false);
			});

		pane.on('change', event => {
			if (!event.last) return;

			// TODO Automatically save changes is neat to have, unfortunately it will block the render process for now
			// See https://github.com/electron/electron/issues/45053#issuecomment-2549711790
			// When resolved, we can use this to save the settings on change instead of a button click
			saveSettings();
		});

		setPane(pane);

		return () => {
			setPane(null);
			pane.dispose();
		};
	}, [settingsOpened, type, id, saveSettings]);

	return (
		<NodeSettingsPaneContext.Provider value={{ pane, settings, saveSettings, setHandlesToDelete }}>
			{props.children}
			{settingsOpened &&
				(createPortal(
					<div ref={ref} onClick={e => e.stopPropagation()} />,
					document.getElementById('settings-panels')!,
				) as ReactNode)}
		</NodeSettingsPaneContext.Provider>
	);
}

type ContainerProps<T extends Record<string, unknown>> = BaseNode<T> & {
	settingsOpened: boolean;
	setSettingsOpened: (open: boolean) => void;
};

const NodeContainerContext = createContext<ContainerProps<Record<string, unknown>>>(
	{} as ContainerProps<Record<string, unknown>>,
);

const useNode = <T extends Record<string, unknown>>() =>
	useContext(NodeContainerContext as React.Context<ContainerProps<T>>);

export const useNodeId = () => {
	const { id } = useNode();
	return id;
};

export const useNodeData = <T extends Record<string, unknown>>() => {
	const { data } = useNode<T>();
	return data;
};

export function NodeContainer(props: PropsWithChildren & BaseNode & { error?: string }) {
	const [settingsOpened, setSettingsOpened] = useState(false);

	return (
		<NodeContainerContext.Provider
			value={{
				...props,
				settingsOpened,
				setSettingsOpened,
			}}
		>
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
			</article>
		</NodeContainerContext.Provider>
	);
}

const node = cva(
	'outline outline-2 -outline-offset-1 backdrop-blur-sm rounded-md min-w-52 min-h-44 flex flex-col transition-all',
	{
		variants: {
			selectable: { true: '', false: '' },
			selected: { true: 'outline-blue-600', false: '' },
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
				className: 'dark:outline-muted outline-muted-foreground/20',
			},
			{
				selected: true,
				hasError: false,
				className: 'outline-blue-600',
			},
			{
				selected: false,
				hasError: true,
				className: 'outline-red-600',
			},
			{
				selected: true,
				hasError: true,
				className: 'outline-blue-600',
			},
		],
	},
);

type NodeGroup = 'flow' | 'hardware' | 'external';
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

export type BaseNode<Data extends Record<string, unknown> = {}> = Node<
	Data & {
		group: NodeGroup;
		tags: NodeTags[];
		subType?: string;
		baseType?: NodeType;
		label: string;
		description: string;
	}
>;
