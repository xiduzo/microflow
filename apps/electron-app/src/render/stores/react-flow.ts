import {
	Edge,
	EdgeChange,
	Node,
	NodeChange,
	OnConnect,
	OnEdgesChange,
	OnNodesChange,
	addEdge,
	applyEdgeChanges,
	applyNodeChanges,
} from '@xyflow/react';

import { INTRODUCTION_EDGES, INTRODUCTION_NODES } from './introduction';
import { useShallow } from 'zustand/shallow';
// TODO: the new `create` function from `zustand` is re-rendering too much causing an react error -- https://zustand.docs.pmnd.rs/migrations/migrating-to-v5
import { createWithEqualityFn as create } from 'zustand/traditional';
import { getLocalItem, setLocalItem } from '../../common/local-storage';
import { temporal } from 'zundo';

export type ReactFlowState<NodeData extends Record<string, unknown> = {}> = {
	nodes: Node<NodeData>[];
	edges: Edge[];
	onNodesChange: OnNodesChange<Node<NodeData>>;
	onEdgesChange: OnEdgesChange;
	onConnect: OnConnect;
	setNodes: (nodes: Node<NodeData>[]) => void;
	setEdges: (edges: Edge[]) => void;
	deleteEdges: (nodeId: string, handles?: string[]) => void;
};

export const useReactFlowStore = create<ReactFlowState>()(
	temporal(
		(set, get) => {
			const hasSeenIntroduction = getLocalItem('has-seen-introduction', false);

			if (!hasSeenIntroduction) {
				setLocalItem('has-seen-introduction', true);
				setLocalItem('nodes', INTRODUCTION_NODES);
				setLocalItem('edges', INTRODUCTION_EDGES);
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

			return {
				nodes: initialNodes,
				edges: initialEdges,
				onNodesChange: changes => {
					set({ nodes: applyNodeChanges(changes, get().nodes) });
				},
				onEdgesChange: changes => {
					set({ edges: applyEdgeChanges(changes, get().edges) });
				},
				onConnect: connection => {
					set({ edges: addEdge({ ...connection, id: crypto.randomUUID() }, get().edges) });
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
			};
		},
		{
			limit: 50,
			partialize: state => ({
				...state,
				nodes: state.nodes.filter(node => (node.data as { group: string }).group !== 'internal'), // We do not need to keep the internal nodes in the history
				edges: state.edges.map(({ animated, ...rest }) => rest), // We do not need to keep the animated flag in the history
			}),
		}
	)
);

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
