import * as YJS from 'yjs';
import { ProviderOptions, WebrtcProvider } from 'y-webrtc';
import { UndoManager } from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { useShallow } from 'zustand/shallow';
import { getLocalItem, setLocalItem } from '../../common/local-storage';
import { Node, Edge } from '@xyflow/react';
import { useAppStore, User } from './app';

export type CollaborationStatus =
	| { type: 'disconnected' }
	| { type: 'connecting' }
	| { type: 'connected'; roomName: string; peers: number }
	| { type: 'error'; message: string };

export type ConnectOptions = ProviderOptions & {
	isJoining?: boolean;
};

export type PeerCursor = User & {
	position: { x: number; y: number };
	clientId: number;
};

export type YjsState = {
	// YJS Document and Collections
	ydoc: YJS.Doc;
	yNodes: YJS.Array<Node>;
	yEdges: YJS.Array<Edge>;

	// Collaboration State
	collaborationStatus: CollaborationStatus;
	peers: number;

	// Undo/Redo
	undoManager: UndoManager;

	// Actions
	connect: (roomName: string, options?: ConnectOptions) => void;
	disconnect: () => void;
	undo: () => void;
	redo: () => void;
	canUndo: () => boolean;
	canRedo: () => boolean;

	// Data Sync
	syncNodesToYjs: (nodes: Node[]) => void;
	syncEdgesToYjs: (edges: Edge[]) => void;
	syncFromYjs: () => { nodes: Node[]; edges: Edge[] };

	// Cursor Tracking
	updateLocalCursor: (position: { x: number; y: number }) => void;
	updateLocalUserData: (user: User | null) => void;
	onPeerCursorsUpdate: (callback: (cursors: PeerCursor[]) => void) => void;

	// Persistence
	saveState: () => void;
	loadState: () => void;

	// Event Handlers
	onYjsUpdate: (callback: (nodes: Node[], edges: Edge[]) => void) => void;
	removeUpdateListener: () => void;
};

export const useYjsStore = create<YjsState>()((set, get) => {
	let provider: WebrtcProvider | null = null;
	let updateCallback: ((nodes: Node[], edges: Edge[]) => void) | null = null;
	let peerCursorsCallback: ((cursors: PeerCursor[]) => void) | null = null;
	let awareness: Awareness | null = null;

	const ydoc = new YJS.Doc();
	const yNodes = ydoc.getArray<Node>('nodes');
	const yEdges = ydoc.getArray<Edge>('edges');

	const localOrigin = { clientId: ydoc.clientID };
	console.log('[COLLABORATION] Local origin', localOrigin);

	const undoManager = new UndoManager([yNodes, yEdges], {
		trackedOrigins: new Set([localOrigin]),
	});

	const updateLocalCursor = (position: { x: number; y: number }) => {
		if (!awareness) return;

		const currentState = awareness.getLocalState();
		console.log('[COLLABORATION] <update-local-cursor>', { position });
		awareness.setLocalState({
			...currentState,
			user: {
				...currentState?.user,
				position,
			},
		});
	};

	const updatePeerCursors = () => {
		if (!awareness) return;

		const states = awareness.getStates();

		const cursors = Array.from(states.entries()).reduce((acc, [clientId, state]) => {
			console.log(
				'[COLLABORATION] <update-peer-cursors>',
				{ clientId, state },
				Number(clientId) === ydoc.clientID
			);
			if (Number(clientId) === ydoc.clientID) return acc;
			const { user } = state;
			if (!user) return acc;
			return [...acc, user];
		}, [] as PeerCursor[]);

		console.log('[COLLABORATION] <update-peer-cursors>', {
			states,
			ydocClientId: ydoc.clientID,
			cursors,
		});

		// Notify listeners about cursor updates
		peerCursorsCallback?.(cursors);
	};

	const updateLocalUserData = (user: User | null) => {
		if (!awareness) return;

		const currentState = awareness.getLocalState();
		awareness.setLocalState({
			...currentState,
			user: {
				name: user?.name ?? 'Anonymous',
				position: currentState?.user?.position ?? { x: 0, y: 0 },
				clientId: ydoc.clientID,
			},
		});
	};

	const saveState = () => {
		try {
			const state = YJS.encodeStateAsUpdate(ydoc);
			const stateString = JSON.stringify(Array.from(state));
			setLocalItem('yjs-state', stateString);
		} catch (error) {
			console.warn('[COLLABORATION] Failed to save state:', error);
		}
	};

	const loadState = () => {
		try {
			const savedState = getLocalItem<string>('yjs-state', '');
			if (!savedState) return;

			const uint8Array = new Uint8Array(JSON.parse(savedState));
			console.debug('[COLLABORATION] <load-saved-state>', { uint8Array });
			YJS.applyUpdate(ydoc, uint8Array);
		} catch (error) {
			console.warn('[COLLABORATION] Failed to load saved state:', error);
		}
	};

	const syncNodesToYjs = (nodes: Node[]) => {
		if (!nodes.length) return;

		// Check for duplicate node IDs in the incoming nodes
		const nodeIds = nodes.map(n => n.id);
		const uniqueNodeIds = new Set(nodeIds);
		if (nodeIds.length !== uniqueNodeIds.size) {
			const duplicates = nodeIds.filter((id, index) => nodeIds.indexOf(id) !== index);
			console.warn('[COLLABORATION] Duplicate node IDs detected in incoming nodes:', duplicates);

			// Remove duplicates from the incoming nodes array
			const seen = new Set();
			const deduplicatedNodes = nodes.filter(node => {
				if (seen.has(node.id)) {
					return false;
				}
				seen.add(node.id);
				return true;
			});

			console.log('[COLLABORATION] Deduplicated nodes:', {
				original: nodes.length,
				deduplicated: deduplicatedNodes.length,
				removed: nodes.length - deduplicatedNodes.length,
			});

			nodes = deduplicatedNodes;
		}

		ydoc.transact(() => {
			// Get current Yjs state
			const currentYNodes = yNodes.toArray();
			const newNodeIds = new Set(nodes.map(n => n.id));

			// Find indices to remove (in reverse order to avoid index shifting)
			const indicesToRemove: number[] = [];
			currentYNodes.forEach((node, index) => {
				if (!newNodeIds.has(node.id)) {
					indicesToRemove.push(index);
				}
			});

			// Remove nodes in reverse order to maintain correct indices
			indicesToRemove.reverse().forEach(index => {
				yNodes.delete(index, 1);
			});

			// Add new nodes and update existing ones
			nodes.forEach(node => {
				const existingIndex = yNodes.toArray().findIndex(n => n.id === node.id);
				if (existingIndex === -1) {
					yNodes.push([node]); // New node
					console.debug('[COLLABORATION] Added new node:', node.id);
				} else {
					// Update existing node
					yNodes.delete(existingIndex, 1);
					yNodes.insert(existingIndex, [node]);
					console.debug('[COLLABORATION] Updated existing node:', node.id);
				}
			});
		}, localOrigin);
	};

	const syncEdgesToYjs = (edges: Edge[]) => {
		if (!edges.length) return;

		ydoc.transact(() => {
			// Get current Yjs state
			const currentYEdges = yEdges.toArray();
			const newEdgeIds = new Set(edges.map(e => e.id));

			// Find indices to remove (in reverse order to avoid index shifting)
			const indicesToRemove: number[] = [];
			currentYEdges.forEach((edge, index) => {
				if (!newEdgeIds.has(edge.id)) {
					indicesToRemove.push(index);
				}
			});

			// Remove edges in reverse order to maintain correct indices
			indicesToRemove.reverse().forEach(index => {
				yEdges.delete(index, 1);
			});

			// Add new edges and update existing ones
			edges.forEach(edge => {
				const existingIndex = yEdges.toArray().findIndex(e => e.id === edge.id);
				if (existingIndex === -1) {
					yEdges.push([edge]); // New edge
				} else {
					// Update existing edge
					yEdges.delete(existingIndex, 1);
					yEdges.insert(existingIndex, [edge]);
				}
			});
		}, localOrigin);
	};

	const syncFromYjs = () => {
		const nodes = yNodes.toArray();
		const edges = yEdges.toArray();
		return { nodes, edges };
	};

	const onYjsUpdate = (callback: (nodes: Node[], edges: Edge[]) => void) => {
		updateCallback = callback;
	};

	const removeUpdateListener = () => {
		updateCallback = null;
	};

	// Handle YJS updates
	const handleYjsUpdate = (
		update: Uint8Array,
		_origin: any,
		_doc: YJS.Doc,
		transaction: YJS.Transaction
	) => {
		// Ignore updates that originate from this local client to prevent feedback loops
		if (localOrigin === transaction.origin) return;

		YJS.applyUpdate(ydoc, update);

		if (updateCallback) {
			const { nodes, edges } = syncFromYjs();
			updateCallback(nodes, edges);
		}
	};

	ydoc.on('update', handleYjsUpdate);
	ydoc.on('update', saveState);

	// Load initial state
	loadState();

	// Initialize with introduction data if no saved state and hasn't seen introduction
	const hasSeenIntroduction = getLocalItem('has-seen-introduction', false);
	if (!hasSeenIntroduction && yNodes.length === 0) {
		// Import introduction data dynamically to avoid circular dependencies
		import('./introduction').then(({ INTRODUCTION_NODES, INTRODUCTION_EDGES }) => {
			// Check if introduction nodes already exist to prevent duplicates
			const existingNodeIds = yNodes.toArray().map(n => n.id);
			const newNodes = INTRODUCTION_NODES.filter(node => !existingNodeIds.includes(node.id));

			if (newNodes.length > 0) {
				ydoc.transact(() => {
					yNodes.push(newNodes);
					yEdges.push(INTRODUCTION_EDGES);
				}, localOrigin);
			}
		});
	}

	// Save state before unload
	window.addEventListener('beforeunload', saveState);

	return {
		ydoc,
		yNodes,
		yEdges,
		collaborationStatus: { type: 'disconnected' },
		peers: 0,
		peerCursors: [],
		undoManager,

		connect: (
			roomName: string,
			options: Omit<ConnectOptions, 'awareness' | 'filterBcConns' | 'peerOpts'> = {}
		) => {
			const { disconnect } = get();
			disconnect();

			if (options.isJoining) {
				ydoc.transact(() => {
					yNodes.delete(0, yNodes.length);
					yEdges.delete(0, yEdges.length);
				}, localOrigin);
			}

			set({ collaborationStatus: { type: 'connecting' } });

			try {
				provider = new WebrtcProvider(roomName, ydoc, {
					signaling: ['wss://signaling.yjs.dev'],
					password: undefined,
					maxConns: 20,
					...options,
					awareness: new Awareness(ydoc),
					filterBcConns: false,
					peerOpts: {},
				});

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

				provider.on('peers', peers => {
					console.debug('[COLLABORATION]', { peers });
					set({ peers: get().peers + peers.added.length - peers.removed.length });
					updatePeerCursors();
				});

				awareness = provider.awareness;
				awareness.on('update', updatePeerCursors);
				updatePeerCursors(); // Initial update
				updateLocalUserData(useAppStore.getState().user); // Set initial local user data
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
			awareness = null;

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

		syncNodesToYjs,
		syncEdgesToYjs,
		syncFromYjs,
		saveState,
		loadState,
		onYjsUpdate,
		removeUpdateListener,
		updateLocalCursor,
		updateLocalUserData,
		onPeerCursorsUpdate: (callback: (cursors: PeerCursor[]) => void) => {
			peerCursorsCallback = callback;
		},
	};
});

// Hooks for collaboration functionality
export function useCollaborationStatus() {
	return useYjsStore(useShallow(state => state.collaborationStatus));
}

export function useCollaborationActions() {
	return useYjsStore(
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
	return useYjsStore(
		useShallow(state => ({
			status: state.collaborationStatus,
			peers: state.peers,
		}))
	);
}

export function useCursorTracking() {
	return useYjsStore(
		useShallow(state => ({
			updateLocalCursor: state.updateLocalCursor,
		}))
	);
}

export function useUpdateLocalUser() {
	return useYjsStore(
		useShallow(state => ({
			updateLocalUserData: state.updateLocalUserData,
		}))
	);
}

export function useYjsSync() {
	return useYjsStore(
		useShallow(state => ({
			syncNodesToYjs: state.syncNodesToYjs,
			syncEdgesToYjs: state.syncEdgesToYjs,
			syncFromYjs: state.syncFromYjs,
			onYjsUpdate: state.onYjsUpdate,
			removeUpdateListener: state.removeUpdateListener,
		}))
	);
}
