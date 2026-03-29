import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// ============================================================================
// Constants
// ============================================================================

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_ACK = 2;

export const COLLAB_COLORS = [
  "#b91c1c", // red-700
  "#c2410c", // orange-700
  "#b45309", // amber-700
  "#a16207", // yellow-700
  "#4d7c0f", // lime-700
  "#15803d", // green-700
  "#047857", // emerald-700
  "#0f766e", // teal-700
  "#0e7490", // cyan-700
  "#0369a1", // sky-700
  "#1d4ed8", // blue-700
  "#4338ca", // indigo-700
  "#6d28d9", // violet-700
  "#7e22ce", // purple-700
  "#a21caf", // fuchsia-700
  "#be185d", // pink-700
  "#be123c", // rose-700
];

// ============================================================================
// Types
// ============================================================================

export type SyncState = "disconnected" | "connecting" | "syncing" | "synced";

export type AwarenessUser = {
  id: string;
  name: string;
  color: string;
  icon: string;
  cursor?: { x: number; y: number };
  selectedNodes?: string[];
  /** Yjs client ID — unique per connection, not per account */
  clientId?: number;
};

export type SyncProviderEvents = {
  stateChange: (state: SyncState) => void;
  awarenessChange: (users: Map<number, AwarenessUser>) => void;
  synced: () => void;
  error: (error: Error) => void;
  ack: (version: number) => void;
};

export type SyncProviderOptions = {
  flowId: string;
  doc: Y.Doc;
  wsUrl: string;
  user: {
    id: string;
    name: string;
    color?: string;
    icon?: string;
  };
  /** Bearer token for auth (used in Tauri where cookies aren't available) */
  authToken?: string;
};

// ============================================================================
// SyncProvider - Handles WebSocket sync and offline queuing
// ============================================================================

export class SyncProvider {
  private doc: Y.Doc;
  private ws: WebSocket | null = null;
  private awareness: awarenessProtocol.Awareness;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private pendingUpdates: Uint8Array[] = [];
  private listeners = new Map<keyof SyncProviderEvents, Set<Function>>();
  private destroyed = false;

  state: SyncState = "disconnected";
  readonly flowId: string;
  readonly wsUrl: string;
  readonly localUser: AwarenessUser;
  private authToken?: string;

  constructor(options: SyncProviderOptions) {
    this.doc = options.doc;
    this.flowId = options.flowId;
    this.wsUrl = options.wsUrl;
    this.authToken = options.authToken;
    this.localUser = {
      id: options.user.id,
      name: options.user.name,
      color:
        options.user.color ??
        COLLAB_COLORS[Math.floor(Math.random() * COLLAB_COLORS.length)]!,
      icon: options.user.icon ?? "Cat",
    };

    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.localUser.clientId = this.doc.clientID;
    this.awareness.setLocalStateField("user", this.localUser);

    // Listen for awareness changes
    this.awareness.on("change", this.handleAwarenessChange);

    // Queue local updates
    this.doc.on("update", this.handleLocalUpdate);

    // Connect
    this.connect();
  }

  // --------------------------------------------------------------------------
  // Event Emitter
  // --------------------------------------------------------------------------

  on<K extends keyof SyncProviderEvents>(
    event: K,
    callback: SyncProviderEvents[K]
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    return () => this.off(event, callback);
  }

  off<K extends keyof SyncProviderEvents>(
    event: K,
    callback: SyncProviderEvents[K]
  ): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit<K extends keyof SyncProviderEvents>(
    event: K,
    ...args: Parameters<SyncProviderEvents[K]>
  ): void {
    this.listeners.get(event)?.forEach((cb) => (cb as Function)(...args));
  }

  // --------------------------------------------------------------------------
  // Connection Management
  // --------------------------------------------------------------------------

  connect(): void {
    if (this.destroyed) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.setState("connecting");

    let url = `${this.wsUrl}/yjs/${this.flowId}`;
    if (this.authToken) {
      url += `?token=${encodeURIComponent(this.authToken)}`;
    }
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setState("syncing");

      // Send sync step 1
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.ws!.send(encoding.toUint8Array(encoder));

      // Send awareness
      this.sendAwareness();

      // Flush pending updates
      this.flushPendingUpdates();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(new Uint8Array(event.data));
    };

    this.ws.onclose = () => {
      this.setState("disconnected");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.emit("error", new Error("WebSocket connection failed"));
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      console.log(`[SYNC] Disconnecting from flow ${this.flowId}`);
      this.ws.close();
      this.ws = null;
    }
    this.setState("disconnected");
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit("error", new Error("Max reconnection attempts reached"));
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  // --------------------------------------------------------------------------
  // Message Handling
  // --------------------------------------------------------------------------

  private handleMessage = (data: Uint8Array): void => {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC:
        this.handleSyncMessage(decoder);
        break;
      case MESSAGE_AWARENESS:
        this.handleAwarenessMessage(decoder);
        break;
      case MESSAGE_ACK:
        this.handleAckMessage(decoder);
        break;
    }
  };

  private handleSyncMessage(decoder: decoding.Decoder): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);

    const syncMessageType = syncProtocol.readSyncMessage(
      decoder,
      encoder,
      this.doc,
      "remote"
    );

    // Send response if needed (sync step 2)
    if (
      encoding.length(encoder) > 1 &&
      this.ws?.readyState === WebSocket.OPEN
    ) {
      this.ws.send(encoding.toUint8Array(encoder));
    }

    // After receiving sync step 2, we're synced
    if (syncMessageType === syncProtocol.messageYjsSyncStep2) {
      this.setState("synced");
      this.emit("synced");
    }
  }

  private handleAwarenessMessage(decoder: decoding.Decoder): void {
    awarenessProtocol.applyAwarenessUpdate(
      this.awareness,
      decoding.readVarUint8Array(decoder),
      "remote"
    );
  }

  private handleAckMessage(decoder: decoding.Decoder): void {
    const version = decoding.readVarUint(decoder);
    this.emit("ack", version);
  }

  // --------------------------------------------------------------------------
  // Local Update Handling
  // --------------------------------------------------------------------------

  private handleLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    // Don't send back remote updates
    if (origin === "remote") return;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendUpdate(update);
    } else {
      // Queue for later
      this.pendingUpdates.push(update);
    }
  };

  private sendUpdate(update: Uint8Array): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.ws?.send(encoding.toUint8Array(encoder));
  }

  private flushPendingUpdates(): void {
    while (this.pendingUpdates.length > 0) {
      const update = this.pendingUpdates.shift()!;
      this.sendUpdate(update);
    }
  }

  // --------------------------------------------------------------------------
  // Awareness
  // --------------------------------------------------------------------------

  private handleAwarenessChange = (): void => {
    const users = this.getAwarenessUsers();
    this.emit("awarenessChange", users);
  };

  private sendAwareness(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
        this.doc.clientID,
      ])
    );
    this.ws.send(encoding.toUint8Array(encoder));
  }

  updateCursor(cursor: { x: number; y: number }): void {
    this.localUser.cursor = cursor;
    this.awareness.setLocalStateField("user", {
      ...this.localUser,
    });
    this.sendAwareness();
  }

  updateSelectedNodes(nodeIds: string[]): void {
    this.localUser.selectedNodes = nodeIds;
    this.awareness.setLocalStateField("user", {
      ...this.localUser,
    });
    this.sendAwareness();
  }

  getAwarenessUsers(): Map<number, AwarenessUser> {
    const users = new Map<number, AwarenessUser>();
    this.awareness.getStates().forEach((state, clientId) => {
      if (state.user) {
        users.set(clientId, { ...state.user as AwarenessUser, clientId });
      }
    });
    return users;
  }

  getOtherUsers(): AwarenessUser[] {
    const users: AwarenessUser[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (state.user && clientId !== this.doc.clientID) {
        users.push(state.user as AwarenessUser);
      }
    });
    return users;
  }

  // --------------------------------------------------------------------------
  // State Management
  // --------------------------------------------------------------------------

  private setState(state: SyncState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit("stateChange", state);
    }
  }

  isConnected(): boolean {
    return this.state === "synced" || this.state === "syncing";
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  destroy(): void {
    console.log(`[SYNC] Destroying sync provider for flow ${this.flowId}`);
    this.destroyed = true;
    this.disconnect();
    this.doc.off("update", this.handleLocalUpdate);
    this.awareness.off("change", this.handleAwarenessChange);
    this.awareness.destroy();
    this.listeners.clear();
    this.pendingUpdates = [];
  }
}
