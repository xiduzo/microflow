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

import { LinkedList } from '../../common/LinkedList';
import { INTRODUCTION_EDGES, INTRODUCTION_NODES } from './introduction';
import { useShallow } from 'zustand/shallow';
// TODO: the new `create` function from `zustand` is re-rendering too much causing an react error -- https://zustand.docs.pmnd.rs/migrations/migrating-to-v5
import { createWithEqualityFn as create } from 'zustand/traditional';

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

let historyUpdateDebounce: NodeJS.Timeout | undefined;

function updateHistory(get: () => AppState<{}>) {
	historyUpdateDebounce && clearTimeout(historyUpdateDebounce);
	historyUpdateDebounce = setTimeout(() => {
		const { nodes, edges, history } = get();
		history.append({
			nodes: JSON.parse(JSON.stringify(nodes)), // remove references
			edges: JSON.parse(JSON.stringify(edges)), // remove references
		});

		console.debug(`[HISTORY]`, history);
	}, HISTORY_DEBOUNCE_TIME_IN_MS);
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
	}));

	const localEdges = getLocalItem<Edge[]>('edges', []).map(edge => ({
		...edge,
		animated: false,
		selected: false,
	}));

	const initialNodes = hasSeenIntroduction ? localNodes : INTRODUCTION_NODES;
	const initialEdges = hasSeenIntroduction ? localEdges : INTRODUCTION_EDGES;

	return {
		nodes: initialNodes,
		edges: initialEdges,
		history: new LinkedList({ nodes: initialNodes, edges: initialEdges }),
		onNodesChange: changes => {
			set({
				nodes: applyNodeChanges(changes, get().nodes),
			});

			// IDEA maybe select and unselect all edges connected to the node?
			const hasChangesWhichNeedSaving = changes.some(change => change.type !== 'select');

			if (!hasChangesWhichNeedSaving) return;
			updateHistory(get);
		},
		onEdgesChange: changes => {
			set({
				edges: applyEdgeChanges(changes, get().edges),
			});

			const hasChangesWhichNeedSaving = changes.some(
				change => change.type === 'add' || change.type === 'remove',
			);
			if (!hasChangesWhichNeedSaving) return;
			updateHistory(get);
		},
		onConnect: connection => {
			set({
				edges: addEdge(connection, get().edges),
			});
			updateHistory(get);
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

export function useSelectAll() {
	return useReactFlowStore(
		useShallow(state => () => {
			state.onNodesChange(
				state.nodes.map(node => ({ type: 'select', selected: true, id: node.id })),
			);
			state.onEdgesChange(
				state.edges.map(edge => ({ type: 'select', selected: true, id: edge.id })),
			);
		}),
	);
}

export function useDeselectAll() {
	return useReactFlowStore(
		useShallow(state => () => {
			state.onNodesChange(
				state.nodes.map(node => ({ type: 'select', selected: false, id: node.id })),
			);
			state.onEdgesChange(
				state.edges.map(edge => ({ type: 'select', selected: false, id: edge.id })),
			);
		}),
	);
}

export function useSelectNodes() {
	return useReactFlowStore(useShallow(state => () => state.nodes.filter(node => node.selected)));
}

export function useSelectedEdges() {
	return useReactFlowStore(useShallow(state => () => state.edges.filter(edge => edge.selected)));
}
