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
  /**
   * Live positions of the nodes this user is dragging right now, keyed by
   * node id. Carried on awareness rather than in the document: a drag is
   * ephemeral by nature, and routing sixty positions a second through the
   * CRDT would bloat the update history and flood the undo stack. Absent when
   * the user is not dragging.
   */
  draggingNodes?: Record<string, { x: number; y: number }>;
  /** Yjs client ID — unique per connection, not per account */
  clientId?: number;
  isSupporter?: boolean;
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
    isSupporter?: boolean;
  };
  /** Bearer token for auth (used in Tauri where cookies aren't available) */
  authToken?: string;
  /**
   * Minimum gap between cursor broadcasts, in milliseconds.
   *
   * Pointer events fire far faster than anyone can perceive, and every one of
   * them costs a frame on the wire *per peer in the room* — cursor traffic is
   * the one thing here that grows with the square of the group. Coalescing to
   * roughly one frame per rendered frame keeps motion smooth while cutting
   * sends by an order of magnitude. Trailing, never dropping the last
   * position, so the cursor always settles where the mouse stopped.
   */
  cursorThrottleMs?: number;
  /**
   * Cap on the offline update queue, in bytes. Past it the queue is discarded
   * and the client relies on sync-step-1 to reconcile on reconnect — which is
   * exactly what a CRDT is for, and costs one round trip instead of unbounded
   * memory.
   */
  maxPendingBytes?: number;
};

const DEFAULT_CURSOR_THROTTLE_MS = 50;
const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;

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
  private pendingBytes = 0;
  private listeners = new Map<keyof SyncProviderEvents, Set<Function>>();
  private destroyed = false;

  /** Latest cursor position not yet broadcast, and the timer that will. */
  private pendingCursor: { x: number; y: number } | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCursorSentAt = 0;

  /** Latest drag positions not yet broadcast. Boxed so `undefined` (drop) is
   *  distinguishable from "nothing pending". */
  private pendingDrag: { value: Record<string, { x: number; y: number }> | undefined } | null =
    null;
  private dragTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDragSentAt = 0;
  private readonly cursorThrottleMs: number;
  private readonly maxPendingBytes: number;

  /** Cached view of `awareness.getStates()`, rebuilt only when it changes. */
  private usersCache: Map<number, AwarenessUser> | null = null;

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
    this.cursorThrottleMs = options.cursorThrottleMs ?? DEFAULT_CURSOR_THROTTLE_MS;
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.localUser = {
      id: options.user.id,
      name: options.user.name,
      color:
        options.user.color ??
        COLLAB_COLORS[Math.floor(Math.random() * COLLAB_COLORS.length)]!,
      icon: options.user.icon ?? "Cat",
      isSupporter: options.user.isSupporter ?? false,
    };

    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.localUser.clientId = this.doc.clientID;
    this.awareness.setLocalStateField("user", this.localUser);

    // Listen for awareness changes
    this.awareness.on("change", this.handleAwarenessChange);

    // Queue local updates
    this.doc.on("update", this.handleLocalUpdate);

    // Recover from a dead connection on real evidence, not just the timer.
    this.addRecoveryListeners();

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
      // The peers we knew about are only known to be present via this socket.
      this.clearRemotePresence();
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
      // Drop the handlers before closing: `onclose` would otherwise schedule a
      // reconnect for a disconnect we asked for.
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.clearRemotePresence();
    this.setState("disconnected");
  }

  /**
   * Forget every other client's presence.
   *
   * Awareness state is not self-expiring on our side, so without this a
   * dropped connection leaves the peers who were online at that moment
   * painted on the canvas indefinitely — cursors that will never move again.
   */
  private clearRemotePresence(): void {
    const stale = Array.from(this.awareness.getStates().keys()).filter(
      (clientId) => clientId !== this.doc.clientID,
    );
    if (stale.length === 0) return;
    awarenessProtocol.removeAwarenessStates(this.awareness, stale, "local");
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      // Not permanent: `handleOnline` / `handleVisible` reset the counter and
      // retry, so a laptop reopened after lunch reconnects instead of sitting
      // there looking connected.
      this.emit("error", new Error("Max reconnection attempts reached"));
      return;
    }

    // Jittered backoff. A deterministic delay means every client dropped by
    // one server restart comes back in lockstep — a thundering herd exactly
    // proportional to how many people were in the room.
    const base = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    const delay = Math.round(base * (0.5 + Math.random()));
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * The browser says we have a network again, or the tab came back to the
   * foreground. Either is far better evidence than our backoff timer, so
   * reset the attempt counter and retry now.
   */
  private handleOnline = (): void => {
    if (this.destroyed) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  };

  private handleVisibilityChange = (): void => {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    this.handleOnline();
  };

  private addRecoveryListeners(): void {
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.handleOnline);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
    }
  }

  private removeRecoveryListeners(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleOnline);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
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
      return;
    }

    // Offline: hold the update, but never without bound. A long editing
    // session behind a dead connection would otherwise grow this array until
    // the tab dies, then dump every frame at once on reconnect.
    this.pendingUpdates.push(update);
    this.pendingBytes += update.byteLength;

    if (this.pendingBytes > this.maxPendingBytes) {
      console.warn(
        `[SYNC] Offline queue over ${this.maxPendingBytes}B for flow ${this.flowId}; dropping it and relying on resync`,
      );
      this.pendingUpdates = [];
      this.pendingBytes = 0;
    }
  };

  private sendUpdate(update: Uint8Array): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.ws?.send(encoding.toUint8Array(encoder));
  }

  /**
   * Send everything queued while offline as a single update.
   *
   * `Y.mergeUpdates` collapses the queue losslessly, so a long offline session
   * costs one frame on reconnect rather than one per edit — which matters most
   * when a whole group reconnects together after a server restart.
   */
  private flushPendingUpdates(): void {
    if (this.pendingUpdates.length === 0) return;

    const queued = this.pendingUpdates;
    this.pendingUpdates = [];
    this.pendingBytes = 0;

    try {
      this.sendUpdate(queued.length === 1 ? queued[0]! : Y.mergeUpdates(queued));
    } catch (error) {
      // Merging is a pure function of well-formed updates, but a failure here
      // must not strand the queue: fall back to sending them individually.
      console.error("[SYNC] Failed to merge pending updates; sending separately", error);
      for (const update of queued) this.sendUpdate(update);
    }
  }

  // --------------------------------------------------------------------------
  // Awareness
  // --------------------------------------------------------------------------

  /**
   * Rebuild the cached user view and notify listeners.
   *
   * A change that only touches our own client is swallowed: the local cursor
   * is never rendered (`useCollabPresence` filters it out) and the local
   * identity fields are fixed at construction, so emitting would re-render
   * the whole canvas 20 times a second for a cursor nobody draws.
   */
  private handleAwarenessChange = (changes?: {
    added: number[];
    updated: number[];
    removed: number[];
  }): void => {
    this.usersCache = null;

    if (changes) {
      const touched = [...changes.added, ...changes.updated, ...changes.removed];
      if (touched.length > 0 && touched.every((id) => id === this.doc.clientID)) return;
    }

    this.emit("awarenessChange", this.getAwarenessUsers());
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

  /**
   * Publish the local cursor, coalesced to at most one frame per
   * `cursorThrottleMs`.
   *
   * Called from `onMouseMove`, so it runs at pointer-event rate — a hundred
   * or more times a second — and every send is fanned out to every other peer
   * in the room. Coordinates are rounded to whole flow units: it trims the
   * JSON the awareness protocol re-encodes on every update, and it makes the
   * "did it actually move?" check below meaningful instead of firing on
   * sub-pixel jitter.
   */
  updateCursor(cursor: { x: number; y: number }): void {
    if (this.destroyed) return;

    const next = { x: Math.round(cursor.x), y: Math.round(cursor.y) };
    const current = this.localUser.cursor;
    if (current && current.x === next.x && current.y === next.y) return;

    this.pendingCursor = next;

    if (this.cursorTimer !== null) return;

    const elapsed = Date.now() - this.lastCursorSentAt;
    if (elapsed >= this.cursorThrottleMs) {
      this.flushCursor();
      return;
    }

    // Trailing edge: the final position of a gesture is the one that matters,
    // so it is always sent, just late.
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      this.flushCursor();
    }, this.cursorThrottleMs - elapsed);
  }

  private flushCursor(): void {
    const cursor = this.pendingCursor;
    this.pendingCursor = null;
    if (!cursor || this.destroyed) return;

    this.lastCursorSentAt = Date.now();
    this.localUser.cursor = cursor;
    this.awareness.setLocalStateField("user", { ...this.localUser });
    this.sendAwareness();
  }

  /**
   * Publish the positions of the nodes being dragged, or `null` on drop.
   *
   * Shares the cursor's throttle budget and its trailing guarantee, so peers
   * see the drag move continuously and always land on the final position.
   * The document write still happens once, on drop, via the bridge.
   */
  updateDraggedNodes(positions: Record<string, { x: number; y: number }> | null): void {
    if (this.destroyed) return;

    const next = positions ?? undefined;
    if (next === undefined && this.localUser.draggingNodes === undefined) return;

    this.pendingDrag = { value: next };

    if (this.dragTimer !== null) return;

    const elapsed = Date.now() - this.lastDragSentAt;
    if (elapsed >= this.cursorThrottleMs) {
      this.flushDrag();
      return;
    }
    this.dragTimer = setTimeout(() => {
      this.dragTimer = null;
      this.flushDrag();
    }, this.cursorThrottleMs - elapsed);
  }

  private flushDrag(): void {
    const pending = this.pendingDrag;
    this.pendingDrag = null;
    if (!pending || this.destroyed) return;

    this.lastDragSentAt = Date.now();
    this.localUser.draggingNodes = pending.value;
    this.awareness.setLocalStateField("user", { ...this.localUser });
    this.sendAwareness();
  }

  updateSelectedNodes(nodeIds: string[]): void {
    if (this.destroyed) return;
    const current = this.localUser.selectedNodes;
    // Selection changes are user-paced, so an equality check is enough to stop
    // the repeat writes that ReactFlow emits around a single click.
    if (
      current &&
      current.length === nodeIds.length &&
      current.every((id, i) => id === nodeIds[i])
    ) {
      return;
    }

    this.localUser.selectedNodes = nodeIds;
    this.awareness.setLocalStateField("user", {
      ...this.localUser,
    });
    this.sendAwareness();
  }

  /**
   * The room's presence, keyed by Yjs client id.
   *
   * Cached and invalidated on awareness change: at cursor rate this is one of
   * the hottest reads in the editor, and rebuilding the map (plus cloning
   * every user object) on each call was pure garbage.
   */
  getAwarenessUsers(): Map<number, AwarenessUser> {
    if (this.usersCache) return this.usersCache;

    const users = new Map<number, AwarenessUser>();
    this.awareness.getStates().forEach((state, clientId) => {
      if (state.user) {
        users.set(clientId, { ...state.user as AwarenessUser, clientId });
      }
    });
    this.usersCache = users;
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
    if (this.cursorTimer !== null) {
      clearTimeout(this.cursorTimer);
      this.cursorTimer = null;
    }
    if (this.dragTimer !== null) {
      clearTimeout(this.dragTimer);
      this.dragTimer = null;
    }
    this.pendingCursor = null;
    this.pendingDrag = null;
    this.removeRecoveryListeners();
    this.disconnect();
    this.doc.off("update", this.handleLocalUpdate);
    this.awareness.off("change", this.handleAwarenessChange);
    this.awareness.destroy();
    this.listeners.clear();
    this.pendingUpdates = [];
    this.pendingBytes = 0;
    this.usersCache = null;
  }
}
