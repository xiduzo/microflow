import {
	Edge,
	EdgeAddChange,
	EdgeChange,
	EdgeRemoveChange,
	Node,
	NodeAddChange,
	NodeChange,
	NodePositionChange,
	NodeRemoveChange,
	NodeReplaceChange,
	NodeSelectionChange,
	OnConnect,
	OnEdgesChange,
	OnNodesChange,
	addEdge,
	applyEdgeChanges,
	applyNodeChanges,
} from '@xyflow/react';

import { HistoryList } from '../../common/LinkedList';
import { INTRODUCTION_EDGES, INTRODUCTION_NODES } from './introduction';
import { useShallow } from 'zustand/shallow';
// TODO: the new `create` function from `zustand` is re-rendering too much causing an react error -- https://zustand.docs.pmnd.rs/migrations/migrating-to-v5
import { createWithEqualityFn as create } from 'zustand/traditional';
import { getLocalItem, setLocalItem } from '../../common/local-storage';

type HistoryNodeChange = {
	type: 'node';
	back: NodeChange;
	forward: NodeChange;
};
type HistoryEdgeChange = {
	type: 'edge';
	back: EdgeChange;
	forward: EdgeChange;
};

type HistoryChange = HistoryNodeChange | HistoryEdgeChange;

export type ReactFlowState<NodeData extends Record<string, unknown> = {}> = {
	nodes: Node<NodeData>[];
	edges: Edge[];
	onNodesChange: OnNodesChange<Node<NodeData>>;
	onEdgesChange: OnEdgesChange;
	onConnect: OnConnect;
	setNodes: (nodes: Node<NodeData>[]) => void;
	setEdges: (edges: Edge[]) => void;
	deleteEdges: (nodeId: string, handles?: string[]) => void;
	deleteSelectedNodesAndEdges: () => void;
	history: HistoryList<Array<HistoryChange>>;
	undo: () => void;
	redo: () => void;
};

export const useReactFlowStore = create<ReactFlowState>((set, get) => {
	const hasSeenIntroduction = getLocalItem('has-seen-introduction', false);

	if (!hasSeenIntroduction) {
		setLocalItem('has-seen-introduction', true);
		setLocalItem('nodes', JSON.stringify(INTRODUCTION_NODES));
		setLocalItem('edges', JSON.stringify(INTRODUCTION_EDGES));
	}

	const localNodes = getLocalItem<Node[]>('nodes', [])
		.filter(node => node.data.group !== 'internal')
		.map(node => ({
			...node,
			selected: false,
		}));

	const localEdges = getLocalItem<Edge[]>('edges', []).map(edge => ({
		...edge,
		animated: false,
		selected: false,
	}));

	const initialNodes = hasSeenIntroduction ? localNodes : INTRODUCTION_NODES;
	const initialEdges = hasSeenIntroduction ? localEdges : INTRODUCTION_EDGES;

	function getNodeId(change: NodeChange): string {
		if ('id' in change) return change.id;
		if ('data' in change) {
			if (typeof change.data === 'object' && change.data !== null && 'id' in change.data) {
				return String(change.data.id);
			}
		}
		return crypto.randomUUID();
	}

	return {
		nodes: initialNodes,
		edges: initialEdges,
		history: new HistoryList(),
		onNodesChange: changes => {
			// IDEA selected all connected edges when selecting a node
			const nodes = get().nodes;

			changes.forEach(change => {
				console.log(change);
			});

			const changesWithNodeIds = changes.map(change => ({ ...change, id: getNodeId(change) }));

			const newNodes = applyNodeChanges(changesWithNodeIds, nodes);

			set({ nodes: newNodes });

			const changesToPutInHistory = changesWithNodeIds.filter(change => {
				if (change.type !== 'position') return true;

				const node = newNodes.concat(nodes).find(node => node.id === change.id);
				if (!node) return false;

				return 'group' in node.data ? node.data.group !== 'internal' : true;
			});

			if (!changesToPutInHistory.length) return;

			get().history.push(
				changesToPutInHistory
					.map(change => {
						const previousNode = nodes.find(node => node.id === change.id);
						const newNode = newNodes.find(node => node.id === change.id);

						switch (change.type) {
							case 'add':
								if (!newNode) return null;
								return {
									type: 'node',
									back: { type: 'remove', id: newNode.id } satisfies NodeRemoveChange,
									forward: change,
								} satisfies HistoryChange;
							case 'remove':
								if (!previousNode) return null;
								return {
									type: 'node',
									back: {
										type: 'add',
										item: previousNode,
									} satisfies NodeAddChange,
									forward: change,
								} satisfies HistoryChange;
							case 'replace':
								if (!previousNode) return null;
								return {
									type: 'node',
									back: {
										type: 'replace',
										id: previousNode.id,
										item: previousNode,
									} satisfies NodeReplaceChange,
									forward: change,
								} satisfies HistoryChange;
							case 'position':
								if (!previousNode) return null;
								return {
									type: 'node',
									back: {
										type: 'position',
										id: previousNode.id,
										position: previousNode.position,
									} satisfies NodePositionChange,
									forward: change,
								} satisfies HistoryChange;
							case 'select':
								if (!previousNode) return null;
								return {
									type: 'node',
									back: {
										type: 'select',
										id: previousNode.id,
										selected: !change.selected,
									} satisfies NodeSelectionChange,
									forward: change,
								} satisfies HistoryChange;
							case 'dimensions': // We dont allow users to change the dimensions of a node
							default:
								return null;
						}
					})
					.filter(change => !!change)
			);
		},
		onEdgesChange: changes => {
			const edges = get().edges;
			const changesWithIds = changes.map(change => ({
				...change,
				id: 'id' in change ? change.id : crypto.randomUUID(),
			}));

			const newEdges = applyEdgeChanges(changesWithIds, edges);
			set({ edges: newEdges });

			const changesWithoutAnimated = changesWithIds.filter(change => {
				switch (change.type) {
					case 'replace':
						return false;
					default:
						return true;
				}
			});

			if (!changesWithoutAnimated.length) return;

			get().history.push(
				changesWithoutAnimated.map(change => ({
					type: 'edge',
					back: change,
					forward: change,
				}))
			);
		},
		onConnect: connection => {
			const edges = get().edges;
			const connectionWithId: Edge = { ...connection, id: crypto.randomUUID() };

			const newEdges = addEdge(connectionWithId, edges);
			set({ edges: newEdges });

			get().history.push([
				{
					type: 'edge',
					forward: {
						type: 'add',
						item: connectionWithId,
					} satisfies EdgeAddChange,
					back: {
						type: 'remove',
						id: connectionWithId.id,
					} satisfies EdgeRemoveChange,
				},
			]);
		},
		setNodes: nodes => {
			set({ nodes });
		},
		setEdges: edges => {
			set({ edges });
		},
		deleteEdges: (nodeId, handles = []) => {
			if (!handles.length) return;

			const edges = get().edges.filter(edge => {
				const isSource = edge.source === nodeId;
				const isTarget = edge.target === nodeId;

				if (!isSource && !isTarget) return true;

				if (isTarget && !handles.includes(edge.targetHandle ?? '')) return true;
				if (isSource && !handles.includes(edge.sourceHandle ?? '')) return true;

				return false;
			});

			set({ edges });
		},
		deleteSelectedNodesAndEdges: () => {
			const nodes = get().nodes.filter(node => !node.selected);
			const edges = get().edges.filter(edge => !edge.selected);
			set({ nodes, edges });
		},
		undo: () => {
			const history = get().history;
			history.flush();
			const back = history.getCurrent();

			if (!back?.length) return;

			set({
				nodes: applyNodeChanges(
					back.filter(change => change.type === 'node').map(change => change.back),
					get().nodes
				),
				edges: applyEdgeChanges(
					back.filter(change => change.type === 'edge').map(change => change.back),
					get().edges
				),
			});

			history.back();
		},
		redo: () => {
			const history = get().history;
			history.flush();
			const forward = history.getCurrent();

			console.log(forward, 'redo');

			if (!forward?.length) return;

			set({
				nodes: applyNodeChanges(
					forward.filter(change => change.type === 'node').map(change => change.forward),
					get().nodes
				),
				edges: applyEdgeChanges(
					forward.filter(change => change.type === 'edge').map(change => change.forward),
					get().edges
				),
			});
			history.forward();
		},
	};
});

export function useReactFlowCanvas() {
	return useReactFlowStore(
		useShallow(state => ({
			nodes: state.nodes,
			edges: state.edges,
			onNodesChange: state.onNodesChange,
			onEdgesChange: state.onEdgesChange,
			onConnect: state.onConnect,
		}))
	);
}

export function useNodeAndEdgeCount() {
	return useReactFlowStore(
		useShallow(state => ({
			nodesCount: state.nodes.length,
			edgesCount: state.edges.length,
		}))
	);
}

export function useNodesChange() {
	return useReactFlowStore(useShallow(state => state.onNodesChange));
}

export function useDeleteEdges() {
	return useReactFlowStore(useShallow(state => state.deleteEdges));
}

export function useEdges() {
	return useReactFlowStore(useShallow(state => state.edges));
}

export function useDeleteSelectedNodesAndEdges() {
	return useReactFlowStore(useShallow(state => state.deleteSelectedNodesAndEdges));
}

export function useSelectAll() {
	return useReactFlowStore(
		useShallow(state => () => {
			state.onNodesChange(
				state.nodes.map(node => ({
					type: 'select',
					selected: true,
					id: node.id,
				}))
			);
			state.onEdgesChange(
				state.edges.map(edge => ({
					type: 'select',
					selected: true,
					id: edge.id,
				}))
			);
		})
	);
}

export function useDeselectAll() {
	return useReactFlowStore(
		useShallow(state => () => {
			state.onNodesChange(
				state.nodes.map(node => ({
					type: 'select',
					selected: false,
					id: node.id,
				}))
			);
			state.onEdgesChange(
				state.edges.map(edge => ({
					type: 'select',
					selected: false,
					id: edge.id,
				}))
			);
		})
	);
}

export function useSelectNodes() {
	return useReactFlowStore(useShallow(state => () => state.nodes.filter(node => node.selected)));
}

export function useSelectedEdges() {
	return useReactFlowStore(useShallow(state => () => state.edges.filter(edge => edge.selected)));
}

export function useNonInternalNodes() {
	return useReactFlowStore(
		useShallow(
			state => () =>
				state.nodes.filter(node => (node.data as { group: string }).group !== 'internal')
		)
	);
}
