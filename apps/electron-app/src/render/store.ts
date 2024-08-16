import {
	Edge,
	Node,
	OnConnect,
	OnEdgesChange,
	OnNodesChange,
	addEdge,
	applyEdgeChanges,
	applyNodeChanges,
} from '@xyflow/react';

import { create } from 'zustand';

export type AppState<NodeData extends Record<string, unknown> = {}> = {
	nodes: Node<NodeData>[];
	edges: Edge[];
	onNodesChange: OnNodesChange<Node<NodeData>>;
	onEdgesChange: OnEdgesChange;
	onConnect: OnConnect;
	setNodes: (nodes: Node<NodeData>[]) => void;
	setEdges: (edges: Edge[]) => void;
	deleteEdges: (nodeId: string, except?: string[]) => void;
	addNode: (node: Node<NodeData>) => void;
	deleteNode: (nodeId: string) => void;
	previousStates: { nodes: Node; edges: Edge[] }[];
	nextStates: { nodes: Node; edges: Edge[] }[];
	undo: () => void;
	redo: () => void;
};

export const baseEdgeConfig: Partial<Edge> = {
	style: { strokeWidth: 4, stroke: '#4b5563' },
};

export const useNodesEdgesStore = create<AppState>((set, get) => ({
	nodes: [],
	edges: [],
	previousStates: [],
	nextStates: [],
	onNodesChange: changes => {
		set({
			nodes: applyNodeChanges(
				changes.filter(change => {
					if (change.type === 'replace') {
						// TODO: find out why items are being replaced with `undefined` as values
						if ((change.item.data as { value: unknown }).value === undefined) {
							return false;
						}
					}
					return change;
				}),
				get().nodes,
			),
		});
	},
	onEdgesChange: changes => {
		set({
			edges: applyEdgeChanges(changes, get().edges).map(edge => {
				if (edge.selected) {
					edge.style = {
						...baseEdgeConfig.style,
						stroke: '#3b82f6',
					};
				} else if (edge.animated) {
					edge.style = {
						...baseEdgeConfig.style,
						stroke: '#eab308',
					};
				} else {
					edge.style = baseEdgeConfig.style;
				}

				return edge;
			}),
		});
	},
	onConnect: connection => {
		const currentEdges = get().edges;
		const newEdges = addEdge(connection, currentEdges);

		set({
			edges: newEdges.map(edge => ({ ...baseEdgeConfig, ...edge })),
		});
	},
	setNodes: nodes => {
		set({ nodes });
	},
	setEdges: edges => {
		set({ edges });
	},
	undo: () => {
		// TODO: Implement undo
	},
	redo: () => {
		// TODO: Implement redo
	},
	deleteEdges: (nodeId, except = []) => {
		const edges = get().edges.filter(edge => {
			const isSource = edge.source === nodeId;
			const isTarget = edge.target === nodeId;
			const isExceptHandle =
				except.includes(edge.sourceHandle) ||
				except.includes(edge.targetHandle);

			if (except.length) {
				return (!isSource || !isTarget) && isExceptHandle;
			}

			return !isSource && !isTarget;
		});
		set({ edges });
	},
	addNode: node => {
		if (!node.data) node.data = {};

		set({
			nodes: [...get().nodes, node],
		});
	},
	deleteNode: nodeId => {
		const nodes = get().nodes.filter(node => node.id !== nodeId);
		set({ nodes });

		const edges = get().edges.filter(
			edge => edge.source !== nodeId && edge.target !== nodeId,
		);
		set({ edges });
	},
}));

export const nodesAndEdgesCountsSelector = (state: AppState) => ({
	nodesCount: state.nodes.length,
	edgesCount: state.edges.length,
});

export const tempNodeSelector = (state: AppState) => ({
	addNode: state.addNode,
	deleteNode: state.deleteNode,
});

export const deleteEdgesSelector = (state: AppState) => ({
	deleteEdges: state.deleteEdges,
});
