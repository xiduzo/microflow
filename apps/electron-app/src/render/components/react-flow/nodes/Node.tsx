import {
	Button,
	cn,
	cva,
	Drawer,
	DrawerContent,
	DrawerDescription,
	DrawerFooter,
	DrawerHeader,
	DrawerTitle,
	VariantProps,
} from '@microflow/ui';
import { Node, useReactFlow } from '@xyflow/react';
import { createContext, PropsWithChildren, useContext, useEffect, useRef, useState } from 'react';
import { isNodeTypeACodeType } from '../../../../utils/generateCode';
import { useUpdateNode } from '../../../hooks/nodeUpdater';

type NodeSettingsContextType<T extends Record<string, any>> = {
	settings: T;
	setSettings: (settings: Partial<T>) => void;
};

const NodeSettingsContextCreator = <T extends Record<string, any>>() =>
	createContext<NodeSettingsContextType<T>>({
		settings: {} as T,
		setSettings: (settings: Partial<T>) => {},
	});

const NodeSettingsContext = NodeSettingsContextCreator();

export function useNodeSettings<T extends Record<string, any>>() {
	return useContext<NodeSettingsContextType<T>>(NodeSettingsContext as any);
}

export function NodeSettings<T>(props: NodeContainerProps<T>) {
	const node = useNode();
	const [settings, setSettings] = useState(node.data);
	const { deleteElements } = useReactFlow<BaseNode>();
	const updateNode = useUpdateNode(node.id);

	function handleOpenChange(settingsOpen: boolean) {
		if (settingsOpen) return;

		const newSettings = { ...settings, settingsOpen };
		updateNode(newSettings, isNodeTypeACodeType(node.type));
		props.onClose?.(newSettings as T);
	}

	useEffect(() => {
		setSettings(node.data);
	}, [node.data.settingsOpen]);

	return (
		<NodeSettingsContext.Provider
			value={{
				settings,
				setSettings,
			}}
		>
			<Drawer open={settings.settingsOpen} nested onOpenChange={handleOpenChange}>
				<DrawerContent>
					<DrawerHeader className="max-w-md w-full m-auto mt-6">
						<DrawerTitle className="flex items-center justify-between">
							Configure node
							<span className="text-xs font-light text-neutral-500">id: {node.id}</span>
						</DrawerTitle>
						<DrawerDescription>
							Updates will be automatically applied when closing the drawer.
						</DrawerDescription>
					</DrawerHeader>
					<section className="max-w-md w-full m-auto flex flex-col space-y-4 mb-8 p-4">
						{props.children}
					</section>
					<DrawerFooter className="max-w-md w-full m-auto">
						<Button variant="secondary" onClick={handleOpenChange}>
							Close
						</Button>
						<Button variant="destructive" onClick={() => deleteElements({ nodes: [node] })}>
							Delete node
						</Button>
					</DrawerFooter>
				</DrawerContent>
			</Drawer>
		</NodeSettingsContext.Provider>
	);
}

type NodeContainerProps<T extends Record<string, any> = {}> = PropsWithChildren & {
	className?: string;
	onClose?: (settings: T) => void;
};

export function NodeValue(props: NodeValueProps) {
	const { data } = useNode();
	const prevValue = useRef(props.valueOverride ?? data.value);

	useEffect(() => {
		if (data.animated) return;

		prevValue.current = props.valueOverride ?? data.value;
	}, [data.animated, data.value, props.valueOverride]);

	return (
		<section
			className={cn(
				nodeValue({
					className: props.className,
					active:
						props.active ||
						(!!data.animated && (props.valueOverride ?? data.value) !== prevValue.current),
				}),
			)}
		>
			{props.children}
		</section>
	);
}

export function NodeContent(props: PropsWithChildren) {
	return <section className="flex flex-col space-y-4 grow">{props.children}</section>;
}

type NodeValueProps = PropsWithChildren &
	VariantProps<typeof nodeValue> & {
		className?: string;
		valueOverride?: unknown;
	};

const nodeValue = cva(
	'flex p-4 justify-center items-center rounded-md transition-all dutation-75 min-w-48 min-h-28 w-full pointer-events-none',
	{
		variants: {
			active: {
				true: 'bg-yellow-700',
				false: 'bg-muted',
			},
			defaultVariants: {
				active: false,
			},
		},
	},
);

const NodeContainerContext = createContext<BaseNode>({} as BaseNode);
export const useNode = () => useContext(NodeContainerContext);

export function NodeContainer(props: PropsWithChildren & BaseNode) {
	return (
		<NodeContainerContext.Provider value={props}>
			<div
				className={cn(
					node({
						className: props.className,
						deletabled: props.deletable,
						draggable: props.draggable,
						dragging: props.dragging,
						selectable: props.selectable,
						selected: props.selected,
					}),
				)}
			>
				<NodeHeader />
				<main className="px-4 pt-2 pb-4 flex justify-center items-center grow">
					{props.children}
				</main>
			</div>
		</NodeContainerContext.Provider>
	);
}

function NodeHeader() {
	const node = useNode();

	return (
		<header className="p-2 pl-4 border-b-2 text-muted-foreground text-sm">{node.data.label}</header>
	);
}

const node = cva(
	'bg-neutral-950/5 outline outline-2 -outline-offset-1 outline-neutral-500/25 backdrop-blur-sm rounded-md min-w-52 min-h-44 flex flex-col',
	{
		variants: {
			selectable: {
				true: '',
				false: '',
			},
			selected: {
				true: 'outline-blue-500',
				false: '',
			},
			draggable: {
				true: 'active:cursor-grabbing',
				false: '',
			},
			dragging: {
				true: '',
				false: '',
			},
			deletabled: {
				true: '',
				false: '',
			},
		},
		defaultVariants: {
			selectable: false,
			selected: false,
			draggable: false,
			dragging: false,
			deletabled: false,
		},
	},
);

export type BaseNode<Data extends Record<string, any> = {}, ValueType = any> = Node<
	Data & {
		value: ValueType;
		label: string;
		animated?: string;
		settingsOpen?: boolean;
	}
>;
