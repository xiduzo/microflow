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
import { memo, useEffect, useMemo } from 'react';
import { NODE_TYPES, NodeType } from '../../common/nodes';
import { useDeleteSelectedNodes, useNodesChange } from '../stores/react-flow';
import { useNewNodeStore } from '../stores/new-node';
import { useWindowSize } from 'usehooks-ts';

const NODE_SIZE = {
	width: 208,
	height: 176,
};

export const NewNodeCommandDialog = memo(function NewNodeCommandDialog() {
	useDraggableNewNode();
	useBackspaceOverwrite();

	const { open, setOpen, setNodeToAdd } = useNewNodeStore();
	const { flowToScreenPosition } = useReactFlow();
	const changeNodes = useNodesChange();
	const windowSize = useWindowSize();

	const position = useMemo(() => {
		return flowToScreenPosition({
			x: windowSize.width / 2 - NODE_SIZE.width / 2,
			y: windowSize.height / 2 - NODE_SIZE.height / 2,
		});
	}, [flowToScreenPosition, windowSize]);

	function selectNode(type: NodeType, data?: { label?: string; subType?: string }) {
		return function () {
			const DEFAULT_DATA =
				'defaultProps' in NODE_TYPES[type] ? (NODE_TYPES[type].defaultProps as any).data : {};

			const id = Math.random().toString(36).substring(2, 8);
			const newNode = {
				data: { ...DEFAULT_DATA, ...data },
				id,
				type,
				position,
				selected: true,
			};

			changeNodes([{ item: newNode, type: 'add' }]);
			setNodeToAdd(id);
		};
	}

	return (
		<CommandDialog open={open} onOpenChange={setOpen}>
			<DialogHeader className="hidden">
				<DialogTitle>Add new node</DialogTitle>
				<DialogDescription>Search for a node or node type to add to the flow.</DialogDescription>
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
					<CommandItem onSelect={selectNode('Oscillator')}>
						Oscillator
						<CommandShortcut>
							<Badge variant="outline">Generator</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Smooth')}>
						Smooth
						<CommandShortcut>
							<Badge variant="outline">Transformation</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Monitor')}>
						Monitor
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Output</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Trigger')}>
						Trigger
						<CommandShortcut>
							<Badge variant="outline">Control</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Compare')}>
						Compare
						<CommandShortcut>
							<Badge variant="outline">Control</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Gate')}>
						Gate
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
					<CommandItem onSelect={selectNode('Note')}>
						Note
						<CommandShortcut>
							<Badge variant="outline">Information</Badge>
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
					<CommandItem onSelect={selectNode('Sensor', { label: 'LDR', subType: 'ldr' })}>
						LDR (Light Dependent Resistor)
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Analog</Badge>
							<Badge variant="outline">Input</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Led')}>
						LED
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Analog</Badge>
							<Badge variant="outline">Digital</Badge>
							<Badge variant="outline">Output</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Rgb')}>
						LED (RGB)
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Analog</Badge>
							<Badge variant="outline">Output</Badge>
						</CommandShortcut>
					</CommandItem>
					<CommandItem onSelect={selectNode('Matrix')}>
						LED Matrix
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Analog</Badge>
							<Badge variant="outline">Output</Badge>
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
					<CommandItem
						onSelect={selectNode('Sensor', { label: 'Potentiometer', subType: 'potentiometer' })}
					>
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
					<CommandItem onSelect={selectNode('Led', { label: 'Vibration', subType: 'vibration' })}>
						Vibration
						<CommandShortcut className="space-x-1">
							<Badge variant="outline">Analog</Badge>
							<Badge variant="outline">Digital</Badge>
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
});

function useDraggableNewNode() {
	const { nodeToAdd, setNodeToAdd } = useNewNodeStore();
	const { screenToFlowPosition, getZoom } = useReactFlow();
	const changeNodes = useNodesChange();

	useEffect(() => {
		if (!nodeToAdd) return;

		function handleKeyDown(event: KeyboardEvent) {
			if (!nodeToAdd) return;

			switch (event.key) {
				case 'Backspace':
				case 'Escape':
					changeNodes([{ id: nodeToAdd, type: 'remove' }]);
					setNodeToAdd(null);
					break;
				case 'Enter':
					const element = event.target as HTMLElement;
					if (element !== document.body) return;

					changeNodes([{ id: nodeToAdd, type: 'select', selected: false }]);
					setNodeToAdd(null);
					break;
			}
		}

		function handleMouseDown(event: MouseEvent) {
			if (!nodeToAdd) return;
			const element = event.target as HTMLElement;
			if (!element.closest('.react-flow__node')) return;

			changeNodes([{ id: nodeToAdd, type: 'select', selected: false }]);
			setNodeToAdd(null);
		}

		function handleMouseMove(event: MouseEvent) {
			if (!nodeToAdd) return;
			const zoom = getZoom();
			changeNodes([
				{
					id: nodeToAdd,
					type: 'position',
					position: screenToFlowPosition({
						x: event.clientX - (NODE_SIZE.width / 2) * zoom,
						y: event.clientY - (NODE_SIZE.height / 2) * zoom,
					}),
				},
			]);
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
	}, [nodeToAdd, getZoom, changeNodes]);

	return null;
}

// https://github.com/xyflow/xyflow/issues/4761
export function useBackspaceOverwrite() {
	const deleteSelectedNodes = useDeleteSelectedNodes();

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.code === 'Backspace') {
				deleteSelectedNodes();
			}
		};
		window.addEventListener('keydown', handleKeyDown);

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
		};
	}, [deleteSelectedNodes]);
}
