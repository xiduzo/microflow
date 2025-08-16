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
import { WebrtcProvider } from 'y-webrtc';
import { UndoManager } from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';

export type CollaborationStatus =
	| { type: 'disconnected' }
	| { type: 'connecting' }
	| { type: 'connected'; roomName: string; peers: number }
	| { type: 'error'; message: string };

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
	connect: (roomName: string) => void;
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

	// Always use Yjs as the single source of truth
	const ydoc = new Y.Doc();
	const yNodes = ydoc.getArray<Node>('nodes');
	const yEdges = ydoc.getArray<Edge>('edges');

	// Load saved state from localStorage if available
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
		// Initialize Yjs with initial data
		ydoc.transact(() => {
			yNodes.push(initialNodes);
			yEdges.push(initialEdges);
		});
	}

	// Unique origin object for this client
	const localOrigin = { clientId: ydoc.clientID };

	// Undo manager for local changes only
	const undoManager = new UndoManager([yNodes, yEdges], {
		trackedOrigins: new Set([localOrigin]),
	});

	// Set up undo/redo event listeners
	undoManager.on('stack-item-added', event => {
		console.debug('[COLLABORATION] Undo stack item added', event);
	});

	undoManager.on('stack-item-popped', event => {
		console.debug('[COLLABORATION] Undo stack item popped', event);
	});

	// Collaboration state
	let provider: WebrtcProvider | null = null;
	let isUpdatingFromYjs = false;

	const updateYjsFromLocal = (nodes: Node[], edges: Edge[]) => {
		if (!localOrigin || isUpdatingFromYjs) return;

		ydoc.transact(() => {
			yNodes.delete(0, yNodes.length);
			yNodes.push(nodes);
		}, localOrigin);

		ydoc.transact(() => {
			yEdges.delete(0, yEdges.length);
			yEdges.push(edges);
		}, localOrigin);
	};

	const updateLocalFromYjs = () => {
		isUpdatingFromYjs = true;
		const nodes = yNodes.toArray();
		const edges = yEdges.toArray();

		set({ nodes, edges });
		isUpdatingFromYjs = false;
	};

	// Listen for Yjs updates (both local and remote)
	ydoc.on('update', updateLocalFromYjs);

	// Save Yjs state to localStorage periodically and on updates
	const saveYjsState = () => {
		try {
			const state = Y.encodeStateAsUpdate(ydoc);
			const stateString = JSON.stringify(Array.from(state));
			setLocalItem('yjs-state', stateString);
		} catch (error) {
			console.warn('[COLLABORATION] Failed to save state:', error);
		}
	};

	// Save state on every update
	ydoc.on('update', saveYjsState);

	// Save state periodically (every 30 seconds)
	const saveInterval = setInterval(saveYjsState, 30000);

	// Save state when the app is about to close
	window.addEventListener('beforeunload', saveYjsState);

	// Initial sync
	updateLocalFromYjs();

	return {
		nodes: initialNodes,
		edges: initialEdges,
		collaborationStatus: { type: 'disconnected' },
		peers: 0,

		onNodesChange: changes => {
			const newNodes = applyNodeChanges(changes, get().nodes);

			updateYjsFromLocal(newNodes, get().edges);
		},

		onEdgesChange: changes => {
			const newEdges = applyEdgeChanges(changes, get().edges);

			updateYjsFromLocal(get().nodes, newEdges);
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

		// Collaboration methods
		connect: (roomName: string) => {
			const { disconnect } = get();
			disconnect();

			set({ collaborationStatus: { type: 'connecting' } });

			try {
				provider = new WebrtcProvider(roomName, ydoc, {
					signaling: ['wss://signaling.yjs.dev'],
					password: undefined,
					awareness: new awarenessProtocol.Awareness(ydoc),
					maxConns: 20,
					filterBcConns: false,
					peerOpts: {},
				});

				// Set up provider event listeners
				provider.on('status', ({ connected }) => {
					console.debug('[COLLABORATION] Provider status:', { connected });
					if (connected) {
						set({
							collaborationStatus: {
								type: 'connected',
								roomName,
								peers: provider?.awareness.getStates().size ?? 0,
							},
						});
					}
				});

				provider.on('synced', ({ synced }) => {
					console.debug('[COLLABORATION] Sync status:', synced);
					if (synced && provider) {
						set({
							collaborationStatus: {
								type: 'connected',
								roomName,
								peers: provider.awareness.getStates().size,
							},
							peers: provider.awareness.getStates().size,
						});
					}
				});

				provider.on('peers', peers => {
					console.debug('[COLLABORATION] Peers updated:', peers.webrtcPeers);
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
