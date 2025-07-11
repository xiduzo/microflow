import {
	BindingParams,
	cn,
	cva,
	Icons,
	LevaPanel,
	Pane,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
	useControls,
	useCreateStore,
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
	useMemo,
} from 'react';
import { createPortal } from 'react-dom';
import { useUpdateNode } from '../../../hooks/useUpdateNode';
import { useDeleteEdges } from '../../../stores/react-flow';
import { NodeType } from '../../../../common/nodes';
import { BaseBladeParams, ButtonParams, TpChangeEvent } from '@tweakpane/core';
import { useDebounceValue } from 'usehooks-ts';

function NodeHeader(props: { error?: string }) {
	const data = useNodeData();

	return (
		<header className="p-2 border-b-2 gap-4 flex items-center transition-all">
			<h1 className="text-xs flex-grow font-bold">{data.label}</h1>
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

type ChangeHandler<ChangeValue, ReturnValue> = (
	event: TpChangeEvent<ChangeValue>,
) => ReturnValue | void;
type ChangeParam<ChangeValue = unknown, ReturnValue = unknown> = {
	change?: ChangeHandler<ChangeValue, ReturnValue>;
};
type ClickParam = {
	click?: () => void;
};
type BladeParams = BaseBladeParams & {
	label: string;
	tag?: string;
};

type SettingsContextProps<T extends Record<string, any>> = {
	pane: Pane | null;
	settings: T;
	setHandlesToDelete: (handles: string[]) => void;
	saveSettings: () => void;
	addBinding: (property: keyof T, params: BindingParams & ChangeParam<unknown, Partial<T>>) => void;
	addBlade: (params: BladeParams & ChangeParam<unknown, Partial<T>>) => void;
	addButton: (params: ButtonParams & ClickParam & { tag?: string }) => void;
};

const NodeSettingsPaneContext = createContext<SettingsContextProps<{}>>(
	{} as SettingsContextProps<{}>,
);

type UseControlParameters = Parameters<typeof useControls>;
export type Controls = Exclude<UseControlParameters[0], string | Function>;

export const useNodeControls = <S extends Controls>(controls: S, dependencies: unknown[] = []) => {
	const store = useCreateStore();
	const { selected, id, data } = useNode();
	const updateNode = useUpdateNode(id);

	const [controlsData, set, get] = useControls(
		() => ({ label: data.label, ...controls }),
		{ store },
		dependencies,
	);

	const [debouncedControlData] = useDebounceValue(controlsData, 500);
	const [selectedDebounce] = useDebounceValue(selected, 30);

	const render = useCallback(() => {
		return createPortal(
			<LevaPanel store={store} hideCopyButton fill titleBar={false} hidden={!selectedDebounce} />,
			document.getElementById('settings-panels')!,
		);
	}, [store, selectedDebounce]);

	useEffect(() => {
		console.debug('<controlsData>', controlsData);
		updateNode(controlsData as Record<string, unknown>);
	}, [controlsData, updateNode]);

	useEffect(() => {
		// TODO use for code upload
		console.debug('<debouncedControlData>', debouncedControlData);
	}, [debouncedControlData]);

	return { render, set };
};

export function useNodeSettings<T extends Record<string, any>>() {
	// @ts-ignore-next-line
	return useContext(NodeSettingsPaneContext as React.Context<SettingsContextProps<T>>);
}

export function useDeleteHandles() {
	const id = useNodeId();
	const deleteEdes = useDeleteEdges();

	const updateNodeInternals = useUpdateNodeInternals();

	const deleteHandles = useCallback(
		(handles: string[]) => {
			deleteEdes(id, handles);
			updateNodeInternals(id); // for xyflow to apply the changes of the removed edges
		},
		[id, updateNodeInternals, deleteEdes],
	);

	return deleteHandles;
}

function NodeSettingsPane<T extends Record<string, unknown>>(
	props: PropsWithChildren & { options?: unknown },
) {
	const pane = useRef<Pane | null>(null);
	const updateNodeInternals = useUpdateNodeInternals();
	const deleteEdes = useDeleteEdges();

	const { data, id, type, selected } = useNode<T>();
	const updateNode = useUpdateNode(id);
	const bindings = useRef(new Map<keyof T, BindingParams & ChangeParam>());
	const blades = useRef(new Map<string, BladeParams & ChangeParam>());
	const buttons = useRef(new Map<string, ButtonParams & ClickParam & { tag?: string }>());

	const ref = useRef<HTMLDivElement>(null);
	// TODO: update this after undo / redo
	const settings = useRef<T & { label: string }>(data as T & { label: string });
	const handlesToDelete = useRef<string[]>([]);

	const setHandlesToDelete = useCallback((handles: string[]) => {
		handlesToDelete.current = handles;
	}, []);

	const addBinding = useCallback((property: keyof T, params: BindingParams & ChangeParam) => {
		bindings.current.set(property, params);
	}, []);

	const addBlade = useCallback((params: BladeParams & ChangeParam) => {
		blades.current.set(params.label, params);
	}, []);

	const addButton = useCallback((params: ButtonParams & ClickParam) => {
		buttons.current.set(params.title, params);
	}, []);

	const saveSettings = useCallback(() => {
		if (handlesToDelete.current.length > 0) {
			deleteEdes(id, handlesToDelete.current);
			updateNodeInternals(id); // for xyflow to apply the changes of the removed edges
		}

		updateNode(settings.current);
	}, [updateNode, deleteEdes, updateNodeInternals, id]);

	// Might be good next step to move to https://github.com/pmndrs/leva which is more react native
	useEffect(() => {
		if (!selected) return;
		if (!settings.current.label) return;

		// const newPane = new Pane({
		// 	title: `${settings.current.label} (${id})`,
		// 	container: ref.current ?? undefined,
		// });

		// newPane.registerPlugin(TweakpaneEssentialPlugin);
		// newPane.registerPlugin(TweakpaneTextareaPlugin);
		// newPane.registerPlugin(TweakpaneCameraPlugin);

		// newPane.on('change', event => {
		// 	if (!event.last) return;
		// 	saveSettings();
		// });

		// function _deepMerge<Target extends Record<string, unknown>, Source extends Partial<T>>(
		// 	target: Target,
		// 	source: Source,
		// ) {
		// 	for (const key in source) {
		// 		if (source[key] && typeof source[key] === 'object') {
		// 			target[key] = _deepMerge(target[key] ?? {}, source[key]) as unknown as Target[Extract<
		// 				keyof Source,
		// 				string
		// 			>];
		// 		} else {
		// 			target[key] = source[key] as unknown as Target[Extract<keyof Source, string>];
		// 		}
		// 	}
		// 	return target;
		// }

		// function _addChangeHandler(api: BladeApi | BindingApi, params: ChangeParam) {
		// 	if (!params.change) return;
		// 	if (!('on' in api)) return;
		// 	api.on('change', event => {
		// 		const response = params.change?.(event);
		// 		if (!response) return;
		// 		settings.current = _deepMerge(settings.current, response);
		// 		saveSettings();
		// 	});
		// }

		// function _addButtonHandler(api: ButtonApi, params: ClickParam) {
		// 	if (!params.click) return;
		// 	api.on('click', params.click);
		// }

		// folders.current.forEach((params, title) => {
		// 	const folder = newPane.addFolder(params);

		// 	Array.from(bindings.current)
		// 		.filter(([, params]) => params.tag === title)
		// 		.forEach(([property, params]) => {
		// 			const binding = folder.addBinding(settings.current, property, params);
		// 			_addChangeHandler(binding, params);
		// 		});
		// 	Array.from(blades.current)
		// 		.filter(([, params]) => params.tag === title)
		// 		.forEach(([_title, params]) => {
		// 			const blade = folder.addBlade(params);
		// 			_addChangeHandler(blade, params);
		// 		});
		// 	Array.from(buttons.current)
		// 		.filter(([, params]) => params.tag === title)
		// 		.forEach(([_title, params]) => {
		// 			const blade = folder.addButton(params);
		// 			_addButtonHandler(blade, params);
		// 		});
		// });

		// Array.from(bindings.current)
		// 	.filter(([, params]) => !params.tag)
		// 	.forEach(([property, params]) => {
		// 		const binding = newPane.addBinding(settings.current, property, params);
		// 		_addChangeHandler(binding, params);
		// 	});
		// Array.from(blades.current)
		// 	.filter(([, params]) => !params.tag)
		// 	.forEach(([_title, params]) => {
		// 		const blade = newPane.addBlade(params);
		// 		_addChangeHandler(blade, params);
		// 	});
		// Array.from(buttons.current)
		// 	.filter(([, params]) => !params.tag)
		// 	.forEach(([_title, params]) => {
		// 		const blade = newPane.addButton(params);
		// 		_addButtonHandler(blade, params);
		// 	});

		// newPane.addBinding(settings.current, 'label', { index: 9999 });

		// pane.current = newPane;

		// return () => {
		// 	newPane.dispose();
		// 	pane.current = null;
		// };
	}, [selected, id, saveSettings]);

	return (
		<NodeSettingsPaneContext.Provider
			value={{
				pane: pane.current,
				settings: settings.current,
				addBinding,
				addBlade,
				addButton,
				saveSettings,
				setHandlesToDelete,
			}}
		>
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
						deletable: props.deletable,
						draggable: props.draggable,
						dragging: props.dragging,
						selectable: props.selectable,
						selected: props.selected,
						hasError: !!props.error,
					}),
				)}
			>
				<NodeHeader error={props.error} />
				<main className="flex grow justify-center items-center fark:bg-muted/40 bg-muted-foreground/5 ">
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
