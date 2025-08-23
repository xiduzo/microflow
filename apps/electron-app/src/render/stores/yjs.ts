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
			console.warn('[COLLABORATION] Failed to save state:', error);
		}
	};

	const loadState = () => {
		try {
			const savedState = getLocalItem<string>('yjs-state', '');
			if (!savedState) return;

			const uint8Array = new Uint8Array(JSON.parse(savedState));
			YJS.applyUpdate(ydoc, uint8Array);
		} catch (error) {
			console.warn('[COLLABORATION] Failed to load saved state:', error);
		}
	};

	const syncNodesToYjs = (nodes: Node[]) => {
		ydoc.transact(() => {
			const existingNodes = yNodes.toArray();
			// Remove nodes that are not in the new nodes array
			// Use filter to get nodes to remove, then delete them in reverse order
			existingNodes
				.map((node, index) => ({ node, index }))
				.filter(({ node }) => !nodes.some(n => n.id === node.id))
				.reverse() // Reverse to delete from end first
				.filter(({ index }) => yNodes.delete(index, 1));

			// Add new nodes and update existing ones
			nodes.forEach(node => {
				const existingIndex = existingNodes.findIndex(n => n.id === node.id);
				switch (existingIndex) {
					case -1: // New node
						yNodes.push([node]);
						break;
					default: // Update existing node
						yNodes.delete(existingIndex, 1);
						yNodes.insert(existingIndex, [node]);
						break;
				}
			});
		}, localOrigin);
	};

	const syncEdgesToYjs = (edges: Edge[]) => {
		ydoc.transact(() => {
			const existingEdges = yEdges.toArray();
			// Remove edges that are not in the new edges array
			// Use filter to get edges to remove, then delete them in reverse order
			existingEdges
				.map((edge, index) => ({ edge, index }))
				.filter(({ edge }) => !edges.some(e => e.id === edge.id))
				.reverse() // Reverse to delete from end first
				.forEach(({ index }) => yEdges.delete(index, 1));

			// Add new edges and update existing ones
			edges.forEach(edge => {
				const existingIndex = existingEdges.findIndex(e => e.id === edge.id);
				switch (existingIndex) {
					case -1: // New edge
						yEdges.push([edge]);
						break;
					default: // Update existing edge
						yEdges.delete(existingIndex, 1);
						yEdges.insert(existingIndex, [edge]);
						break;
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
