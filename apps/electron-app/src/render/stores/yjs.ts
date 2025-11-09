import * as YJS from 'yjs';
import { ProviderOptions, WebrtcProvider } from 'y-webrtc';
import { UndoManager } from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { useShallow } from 'zustand/shallow';
import { getLocalItem, setLocalItem } from '../../common/local-storage';
import { Node, Edge } from '@xyflow/react';
import { useAppStore, User } from './app';
import logger from 'electron-log/renderer';
import { INTRODUCTION_NODES, INTRODUCTION_EDGES } from './introduction';

export type CollaborationStatus =
	| { type: 'disconnected' }
	| { type: 'connecting' }
	| { type: 'connected'; roomName: string; peers: number; host: boolean }
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
	refreshCursorTracking: () => void;

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

	const undoManager = new UndoManager([yNodes, yEdges], {
		trackedOrigins: new Set([localOrigin]),
	});

	const updateLocalCursor = (position: { x: number; y: number }) => {
		if (!awareness) {
			return;
		}

		const currentState = awareness.getLocalState();
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
			if (Number(clientId) === ydoc.clientID) return acc;
			const { user } = state;
			if (!user) return acc;
			return [...acc, user];
		}, [] as PeerCursor[]);

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
				color: user?.color ?? '#ffcc00',
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
			logger.warn('[COLLABORATION] Failed to save state:', error);
		}
	};

	const loadState = () => {
		try {
			const savedState = getLocalItem<string>('yjs-state', '');
			if (!savedState) return;

			const uint8Array = new Uint8Array(JSON.parse(savedState));
			YJS.applyUpdate(ydoc, uint8Array);
		} catch (error) {
			logger.warn('[COLLABORATION] Failed to load saved state:', error);
		}
	};

	/**
	 * Efficiently syncs nodes to YJS by comparing and updating only what changed
	 */
	const syncNodesToYjs = (nodes: Node[]) => {
		ydoc.transact(() => {
			const existingNodes = yNodes.toArray();
			const newMap = new Map(nodes.map(n => [n.id, n]));

			// Delete nodes that no longer exist (in reverse order to maintain indices)
			for (let i = existingNodes.length - 1; i >= 0; i--) {
				const node = existingNodes[i];
				if (!newMap.has(node.id)) {
					yNodes.delete(i, 1);
				}
			}

			// Update or insert nodes
			const currentNodes = yNodes.toArray();
			nodes.forEach(node => {
				const existingIndex = currentNodes.findIndex(n => n.id === node.id);
				if (existingIndex === -1) {
					// New node - add at the end
					yNodes.push([node]);
				} else {
					// Update existing node - replace if different
					const existing = currentNodes[existingIndex];
					if (JSON.stringify(existing) !== JSON.stringify(node)) {
						yNodes.delete(existingIndex, 1);
						yNodes.insert(existingIndex, [node]);
					}
				}
			});
		}, localOrigin);
	};

	/**
	 * Efficiently syncs edges to YJS by comparing and updating only what changed
	 */
	const syncEdgesToYjs = (edges: Edge[]) => {
		ydoc.transact(() => {
			const existingEdges = yEdges.toArray();
			const newMap = new Map(edges.map(e => [e.id, e]));

			// Delete edges that no longer exist (in reverse order to maintain indices)
			for (let i = existingEdges.length - 1; i >= 0; i--) {
				const edge = existingEdges[i];
				if (!newMap.has(edge.id)) {
					yEdges.delete(i, 1);
				}
			}

			// Update or insert edges
			const currentEdges = yEdges.toArray();
			edges.forEach(edge => {
				const existingIndex = currentEdges.findIndex(e => e.id === edge.id);
				if (existingIndex === -1) {
					// New edge - add at the end
					yEdges.push([edge]);
				} else {
					// Update existing edge - replace if different
					const existing = currentEdges[existingIndex];
					if (JSON.stringify(existing) !== JSON.stringify(edge)) {
						yEdges.delete(existingIndex, 1);
						yEdges.insert(existingIndex, [edge]);
					}
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

	// Listen for updates from remote peers or undo/redo operations
	// Use afterTransaction to access the transaction object
	ydoc.on('afterTransaction', transaction => {
		// Only handle transactions that modified nodes or edges
		if (transaction.changedParentTypes.has(yNodes) || transaction.changedParentTypes.has(yEdges)) {
			// Ignore local transactions to prevent feedback loops
			if (transaction.origin === localOrigin) return;

			// Notify listeners of the update
			if (updateCallback) {
				const { nodes, edges } = syncFromYjs();
				updateCallback(nodes, edges);
			}
		}
	});

	// Save state on any update
	ydoc.on('update', saveState);

	// Load initial state
	loadState();

	// Initialize with introduction data if no saved state and hasn't seen introduction
	const hasSeenIntroduction = getLocalItem('has-seen-introduction', false);
	console.log('hasSeenIntroduction', hasSeenIntroduction);
	if (!hasSeenIntroduction) {
		// Import introduction data dynamically to avoid circular dependencies
		ydoc.transact(() => {
			yNodes.push(INTRODUCTION_NODES);
			yEdges.push(INTRODUCTION_EDGES);
		}, localOrigin);
		setLocalItem('has-seen-introduction', true);
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

			// Ensure room name has the microflow prefix for consistency
			const normalizedRoomName = roomName.startsWith('microflow-')
				? roomName
				: `microflow-${roomName}`;

			if (options.isJoining) {
				ydoc.transact(() => {
					yNodes.delete(0, yNodes.length);
					yEdges.delete(0, yEdges.length);
				}, localOrigin);
			}

			set({ collaborationStatus: { type: 'connecting' } });

			try {
				provider = new WebrtcProvider(normalizedRoomName, ydoc, {
					signaling: ['wss://signaling.yjs.dev'],
					password: undefined,
					maxConns: 20,
					...options,
					awareness: new Awareness(ydoc),
					filterBcConns: false,
					peerOpts: {},
				});

				provider.on('status', ({ connected }) => {
					if (!connected) return;
					set({
						collaborationStatus: {
							type: 'connected',
							roomName: normalizedRoomName,
							host: !options.isJoining,
							peers: provider?.awareness.getStates().size ?? 0,
						},
					});

					// Ensure cursor tracking is properly initialized after connection
					setTimeout(() => {
						updatePeerCursors();
						updateLocalUserData(useAppStore.getState().user);
					}, 100);
				});

				provider.on('peers', peers => {
					logger.debug('[COLLABORATION]', { peers });
					set({ peers: get().peers + peers.added.length - peers.removed.length });
					updatePeerCursors();
				});

				awareness = provider.awareness;
				awareness.on('update', updatePeerCursors);
				updatePeerCursors(); // Initial update
				updateLocalUserData(useAppStore.getState().user); // Set initial local user data
			} catch (error) {
				logger.error('[COLLABORATION] Failed to connect:', error);
				set({
					collaborationStatus: {
						type: 'error',
						message: error instanceof Error ? error.message : 'Failed to connect',
					},
				});
			}
		},

		disconnect: () => {
			// Clean up awareness event listeners before destroying provider
			awareness?.off('update', updatePeerCursors);

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
		refreshCursorTracking: () => {
			updatePeerCursors();
			updateLocalUserData(useAppStore.getState().user);
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
