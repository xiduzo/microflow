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
import * as Y from 'yjs';
import { ProviderOptions, WebrtcProvider } from 'y-webrtc';
import { UndoManager } from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';

export type CollaborationStatus =
	| { type: 'disconnected' }
	| { type: 'connecting' }
	| { type: 'connected'; roomName: string; peers: number }
	| { type: 'error'; message: string };

export type ConnectOptions = ProviderOptions & {
	isJoining?: boolean;
};

export type ReactFlowState<NodeData extends Record<string, unknown> = {}> = {
	nodes: Node<NodeData>[];
	edges: Edge[];
	onNodesChange: OnNodesChange<Node<NodeData>>;
	onEdgesChange: OnEdgesChange;
	onConnect: OnConnect;
	setNodes: (nodes: Node<NodeData>[]) => void;
	setEdges: (edges: Edge[]) => void;
	deleteEdges: (nodeId: string, handles?: string[]) => void;

	// Collaboration
	collaborationStatus: CollaborationStatus;
	peers: number;
	connect: (roomName: string, options?: ConnectOptions) => void;
	disconnect: () => void;
	undo: () => void;
	redo: () => void;
	canUndo: () => boolean;
	canRedo: () => boolean;
};

export const useReactFlowStore = create<ReactFlowState>()((set, get) => {
	const hasSeenIntroduction = getLocalItem('has-seen-introduction', false);

	if (!hasSeenIntroduction) {
		setLocalItem('has-seen-introduction', true);
	}

	const initialNodes = hasSeenIntroduction ? [] : INTRODUCTION_NODES;
	const initialEdges = hasSeenIntroduction ? [] : INTRODUCTION_EDGES;

	let provider: WebrtcProvider | null = null;
	let isUpdatingFromYjs = false;

	const ydoc = new Y.Doc();
	const yNodes = ydoc.getArray<Node>('nodes');
	const yEdges = ydoc.getArray<Edge>('edges');

	const localOrigin = { clientId: ydoc.clientID };
	console.log('[COLLABORATION] Local origin', localOrigin);

	const saveYjsState = () => {
		try {
			const state = Y.encodeStateAsUpdate(ydoc);
			const stateString = JSON.stringify(Array.from(state));
			setLocalItem('yjs-state', stateString);
		} catch (error) {
			console.warn('[COLLABORATION] Failed to save state:', error);
		}
	};

	const updateYjsFromLocal = (nodes: Node[], edges: Edge[]) => {
		if (!localOrigin || isUpdatingFromYjs) return;

		// Check for duplicate node IDs
		const nodeIds = nodes.map(n => n.id);
		const uniqueNodeIds = new Set(nodeIds);
		if (nodeIds.length !== uniqueNodeIds.size) {
			console.warn(
				'[COLLABORATION] Duplicate node IDs detected:',
				nodeIds.filter((id, index) => nodeIds.indexOf(id) !== index)
			);
		}

		// Remove selection state before syncing to Yjs (selection is local-only)
		const nodesWithoutSelection = nodes.map(node => {
			const { selected, ...nodeWithoutSelection } = node as any;
			return nodeWithoutSelection;
		});

		const edgesWithoutSelection = edges.map(edge => {
			const { selected, ...edgeWithoutSelection } = edge as any;
			return edgeWithoutSelection;
		});

		ydoc.transact(() => {
			yNodes.delete(0, yNodes.length);
			yNodes.push(nodesWithoutSelection);
		}, localOrigin);

		ydoc.transact(() => {
			yEdges.delete(0, yEdges.length);
			yEdges.push(edgesWithoutSelection);
		}, localOrigin);
	};

	const updateLocalFromYjs = () => {
		isUpdatingFromYjs = true;
		const nodes = yNodes.toArray() ?? [];
		const edges = yEdges.toArray() ?? [];

		console.debug('[COLLABORATION] <<<< <updateLocalFromYjs>', {
			nodesCount: nodes.length,
			edgesCount: edges.length,
			nodeIds: Array.isArray(nodes) ? nodes.map(n => n.id) : [],
		});

		// Preserve local selection state when syncing from Yjs
		const currentState = get();
		const currentNodes = currentState?.nodes ?? [];
		const currentEdges = currentState?.edges ?? [];

		// Merge selection state from current nodes to new nodes
		const nodesWithSelection = Array.isArray(nodes)
			? nodes.map(node => {
					const currentNode = currentNodes.find(n => n.id === node.id);
					return {
						...node,
						selected: currentNode?.selected ?? false,
					};
				})
			: [];

		// Merge selection state from current edges to new edges
		const edgesWithSelection = Array.isArray(edges)
			? edges.map(edge => {
					const currentEdge = currentEdges.find(e => e.id === edge.id);
					return {
						...edge,
						selected: currentEdge?.selected ?? false,
					};
				})
			: [];

		set({ nodes: nodesWithSelection, edges: edgesWithSelection });
		isUpdatingFromYjs = false;
		saveYjsState();
	};

	ydoc.on('update', updateLocalFromYjs);

	const savedState = getLocalItem<string>('yjs-state', '');

	if (savedState) {
		try {
			const uint8Array = new Uint8Array(JSON.parse(savedState));
			Y.applyUpdate(ydoc, uint8Array);
		} catch (error) {
			console.warn('[COLLABORATION] Failed to load saved state:', error);
			// Initialize with default data if loading fails
			ydoc.transact(() => {
				yNodes.push(initialNodes);
				yEdges.push(initialEdges);
			});
		}
	} else {
		ydoc.transact(() => {
			yNodes.push(initialNodes);
			yEdges.push(initialEdges);
		});
	}

	const undoManager = new UndoManager([yNodes, yEdges], {
		trackedOrigins: new Set([localOrigin]),
	});

	undoManager.on('stack-item-added', event => {
		console.debug('[COLLABORATION] <stack-item-added>', event);
	});

	undoManager.on('stack-item-popped', event => {
		console.debug('[COLLABORATION] <stack-item-popped>', event);
	});

	window.addEventListener('beforeunload', saveYjsState);

	// This should be only enable when the auto save is enabled
	const saveInterval = setInterval(saveYjsState, 30000);

	updateLocalFromYjs();

	return {
		nodes: initialNodes,
		edges: initialEdges,
		collaborationStatus: { type: 'disconnected' },
		peers: 0,

		onNodesChange: changes => {
			const newNodes = applyNodeChanges(changes, get().nodes);

			// Check if this is a selection change (only affects selected property)
			const isSelectionChange = changes.every(
				change =>
					change.type === 'select' ||
					(change.type === 'replace' &&
						change.item &&
						Object.keys(change.item).length === 1 &&
						'selected' in change.item)
			);

			if (isSelectionChange) {
				// Selection changes are local-only, don't sync to Yjs
				set({ nodes: newNodes });
			} else {
				// Non-selection changes should be synced
				updateYjsFromLocal(newNodes, get().edges);
			}
		},

		onEdgesChange: changes => {
			const newEdges = applyEdgeChanges(changes, get().edges);

			// Check if this is a selection change (only affects selected property)
			const isSelectionChange = changes.every(
				change =>
					change.type === 'select' ||
					(change.type === 'replace' &&
						change.item &&
						Object.keys(change.item).length === 1 &&
						'selected' in change.item)
			);

			if (isSelectionChange) {
				// Selection changes are local-only, don't sync to Yjs
				set({ edges: newEdges });
			} else {
				// Non-selection changes should be synced
				updateYjsFromLocal(get().nodes, newEdges);
			}
		},

		onConnect: connection => {
			const newEdges = addEdge({ ...connection, id: crypto.randomUUID() }, get().edges);

			updateYjsFromLocal(get().nodes, newEdges);
		},

		setNodes: nodes => {
			updateYjsFromLocal(nodes, get().edges);
		},

		setEdges: edges => {
			updateYjsFromLocal(get().nodes, edges);
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

			// Update Yjs - this will trigger updateLocalFromYjs which updates the state
			updateYjsFromLocal(get().nodes, edges);
		},

		connect: (roomName: string, options: ConnectOptions = {}) => {
			const { disconnect } = get();
			disconnect();

			set({ collaborationStatus: { type: 'connecting' } });

			try {
				provider = new WebrtcProvider(roomName, ydoc, {
					signaling: ['wss://signaling.yjs.dev'],
					password: undefined,
					maxConns: 20,
					...options,
					awareness: new awarenessProtocol.Awareness(ydoc),
					filterBcConns: false,
					peerOpts: {},
				});

				if (options.isJoining) {
					console.debug('[COLLABORATION] Joining session - clearing local content');
					ydoc.transact(() => {
						yNodes.delete(0, yNodes.length);
						yEdges.delete(0, yEdges.length);
					}, localOrigin);

					set({ nodes: [], edges: [] });
				}

				provider.on('status', ({ connected }) => {
					console.debug('[COLLABORATION] Provider status:', { connected });
					if (!connected) return;
					set({
						collaborationStatus: {
							type: 'connected',
							roomName,
							peers: provider?.awareness.getStates().size ?? 0,
						},
					});
				});

				provider.on('synced', ({ synced }) => {
					console.debug('[COLLABORATION] Sync status:', synced);
					if (!synced) return;
					if (!provider) return;
					set({
						collaborationStatus: {
							type: 'connected',
							roomName,
							peers: provider.awareness.getStates().size,
						},
						peers: provider.awareness.getStates().size,
					});
				});

				provider.on('peers', peers => {
					console.debug('[COLLABORATION] Peers updated:', peers.webrtcPeers);
					console.debug('[COLLABORATION]', { peers });
					set({ peers: peers.webrtcPeers.length });
				});
			} catch (error) {
				console.error('[COLLABORATION] Failed to connect:', error);
				set({
					collaborationStatus: {
						type: 'error',
						message: error instanceof Error ? error.message : 'Failed to connect',
					},
				});
			}
		},

		disconnect: () => {
			provider?.destroy();
			provider = null;

			set({
				collaborationStatus: { type: 'disconnected' },
				peers: 0,
			});
		},

		undo: () => {
			if (!undoManager?.canUndo()) return;
			undoManager.undo();
		},

		redo: () => {
			if (!undoManager?.canRedo()) return;
			undoManager.redo();
		},

		canUndo: () => {
			return undoManager?.canUndo() ?? false;
		},

		canRedo: () => {
			return undoManager?.canRedo() ?? false;
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

// Collaboration hooks
export function useCollaborationStatus() {
	return useReactFlowStore(useShallow(state => state.collaborationStatus));
}

export function useCollaborationActions() {
	return useReactFlowStore(
		useShallow(state => ({
			connect: state.connect,
			disconnect: state.disconnect,
			undo: state.undo,
			redo: state.redo,
			canUndo: state.canUndo,
			canRedo: state.canRedo,
		}))
	);
}

export function useCollaborationState() {
	return useReactFlowStore(
		useShallow(state => ({
			status: state.collaborationStatus,
			peers: state.peers,
		}))
	);
}
