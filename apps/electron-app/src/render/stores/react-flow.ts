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

const SYNC_TO_YJS_DEBOUNCE_TIMEOUT = 250;

export const useReactFlowStore = create<ReactFlowState>()((set, get) => {
	// Get YJS store for collaboration
	const yjsStore = useYjsStore.getState();

	// Debounce timeout for syncing changes to YJS (stored in closure)
	let syncToYjsDebounceTimeout: NodeJS.Timeout | undefined;

	/**
	 * Preserves local selection state when syncing from YJS
	 * Selection is local-only and shouldn't be overwritten by remote updates
	 */
	const preserveSelection = (nodes: Node[], edges: Edge[]) => {
		const currentState = get();
		const selectionMap = {
			nodes: new Map(currentState.nodes.map(n => [n.id, n.selected])),
			edges: new Map(currentState.edges.map(e => [e.id, e.selected])),
		};

		return {
			nodes: nodes.map(node => ({
				...node,
				selected: selectionMap.nodes.get(node.id) ?? false,
			})),
			edges: edges.map(edge => ({
				...edge,
				selected: selectionMap.edges.get(edge.id) ?? false,
			})),
		};
	};

	// Set up YJS update listener to sync changes back to React Flow
	yjsStore.onYjsUpdate((nodes, edges) => {
		const { nodes: nodesWithSelection, edges: edgesWithSelection } = preserveSelection(
			nodes,
			edges
		);
		set({ nodes: nodesWithSelection, edges: edgesWithSelection });
	});

	// Load initial state from YJS
	const { nodes: yjsNodes, edges: yjsEdges } = yjsStore.syncFromYjs();

	// Deduplicate nodes/edges by ID to prevent React key conflicts
	const deduplicate = <T extends { id: string }>(items: T[]): T[] => {
		const map = new Map<string, T>();
		items.forEach(item => {
			if (map.has(item.id)) {
				console.warn(`[REACT-FLOW] Duplicate ${item.constructor.name} ID found:`, item.id);
			} else {
				map.set(item.id, item);
			}
		});
		return Array.from(map.values());
	};

	const finalNodes = deduplicate(yjsNodes);
	const finalEdges = deduplicate(yjsEdges);

	/**
	 * Syncs local React state changes to Yjs document for collaboration
	 * Called when user makes changes to nodes/edges (move, add, delete, etc.)
	 * Excludes selection state as that's local-only
	 * Debounced to prevent excessive YJS updates during rapid changes
	 */
	const syncLocalChangesToYjs = (nodes: Node[], edges: Edge[]) => {
		// Update local state immediately for responsive UI
		set({ nodes, edges });

		// Debounce YJS sync to batch rapid changes
		clearTimeout(syncToYjsDebounceTimeout);
		syncToYjsDebounceTimeout = setTimeout(() => {
			yjsStore.syncNodesToYjs(nodes);
			yjsStore.syncEdgesToYjs(edges);
		}, SYNC_TO_YJS_DEBOUNCE_TIMEOUT);
	};

	return {
		nodes: finalNodes,
		edges: finalEdges,

		onNodesChange: changes => {
			const newNodes = applyNodeChanges(changes, get().nodes);

			syncLocalChangesToYjs(newNodes, get().edges);
		},

		onEdgesChange: changes => {
			const newEdges = applyEdgeChanges(changes, get().edges);

			syncLocalChangesToYjs(get().nodes, newEdges);
		},

		onConnect: connection => {
			const newEdges = addEdge({ ...connection, id: uid(), type: 'animated' }, get().edges);

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
	return useReactFlowStore(
		useShallow(
			({ nodes }) =>
				() =>
					nodes.filter(({ selected }) => selected)
		)
	);
}

export function useSelectedEdges() {
	return useReactFlowStore(
		useShallow(
			({ edges }) =>
				() =>
					edges.filter(({ selected }) => selected)
		)
	);
}

export function useNonInternalNodes() {
	return useReactFlowStore(
		useShallow(
			({ nodes }) =>
				() =>
					nodes.filter(({ data }) => 'group' in data && data.group !== 'internal')
		)
	);
}
