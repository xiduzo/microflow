import {
	Avatar,
	AvatarFallback,
	Badge,
	Button,
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
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
	Icon,
	Icons,
} from '@microflow/ui';
import { Node, useReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { NODE_TYPES } from '../../common/nodes';
import { useNodesChange } from '../stores/react-flow';
import { useNewNodeStore } from '../stores/new-node';
import { useWindowSize } from 'usehooks-ts';
import { BaseNode } from '../components/react-flow/nodes/Node';
import { uid } from '../../common/uuid';

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
	const commandListRef = useRef<HTMLDivElement>(null);

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
				id: uid(),
				type,
				position,
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

				if (node.data.group === 'internal') return groups; // Skip internal nodes
				const firstTag = node.data.tags.at(0) || 'information'; // Use first tag for grouping
				const group = groups.get(firstTag) ?? [];
				group.push({ node, type });
				groups.set(firstTag, group);
				return groups;
			}, new Map<string, { node: BaseNode; type: string }[]>())
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

	useEffect(() => {
		commandListRef.current?.scrollTo({
			top: 0,
			behavior: 'smooth',
		});
	}, [filter]);

	return (
		<CommandDialog
			open={open}
			onOpenChange={state => {
				setOpen(state);
				if (!state) setFilter('');
			}}
			filter={(value, search, keywords) => {
				const [label, description, firstTag] = value.split('|');

				// If no search term, return 0 (not relevant)
				if (!search || search.trim() === '') return 0;

				const searchLower = search.toLowerCase().trim();

				// Priority 1: Label match (highest priority)
				if (label.toLowerCase().includes(searchLower)) return 1;

				// Priority 2: First tag match
				if (firstTag && firstTag.toLowerCase().includes(searchLower)) return 0.9;

				// Priority 3: Description match
				if (description.toLowerCase().includes(searchLower)) return 0.8;

				// Priority 4: Keywords match
				if (keywords?.some(keyword => keyword.toLowerCase().includes(searchLower))) {
					return 0.6;
				}

				// No match found
				return 0;
			}}
		>
			<DialogHeader className='hidden'>
				<DialogTitle>Add new node</DialogTitle>
				<DialogDescription>Magnetic sensor...</DialogDescription>
			</DialogHeader>
			<CommandInput placeholder={searchTerm} onValueChange={setFilter} />
			<CommandList ref={commandListRef} className='mb-2'>
				<CommandEmpty>
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant='icon'>
								<Icons.Search size={24} />
							</EmptyMedia>
							<EmptyTitle>Nothing found</EmptyTitle>
							<EmptyDescription>
								Try searching for a different node type or visit the documentation.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<a href='https://microflow.vercel.app/docs/microflow-studio/nodes' target='_blank'>
								<Button variant='link'>
									<Icons.Book size={24} />
									Visit the documentation
								</Button>
							</a>
						</EmptyContent>
					</Empty>
				</CommandEmpty>
				{groups.map(([group, nodes], index) => (
					<section key={group}>
						<CommandGroup heading={group}>
							{nodes.map(({ node, type }) => {
								return (
									<CommandItem
										value={`${node.data.label}|${node.data.description}`}
										keywords={node.data.tags}
										key={node.data.label}
										onSelect={selectNode(node, type)}
										className='data-[selected=true]:bg-muted-foreground/10 gap-3 items-start group'
									>
										<Avatar className='rounded-xl'>
											<AvatarFallback className='rounded-xl'>
												<Icon
													icon={node.data.icon}
													className='group-data-[selected=true]:scale-110 transition-all duration-100'
													size={16}
												/>
											</AvatarFallback>
										</Avatar>
										<div className='flex flex-col grow gap-3'>
											<div className='flex flex-col gap-1'>
												<div className='font-bold'>{node.data.label}</div>
												<span className='text-muted-foreground'>{node.data.description ?? ''}</span>
											</div>
											<section className='flex items-center gap-2'>
												{node.data.tags.map(tag => (
													<Badge variant='outline' key={tag}>
														{tag}
													</Badge>
												))}
											</section>
										</div>
										<CommandShortcut>{node.data.group}</CommandShortcut>
									</CommandItem>
								);
							})}
						</CommandGroup>
						{index !== groups.length - 1 && <CommandSeparator />}
					</section>
				))}
			</CommandList>
			<footer className='p-2 border-t flex gap-4 justify-between items-center'>
				<a
					href='https://microflow.vercel.app/docs/microflow-studio/nodes'
					target='_blank'
					className='text-xs flex gap-2 items-center text-muted-foreground hover:underline'
				>
					<Icons.Book size={12} />
					Documentation
				</a>
				<section className='flex items-center gap-3'>
					<section className='flex items-center gap-2'>
						<span className='text-xs text-muted-foreground'>Close</span>
						<CommandShortcut className='bg-muted-foreground/10 p-1 rounded-md'>Esc</CommandShortcut>
					</section>
					<section className='flex items-center gap-2'>
						<span className='text-xs text-muted-foreground'>Navigate</span>
						<div className='flex items-center gap-1'>
							<CommandShortcut className='bg-muted-foreground/10 p-1 rounded-md'>
								<Icons.ChevronUp size={12} className='' />
							</CommandShortcut>
							<CommandShortcut className='bg-muted-foreground/10 p-1 rounded-md'>
								<Icons.ChevronDown size={12} className='' />
							</CommandShortcut>
						</div>
					</section>
					<section className='flex items-center gap-2'>
						<span className='text-xs text-muted-foreground'>Select</span>
						<CommandShortcut className='bg-muted-foreground/10 p-1 rounded-md'>
							<Icons.CornerDownLeft size={12} className='' />
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
