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

import { useShallow } from 'zustand/shallow';
// TODO: the new `create` function from `zustand` is re-rendering too much causing an react error -- https://zustand.docs.pmnd.rs/migrations/migrating-to-v5
import { createWithEqualityFn as create } from 'zustand/traditional';
import { useYjsStore } from './yjs';
import { uid } from '../../common/uuid';

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

// Debounce timeout ref for syncing changes to YJS
let syncToYjsDebounceTimeout: NodeJS.Timeout | null = null;

export const useReactFlowStore = create<ReactFlowState>()((set, get) => {
	// Get YJS store for collaboration
	const yjsStore = useYjsStore.getState();

	// Set up YJS update listener to sync changes back to React Flow
	yjsStore.onYjsUpdate((nodes, edges) => {
		const currentState = get();

		// Preserve local selection state
		const nodesWithLocalSelection = nodes.map(node => ({
			...node,
			selected: currentState?.nodes?.find(({ id }) => id === node.id)?.selected ?? false,
		}));

		const edgesWithLocalSelection = edges.map(edge => ({
			...edge,
			selected: currentState?.edges?.find(({ id }) => id === edge.id)?.selected ?? false,
		}));

		set({ nodes: nodesWithLocalSelection, edges: edgesWithLocalSelection });
	});

	// Load initial state from YJS
	const { nodes: yjsNodes, edges: yjsEdges } = yjsStore.syncFromYjs();

	// Deduplicate nodes by ID to prevent React key conflicts
	const nodeMap = new Map();
	yjsNodes.forEach(node => {
		if (!nodeMap.has(node.id)) {
			nodeMap.set(node.id, node);
		} else {
			console.warn('[REACT-FLOW] Duplicate node ID found during initialization:', node.id);
		}
	});
	const edgeMap = new Map();
	yjsEdges.forEach(edge => {
		if (!edgeMap.has(edge.id)) {
			edgeMap.set(edge.id, edge);
		} else {
			console.warn('[REACT-FLOW] Duplicate edge ID found during initialization:', edge.id);
		}
	});

	const finalNodes = Array.from(nodeMap.values());
	const finalEdges = Array.from(edgeMap.values());

	/**
	 * Syncs local React state changes to Yjs document for collaboration
	 * Called when user makes changes to nodes/edges (move, add, delete, etc.)
	 * Excludes selection state as that's local-only
	 * Debounced to prevent excessive YJS updates during rapid changes
	 */
	const syncLocalChangesToYjs = (nodes: Node[], edges: Edge[]) => {
		// Set state with all nodes
		set({ nodes, edges });

		clearTimeout(syncToYjsDebounceTimeout ?? undefined);

		// Set new timeout to debounce the sync operation
		syncToYjsDebounceTimeout = setTimeout(() => {
			yjsStore.syncNodesToYjs(nodes);
			yjsStore.syncEdgesToYjs(edges);
			syncToYjsDebounceTimeout = null;
		}, 300); // 300ms debounce delay
	};

	return {
		nodes: finalNodes,
		edges: finalEdges,

		onNodesChange: changes => {
			const newNodes = applyNodeChanges(changes, get().nodes);

			const isSelectionChange = changes.every(change => change.type === 'select');

			if (isSelectionChange) {
				set({ nodes: newNodes }); // Selection changes are local-only, don't sync to Yjs
				return;
			}

			syncLocalChangesToYjs(newNodes, get().edges);
		},

		onEdgesChange: changes => {
			const newEdges = applyEdgeChanges(changes, get().edges);

			const isSelectionChange = changes.every(change => change.type === 'select');

			if (isSelectionChange) {
				set({ edges: newEdges }); // Selection changes are local-only, don't sync to Yjs
				return;
			}
			syncLocalChangesToYjs(get().nodes, newEdges);
		},

		onConnect: connection => {
			const newEdges = addEdge({ ...connection, id: uid() }, get().edges);

			syncLocalChangesToYjs(get().nodes, newEdges);
		},

		setNodes: nodes => {
			syncLocalChangesToYjs(nodes, get().edges);
		},

		setEdges: edges => {
			syncLocalChangesToYjs(get().nodes, edges);
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

			syncLocalChangesToYjs(get().nodes, edges);
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

export function useSelectedNodes() {
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
