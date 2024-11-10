import {
	Button,
	cn,
	cva,
	Icons,
	Pane,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
	TweakpaneEssentialPlugin,
	TweakpaneTextareaPlugin,
} from '@microflow/ui';
import { Node } from '@xyflow/react';
import { createContext, PropsWithChildren, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUpdateNode } from '../../../hooks/useUpdateNode';

export function NodeSettingsButton() {
	const { settingsOpened, setSettingsOpened } = useNode();

	return (
		<Button
			variant={settingsOpened ? 'secondary' : 'ghost'}
			size="icon"
			onClick={e => {
				e.stopPropagation();
				setSettingsOpened(!settingsOpened);
			}}
		>
			<Icons.SlidersHorizontal size={16} />
		</Button>
	);
}

type ContainerProps<T extends Record<string, unknown>> = BaseNode<T> & {
	settingsOpened: boolean;
	setSettingsOpened: (open: boolean) => void;
};

const NodeContainerContext = createContext<ContainerProps<Record<string, unknown>>>(
	{} as ContainerProps<Record<string, unknown>>,
);
export const useNode = <T extends Record<string, unknown>>() =>
	useContext(NodeContainerContext as React.Context<ContainerProps<T>>);

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
				<main className="flex grow justify-center items-center bg-muted/40">
					<NodeSettingsPane>{props.children}</NodeSettingsPane>
				</main>
			</article>
		</NodeContainerContext.Provider>
	);
}

function NodeHeader(props: { error?: string; selected?: boolean }) {
	const { data, id } = useNode();

	// TODO: label does not update from settings pane

	return (
		<header className={header({ selected: props.selected, hasError: !!props.error })}>
			<div className="flex flex-col">
				<div className="flex items-center space-x-2">
					<h1 className="font-bold">{data.label}</h1>
					{props.error && (
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<Icons.OctagonAlert size={16} />
								</TooltipTrigger>
								<TooltipContent className="text-red-500">{props.error}</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)}
				</div>
				<h2 className="text-xs font-extralight">{id}</h2>
			</div>
			<NodeSettingsButton />
		</header>
	);
}

const header = cva('p-2 pl-3.5 border-b-2 flex justify-between items-center rounded-t-md', {
	variants: {
		selected: {
			true: 'bg-blue-500 text-blue-950 border-blue-500',
			false: 'text-muted-foreground border-muted',
		},
		hasError: {
			true: 'bg-red-500 text-red-950 border-red-500',
			false: 'text-muted-foreground border-muted',
		},
	},
});

type SettingsContextProps<T extends Record<string, unknown>> = {
	pane: Pane | null;
	settings: T;
};

const NodeSettingsPaneContext = createContext<SettingsContextProps<{}>>(
	{} as SettingsContextProps<{}>,
);

function NodeSettingsPane<T extends Record<string, unknown>>(props: PropsWithChildren) {
	const [pane, setPane] = useState<Pane | null>(null);

	const { data, settingsOpened, setSettingsOpened, id, type } = useNode<T>();
	const updateNode = useUpdateNode(id);

	const settings = useRef(data);

	const ref = useRef<HTMLDivElement>();

	useEffect(() => {
		if (!settingsOpened) return;

		const pane = new Pane({
			title: `${data.label} (${id})`,
			container: ref.current,
		});
		pane.registerPlugin(TweakpaneEssentialPlugin);
		pane.registerPlugin(TweakpaneTextareaPlugin);

		pane.addBinding(settings.current, 'label', {
			index: 9998,
		});

		pane
			.addButton({
				title: 'Save & close',
				index: 9999,
			})
			.on('click', () => {
				updateNode(settings.current, type !== 'Note');
				setSettingsOpened(false);
			});

		setPane(pane);

		return () => {
			setPane(null);
			pane.dispose();
		};
	}, [settingsOpened, settings]);

	useEffect(() => {
		settings.current = { ...data };
	}, [data, settingsOpened]);

	return (
		<NodeSettingsPaneContext.Provider value={{ pane, settings: settings.current }}>
			{props.children}
			{settingsOpened &&
				createPortal(
					<div ref={ref} onClick={e => e.stopPropagation()} />,
					document.getElementById('settings-panels'),
				)}
		</NodeSettingsPaneContext.Provider>
	);
}

export function useNodeSettingsPane<T extends Record<string, unknown>>() {
	return useContext(NodeSettingsPaneContext as React.Context<SettingsContextProps<T>>);
}

const node = cva(
	'outline outline-2 -outline-offset-1 outline-muted backdrop-blur-sm rounded-md min-w-52 min-h-44 flex flex-col',
	{
		variants: {
			hasError: { true: 'outline-red-500', false: '' },
			selectable: { true: '', false: '' },
			selected: { true: 'outline-blue-500', false: '' },
			draggable: { true: 'active:cursor-grabbing', false: '' },
			dragging: { true: '', false: '' },
			deletabled: { true: '', false: '' },
		},
		defaultVariants: {
			selectable: false,
			selected: false,
			draggable: false,
			dragging: false,
			deletabled: false,
			hasError: false,
		},
	},
);

export type BaseNode<Settings extends Record<string, unknown> = {}, Value = any> = Node<
	Settings & {
		label: string;
		animated?: string;
		settingsOpen?: boolean;
	}
>;
