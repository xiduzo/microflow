import {
	Badge,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
	CommandShortcut,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@microflow/ui';
import { useReactFlow } from '@xyflow/react';
import {
	createContext,
	PropsWithChildren,
	useContext,
	useEffect,
	useState,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { DEFAULT_NODE_DATA, NodeType } from '../../common/nodes';
import { tempNodeSelector, useNodesEdgesStore } from '../store';

const NewNodeContext = createContext({
	open: false,
	setOpen: (open: boolean) => {},
	nodeToAdd: null as string | null,
	setNodeToAdd: (nodeId: string | null) => {},
});

export function NewNodeProvider(props: PropsWithChildren) {
	const [open, setOpen] = useState(false);
	const [nodeToAdd, setNodeToAdd] = useState<string | null>(null);

	return (
		<NewNodeContext.Provider value={{ open, setOpen, nodeToAdd, setNodeToAdd }}>
			{props.children}
			<NewNodeCommandDialog />
			<DroppableNewNode />
		</NewNodeContext.Provider>
	);
}

export function useNewNode() {
	return useContext(NewNodeContext);
}

function NewNodeCommandDialog() {
	const { open, setOpen, setNodeToAdd } = useNewNode();
	const { addNode } = useNodesEdgesStore(useShallow(tempNodeSelector));

	function selectNode(type: NodeType, label?: string) {
		return function () {
			const data = DEFAULT_NODE_DATA.get(type) ?? {};

			if (label && 'label' in data) {
				data.label = label;
			}

			const id = Math.random().toString(36).substring(2, 8);
			const newNode = {
				data,
				id,
				type,
				position: { x: 0, y: 0 },
				selected: true,
			};

			addNode(newNode);
			setNodeToAdd(id);
			setOpen(false);
		};
	}

	return (
		<CommandDialog open={open} onOpenChange={setOpen}>
			<DialogHeader className="hidden">
				<DialogTitle>Add new node</DialogTitle>
				<DialogDescription>
					Search for a node or node type to add to the flow.
				</DialogDescription>
			</DialogHeader>
			<CommandInput placeholder="Seach node or node type..." />
			<CommandList>
				<CommandEmpty>No results found.</CommandEmpty>
				<CommandGroup heading="Flow">
					<CommandItem onSelect={selectNode('Counter')}>
						Counter
						<CommandShortcut>
							<Badge variant="outline">Event</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('IfElse')}>
						If...else
						<CommandShortcut>
							<Badge variant="outline">Control</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Interval')}>
						Interval
						<CommandShortcut>
							<Badge variant="outline">Event</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('RangeMap')}>
						Map
						<CommandShortcut>
							<Badge variant="outline">Transformation</Badge>
						</CommandShortcut>
					</CommandItem>
				</CommandGroup>
				<CommandSeparator />
				<CommandGroup heading="Hardware">
					<CommandItem onSelect={selectNode('Button')}>
						Button
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Digital</Badge>
							<Badge variant="outline">Input</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Led')}>
						LED
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Digital</Badge>
							<Badge variant="outline">Output</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Sensor', 'LDR')}>
						LDR (Light Dependent Resistor)
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Analog</Badge>
							<Badge variant="outline">Input</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Motion')}>
						Motion
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Digital</Badge>
							<Badge variant="outline">Analog</Badge>
							<Badge variant="outline">Input</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Piezo')}>
						Piezo
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Analog</Badge>
							<Badge variant="outline">Output</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Sensor', 'Potentiometer')}>
						Potentiometer
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Analog</Badge>
							<Badge variant="outline">Input</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Servo')}>
						Servo
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Analog</Badge>
							<Badge variant="outline">Output</Badge>
						</CommandShortcut>
					</CommandItem>
				</CommandGroup>
				<CommandSeparator />
				<CommandGroup heading="External">
					<CommandItem onSelect={selectNode('Mqtt')}>
						MQTT
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Input</Badge>
							<Badge variant="outline">Output</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Figma')}>
						Figma
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Input</Badge>
							<Badge variant="outline">Output</Badge>
						</CommandShortcut>
					</CommandItem>
				</CommandGroup>
			</CommandList>
		</CommandDialog>
	);
}

function DroppableNewNode() {
	const { nodeToAdd, setNodeToAdd, open } = useNewNode();
	const { screenToFlowPosition, updateNode } = useReactFlow();
	const { addNode, deleteNode } = useNodesEdgesStore(
		useShallow(tempNodeSelector),
	);

	useEffect(() => {
		if (!nodeToAdd) return;

		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === 'Escape' || event.key === 'Backspace') {
				setNodeToAdd(null);
				deleteNode(nodeToAdd);
			}

			if (event.key === 'Enter') {
				const element = event.target as HTMLElement;
				if (element !== document.body) return;

				setNodeToAdd(null);
				updateNode(nodeToAdd, { selected: false });
			}
		}

		function handleMouseDown(event: MouseEvent) {
			updateNode(nodeToAdd, {
				position: screenToFlowPosition({
					x: event.clientX - 120,
					y: event.clientY - 75,
				}),
			});
			const element = event.target as HTMLElement;
			if (!element.closest('.react-flow__node')) return;

			setNodeToAdd(null);
			updateNode(nodeToAdd, { selected: false });
		}

		function handleMouseMove(event: MouseEvent) {
			updateNode(nodeToAdd, {
				position: screenToFlowPosition({
					x: event.clientX - 120,
					y: event.clientY - 75,
				}),
			});
		}

		document.addEventListener('keydown', handleKeyDown);
		document.addEventListener('mousemove', handleMouseMove);
		document.addEventListener('mousedown', handleMouseDown);
		document.addEventListener('click', handleMouseDown);

		return () => {
			document.removeEventListener('keydown', handleKeyDown);
			document.removeEventListener('mousemove', handleMouseMove);
			document.removeEventListener('mousedown', handleMouseDown);
			document.removeEventListener('click', handleMouseDown);
		};
	}, [nodeToAdd, addNode, deleteNode]);

	return null;
}
