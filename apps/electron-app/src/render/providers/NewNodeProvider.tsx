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
import { Node, useReactFlow } from '@xyflow/react';
import { memo, useEffect, useMemo } from 'react';
import { NODE_TYPES } from '../../common/nodes';
import { useDeleteSelectedNodes, useNodesChange } from '../stores/react-flow';
import { useNewNodeStore } from '../stores/new-node';
import { useWindowSize } from 'usehooks-ts';
import { BaseNode } from '../components/react-flow/nodes/Node';

const NODE_SIZE = {
	width: 208,
	height: 176,
};

export const NewNodeCommandDialog = memo(function NewNodeCommandDialog() {
	useDraggableNewNode();
	useBackspaceOverwrite();

	const { open, setOpen, setNodeToAdd } = useNewNodeStore();
	const { flowToScreenPosition, getZoom } = useReactFlow();
	const changeNodes = useNodesChange();
	const windowSize = useWindowSize();

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
		const groups = Object.entries(NODE_TYPES).reduce((groups, [type, Component]) => {
			const node: BaseNode =
				'defaultProps' in Component ? (Component.defaultProps as any) : { data: {} };

			const group = groups.get(node.data.group) ?? [];
			group.push({ node, type: node.data.baseType ?? type });
			groups.set(node.data.group, group);
			return groups;
		}, new Map<string, { node: BaseNode; type: string }[]>());

		return Array.from(groups);
	}, [NODE_TYPES]);

	return (
		<CommandDialog open={open} onOpenChange={setOpen}>
			<DialogHeader className="hidden">
				<DialogTitle>Add new node</DialogTitle>
				<DialogDescription>Search for a node or node type to add to the flow.</DialogDescription>
			</DialogHeader>
			<CommandInput placeholder="Seach node or node type..." />
			<CommandList>
				<CommandEmpty>No results found.</CommandEmpty>
				{groups.map(([group, nodes], index) => (
					<section key={group}>
						<CommandGroup heading={group}>
							{nodes.map(({ node, type }) => (
								<CommandItem key={node.data.label} onSelect={selectNode(node, type)}>
									<span className="first:first-letter:uppercase lowercase">{node.data.label}</span>
									<CommandShortcut className="space-x-1">
										{node.data.tags.map(tag => (
											<Badge key={tag} variant="outline">
												{tag}
											</Badge>
										))}
									</CommandShortcut>
								</CommandItem>
							))}
						</CommandGroup>
						{index !== groups.length - 1 && <CommandSeparator />}
					</section>
				))}
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
