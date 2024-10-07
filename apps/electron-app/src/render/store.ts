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
import { INTRODUCTION_EDGES, INTRODUCTION_NODES } from './introduction';

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

function getLocalItem<T>(item: string, fallback: T) {
	return JSON.parse(localStorage.getItem(item) ?? JSON.stringify(fallback)) as T;
}

export const useNodesEdgesStore = create<AppState>((set, get) => {
	const hasSeenIntroduction = getLocalItem('has-seen-introduction', false);

	if (!hasSeenIntroduction) {
		localStorage.setItem('has-seen-introduction', 'true');
		localStorage.setItem('nodes', JSON.stringify(INTRODUCTION_NODES));
		localStorage.setItem('edges', JSON.stringify(INTRODUCTION_EDGES));
	}

	const localNodes = getLocalItem<Node[]>('nodes', []).map(node => ({
		...node,
		selected: false,
		data: { ...node.data, animated: false, settingsOpen: false },
	}))

	const localEdges = getLocalItem<Edge[]>('edges', []).map(edge => ({
		...edge,
		animated: false,
		selected: false,
	}))

	return {
		nodes: hasSeenIntroduction ? localNodes : INTRODUCTION_NODES,
		edges: hasSeenIntroduction ? localEdges : INTRODUCTION_EDGES,
		previousStates: [],
		nextStates: [],
		onNodesChange: changes => {
			const actualChanges = changes.filter(change => {
				if (change.type === 'replace') {
					if ('value' in change.item.data) {
						if (change.item.data.value === undefined) {
							return;
						}
					}
				}
				return change;
			});

			set({ nodes: applyNodeChanges(actualChanges, get().nodes) });
		},
		onEdgesChange: changes => {
			set({ edges: applyEdgeChanges(changes, get().edges) });
		},
		onConnect: connection => {
			set({ edges: addEdge(connection, get().edges) });
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
					except.includes(edge.sourceHandle) || except.includes(edge.targetHandle);

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

			const edges = get().edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId);
			set({ edges });
		},
	};
});

export const nodesAndEdgesCountsSelector = (state: AppState) => ({
	nodesCount: state.nodes.length,
	edgesCount: state.edges.length,
});

export const tempNodeSelector = (state: AppState) => ({
	addNode: (node: Node) => {
		state.setNodes([
			...state.nodes.map(stateNode => ({
				...stateNode,
				selected: false,
				data: {
					...stateNode.data,
					settingsOpen: false,
				},
			})),
			node,
		]);
	},
	deleteNode: state.deleteNode,
});

export const deleteEdgesSelector = (state: AppState) => ({
	deleteEdges: state.deleteEdges,
});

export const setNodesAndEdgesSelecor = (state: AppState) => ({
  setNodes: state.setNodes,
  setEdges: state.setEdges,
})
