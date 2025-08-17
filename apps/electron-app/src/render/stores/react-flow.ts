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
	localStorage.clear();
	const hasSeenIntroduction = getLocalItem('has-seen-introduction', false);

	if (!hasSeenIntroduction) {
		setLocalItem('has-seen-introduction', true);
	}

	const initialNodes = hasSeenIntroduction ? [] : INTRODUCTION_NODES;
	const initialEdges = hasSeenIntroduction ? [] : INTRODUCTION_EDGES;

	let provider: WebrtcProvider | null = null;

	const ydoc = new Y.Doc();
	const yNodes = ydoc.getArray<Node>('nodes');
	const yEdges = ydoc.getArray<Edge>('edges');

	const localOrigin = { clientId: ydoc.clientID };
	console.log('[COLLABORATION] Local origin', localOrigin);

	const undoManager = new UndoManager([yNodes, yEdges], {
		trackedOrigins: new Set([localOrigin]),
	});

	const saveYjsState = () => {
		try {
			const state = Y.encodeStateAsUpdate(ydoc);
			const stateString = JSON.stringify(Array.from(state));
			setLocalItem('yjs-state', stateString);
		} catch (error) {
			console.warn('[COLLABORATION] Failed to save state:', error);
		}
	};

	/**
	 * Syncs local React state changes to Yjs document for collaboration
	 * Called when user makes changes to nodes/edges (move, add, delete, etc.)
	 * Excludes selection state as that's local-only
	 */
	const syncLocalChangesToYjs = (nodes: Node[], edges: Edge[]) => {
		if (!localOrigin) return;

		// Check for duplicate node IDs
		const nodeIds = nodes.map(n => n.id);
		const uniqueNodeIds = new Set(nodeIds);
		if (nodeIds.length !== uniqueNodeIds.size) {
			console.warn(
				'[COLLABORATION] Duplicate node IDs detected:',
				nodeIds.filter((id, index) => nodeIds.indexOf(id) !== index)
			);
		}

		// Get current Yjs state
		const currentYNodes = yNodes.toArray();
		const currentYEdges = yEdges.toArray();
		console.debug('[COLLABORATION] <syncLocalChangesToYjs>', {
			nodes,
			edges,
			currentYNodes,
			currentYEdges,
		});

		ydoc.transact(() => {
			const newNodeIds = new Set(nodes.map(n => n.id));

			// Remove nodes that no longer exist
			currentYNodes.forEach((node, index) => {
				if (!newNodeIds.has(node.id)) {
					yNodes.delete(index, 1);
				}
			});

			// Add new nodes and update existing ones
			nodes.forEach(node => {
				const existingIndex = currentYNodes.findIndex(n => n.id === node.id);
				if (existingIndex === -1) {
					// New node
					yNodes.push([node]);
				} else {
					// Update existing node
					yNodes.delete(existingIndex, 1);
					yNodes.insert(existingIndex, [node]);
				}
			});
		}, localOrigin);

		ydoc.transact(() => {
			const newEdgeIds = new Set(edges.map(e => e.id));

			// Remove edges that no longer exist
			currentYEdges.forEach((edge, index) => {
				if (!newEdgeIds.has(edge.id)) {
					yEdges.delete(index, 1);
				}
			});

			// Add new edges and update existing ones
			edges.forEach(edge => {
				const existingIndex = currentYEdges.findIndex(e => e.id === edge.id);
				if (existingIndex === -1) {
					// New edge
					console.debug('[COLLABORATION] <syncLocalChangesToYjs> New edge:', edge);
					yEdges.push([edge]);
				} else {
					// Update existing edge
					yEdges.delete(existingIndex, 1);
					yEdges.insert(existingIndex, [edge]);
				}
			});
		}, localOrigin);

		set({ nodes, edges });
	};

	/**
	 * Syncs Yjs document changes to local React state
	 * Called when Yjs document is updated (from collaboration or undo/redo)
	 * Preserves local selection state while updating content
	 */
	const syncYjsChangesToLocal = (
		update: Uint8Array,
		origin: any,
		doc: Y.Doc,
		transaction: Y.Transaction
	) => {
		// Ignore updates that originate from this local client to prevent feedback loops
		if (origin === localOrigin) {
			console.debug('[COLLABORATION] Ignoring local origin update');
			return;
		}

		const currentState = get();

		Y.applyUpdate(ydoc, update);

		const nodes = yNodes.toArray();
		const edges = yEdges.toArray();

		const nodesWithSelection = nodes.map(node => {
			return {
				...node,
				selected: currentState?.nodes?.find(({ id }) => id === node.id)?.selected ?? false,
			};
		});

		const edgesWithSelection = edges.map(edge => {
			return {
				...edge,
				selected: currentState?.edges?.find(({ id }) => id === edge.id)?.selected ?? false,
			};
		});

		set({ nodes: nodesWithSelection, edges: edgesWithSelection });
	};

	ydoc.on('update', syncYjsChangesToLocal);
	ydoc.on('update', saveYjsState);

	const savedState = getLocalItem<string>('yjs-state', '');

	if (hasSeenIntroduction) {
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
		console.debug('[COLLABORATION] <load-saved-state>', {
			initialNodes,
			initialEdges,
		});
		ydoc.transact(() => {
			yNodes.push(initialNodes);
			yEdges.push(initialEdges);
		});
	}

	window.addEventListener('beforeunload', saveYjsState);

	const saveInterval = setInterval(saveYjsState, 30000);

	return {
		nodes: initialNodes,
		edges: initialEdges,
		collaborationStatus: { type: 'disconnected' },
		peers: 0,

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
			const newEdges = addEdge({ ...connection, id: crypto.randomUUID() }, get().edges);

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
