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
import { LinkedList } from '../../common/LinkedList';
import { INTRODUCTION_EDGES, INTRODUCTION_NODES } from './introduction';
import { useShallow } from 'zustand/react/shallow';

const HISTORY_DEBOUNCE_TIME_IN_MS = 100;

export type AppState<NodeData extends Record<string, unknown> = {}> = {
	nodes: Node<NodeData>[];
	edges: Edge[];
	onNodesChange: OnNodesChange<Node<NodeData>>;
	onEdgesChange: OnEdgesChange;
	onConnect: OnConnect;
	setNodes: (nodes: Node<NodeData>[]) => void;
	setEdges: (edges: Edge[]) => void;
	deleteEdges: (nodeId: string, handles?: string[]) => void;
	deleteSelectedNodesAndEdges: () => void;
	history: LinkedList<{ nodes: Node[]; edges: Edge[] }>;
	undo: () => void;
	redo: () => void;
};

function getLocalItem<T>(item: string, fallback: T) {
	return JSON.parse(localStorage.getItem(item) ?? JSON.stringify(fallback)) as T;
}

export const useReactFlowStore = create<AppState>((set, get) => {
	const hasSeenIntroduction = getLocalItem('has-seen-introduction', false);

	if (!hasSeenIntroduction) {
		localStorage.setItem('has-seen-introduction', 'true');
		localStorage.setItem('nodes', JSON.stringify(INTRODUCTION_NODES));
		localStorage.setItem('edges', JSON.stringify(INTRODUCTION_EDGES));
	}

	const localNodes = getLocalItem<Node[]>('nodes', []).map(node => ({
		...node,
		selected: false,
		data: { ...node.data, settingsOpen: false },
	}));

	const localEdges = getLocalItem<Edge[]>('edges', []).map(edge => ({
		...edge,
		animated: false,
		selected: false,
	}));

	const initialNodes = hasSeenIntroduction ? localNodes : INTRODUCTION_NODES;
	const initialEdges = hasSeenIntroduction ? localEdges : INTRODUCTION_EDGES;

	let historyUpdateDebounce: NodeJS.Timeout | undefined;
	function updateHistory() {
		historyUpdateDebounce && clearTimeout(historyUpdateDebounce);
		historyUpdateDebounce = setTimeout(() => {
			const { nodes, edges, history } = get();
			history.append({ nodes, edges });
		}, HISTORY_DEBOUNCE_TIME_IN_MS);
	}

	return {
		nodes: initialNodes,
		edges: initialEdges,
		history: new LinkedList({ nodes: initialNodes, edges: initialEdges }),
		onNodesChange: changes => {
			set({
				nodes: applyNodeChanges(changes, get().nodes),
			});

			updateHistory();
		},
		onEdgesChange: changes => {
			set({
				edges: applyEdgeChanges(changes, get().edges),
			});
			updateHistory();
		},
		onConnect: connection => {
			set({
				edges: addEdge(connection, get().edges),
			});
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

			const state = history.backward();
			if (!state) return;

			set({ ...state });
		},
		redo: () => {
			const history = get().history;

			const state = history.forward();
			if (!state) return;

			set({ ...state });
		},
	};
});

export function useNodeAndEdgeCount() {
	return useReactFlowStore(
		useShallow(state => ({
			nodesCount: state.nodes.length,
			edgesCount: state.edges.length,
		})),
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
