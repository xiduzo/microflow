import {
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
	Icons,
} from '@microflow/ui';
import { Node, useReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { NODE_TYPES } from '../../common/nodes';
import { useNodesChange } from '../stores/react-flow';
import { useNewNodeStore } from '../stores/new-node';
import { useWindowSize } from 'usehooks-ts';
import { BaseNode } from '../components/react-flow/nodes/Node';

const NODE_SIZE = {
	width: 208,
	height: 176,
};

export function NewNodeCommandDialog() {
	useDraggableNewNode();

	const { open, setOpen, setNodeToAdd } = useNewNodeStore();
	const { flowToScreenPosition, getZoom } = useReactFlow();
	const changeNodes = useNodesChange();
	const windowSize = useWindowSize();
	const [filter, setFilter] = useState('');

	const position = useMemo(() => {
		return flowToScreenPosition({
			x: windowSize.width / 2 - (NODE_SIZE.width / 2) * getZoom(),
			y: windowSize.height / 2 - (NODE_SIZE.height / 2) * getZoom(),
		});
	}, [flowToScreenPosition, windowSize, getZoom]);

	function selectNode(node: BaseNode, type: string) {
		return function () {
			const item: Node = {
				data: node.data,
				id: Math.random().toString(36).substring(2, 8),
				type,
				position,
				selected: true,
			};

			changeNodes([{ item, type: 'add' }]);
			setNodeToAdd(item.id);
		};
	}

	const groups = useMemo(() => {
		return Array.from(
			Object.entries(NODE_TYPES).reduce((groups, [type, Component]) => {
				const node: BaseNode =
					'defaultProps' in Component ? (Component.defaultProps as any) : { data: {} };

				const group = groups.get(node.data.group) ?? [];
				group.push({ node, type });
				groups.set(node.data.group, group);
				return groups;
			}, new Map<string, { node: BaseNode; type: string }[]>()),
		);
	}, []);

	const searchTerm = useMemo(() => {
		const terms = [
			'Magnetic, Analog, Servo...',
			'Input, Output, Event...',
			'Generator, Transformation, Control...',
			'Figma, Switch, signals...',
			'Compare, Calculate, MQTT...',
			'Delay, Gate, LED',
			'Motion, Vibration, Oscillator',
		];

		return terms[Math.floor(Math.random() * terms.length)];
	}, [filter]);

	return (
		<CommandDialog
			open={open}
			onOpenChange={state => {
				setOpen(state);
				if (!state) setFilter('');
			}}
			filter={(value, search, keywords) => {
				if (search === '') return 1;

				let score = 0;

				const labelMatch = value.toLowerCase().includes(search.toLowerCase());
				if (labelMatch) score += 0.5;

				const descriptionMatch = keywords.some(keyword =>
					keyword.toLowerCase().includes(search.toLowerCase()),
				);
				if (descriptionMatch) score += 0.3;

				const groupMatch = keywords.some(keyword =>
					keyword.toLowerCase().includes(search.toLowerCase()),
				);
				if (groupMatch) score += 0.1;

				const tagMatch = keywords.some(keyword =>
					keyword.toLowerCase().includes(search.toLowerCase()),
				);
				if (tagMatch) score += 0.1;

				return score;
			}}
		>
			<DialogHeader className="hidden">
				<DialogTitle>Add new node</DialogTitle>
				<DialogDescription>Magnetic sensor...</DialogDescription>
			</DialogHeader>
			<CommandInput placeholder={searchTerm} onValueChange={setFilter} />
			<CommandList className="mb-2">
				<CommandEmpty>No nodes found...</CommandEmpty>
				{groups.map(([group, nodes], index) => (
					<section key={group}>
						<CommandGroup heading={group}>
							{nodes.map(({ node, type }) => (
								<CommandItem key={node.data.label} onSelect={selectNode(node, type)}>
									<div className="flex flex-col">
										<span>{node.data.label}</span>
										<span className="text-muted-foreground">{node.data.description ?? ''}</span>
									</div>
									<CommandShortcut className="divide-x-2 divide-muted-foreground">
										<div className="text-muted-foreground ml-2 font-extralight">
											{node.data.tags.join(', ')}
										</div>
									</CommandShortcut>
								</CommandItem>
							))}
						</CommandGroup>
						{index !== groups.length - 1 && <CommandSeparator />}
					</section>
				))}
			</CommandList>
			<footer className="p-2 border-t flex gap-4 justify-between items-center">
				<a
					href="https://microflow.vercel.app/docs/microflow-studio/nodes"
					target="_blank"
					className="text-xs text-muted-foreground hover:underline"
				>
					Open the documentation
				</a>
				<section className="flex items-center gap-3">
					<section className="flex items-center gap-2">
						<span className="text-xs text-muted-foreground">Close</span>
						<CommandShortcut className="bg-muted-foreground/10 p-1 rounded-md">Esc</CommandShortcut>
					</section>
					<section className="flex items-center gap-2">
						<span className="text-xs text-muted-foreground">Navigate</span>
						<div className="flex items-center gap-1">
							<CommandShortcut className="bg-muted-foreground/10 p-1 rounded-md">
								<Icons.ChevronUp size={12} className="" />
							</CommandShortcut>
							<CommandShortcut className="bg-muted-foreground/10 p-1 rounded-md">
								<Icons.ChevronDown size={12} className="" />
							</CommandShortcut>
						</div>
					</section>
					<section className="flex items-center gap-2">
						<span className="text-xs text-muted-foreground">Select</span>
						<CommandShortcut className="bg-muted-foreground/10 p-1 rounded-md">
							<Icons.CornerDownLeft size={12} className="" />
						</CommandShortcut>
					</section>
				</section>
			</footer>
		</CommandDialog>
	);
}

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
