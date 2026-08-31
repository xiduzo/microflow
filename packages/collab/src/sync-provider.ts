import type * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as decoding from "lib0/decoding";
import { WebsocketProvider } from "y-websocket";
import { MESSAGE_ACK } from "./protocol";

// ============================================================================
// Constants
// ============================================================================

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
  isSupporter?: boolean;
  /**
   * Live positions of the nodes this user is dragging right now, keyed by
   * node id. Carried on awareness rather than in the document: a drag is
   * ephemeral by nature, and routing sixty positions a second through the
   * CRDT would bloat the update history and flood the undo stack. Absent when
   * the user is not dragging.
   */
  draggingNodes?: Record<string, { x: number; y: number }>;
};

export type SyncProviderEvents = {
  stateChange: (state: SyncState) => void;
  awarenessChange: (users: Map<number, AwarenessUser>) => void;
  synced: () => void;
  error: (error: Error) => void;
  ack: (version: number) => void;
  /** Access was denied or revoked; the transport will not retry. */
  accessDenied: (reason: string) => void;
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
   * Minimum gap between presence broadcasts, in milliseconds.
   *
   * Pointer events fire far faster than anyone can perceive, and every one of
   * them costs a frame on the wire *per peer in the room* — cursor traffic is
   * the one thing here that grows with the square of the group. Coalescing to
   * roughly one frame per rendered frame keeps motion smooth while cutting
   * sends by an order of magnitude. Trailing, never dropping the last
   * position, so the cursor always settles where the mouse stopped.
   *
   * This is ours to own: `y-websocket` broadcasts awareness on every local
   * change and has no notion of a presence budget.
   */
  cursorThrottleMs?: number;
  /** Injectable WebSocket implementation, for tests. */
  WebSocketPolyfill?: typeof WebSocket;
};

const DEFAULT_CURSOR_THROTTLE_MS = 50;

// ============================================================================
// SyncProvider
// ============================================================================

/**
 * The editor's presence and connection surface, over `y-websocket`.
 *
 * The transport itself — connecting, the sync handshake, exponential backoff,
 * reconnect, dropping remote presence when the socket dies, cross-tab
 * `BroadcastChannel` relay, and the "no message in 30s" watchdog — is
 * `WebsocketProvider`'s job. This class deliberately owns only what the
 * library does not:
 *
 * 1. **Presence throttling.** Cursor and drag positions are coalesced to one
 *    broadcast per `cursorThrottleMs`. `y-websocket` sends an awareness frame
 *    for every local change; at pointer rate, in a room, that is the dominant
 *    cost on the wire.
 * 2. **The local user record.** Identity, colour assignment, and the shape
 *    peers read.
 * 3. **A cached, app-shaped view of awareness**, so the React layer is not
 *    rebuilding a Map and cloning every user on each cursor tick.
 * 4. **The `ack` message** (`MESSAGE_ACK`), which is ours, not a Yjs protocol
 *    message — see `protocol.ts` for why its number matters.
 *
 * An earlier version of this class hand-rolled the transport too: ~250 lines
 * of reconnect, offline queuing and message dispatch that `y-websocket`
 * already does, and does better. Notably it queued updates while offline;
 * `y-websocket` simply resyncs on reconnect, which is the point of a CRDT and
 * cannot drift.
 */
export class SyncProvider {
  private readonly doc: Y.Doc;
  private readonly provider: WebsocketProvider;
  private readonly awareness: awarenessProtocol.Awareness;
  private listeners = new Map<keyof SyncProviderEvents, Set<Function>>();
  private destroyed = false;

  /** Latest presence not yet broadcast, and the timer that will. */
  private pendingCursor: { x: number; y: number } | null = null;
  private pendingDrag: { value: Record<string, { x: number; y: number }> | undefined } | null =
    null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPresenceSentAt = 0;
  private readonly cursorThrottleMs: number;

  /** Cached view of `awareness.getStates()`, rebuilt only when it changes. */
  private usersCache: Map<number, AwarenessUser> | null = null;

  state: SyncState = "connecting";
  readonly flowId: string;
  readonly wsUrl: string;
  readonly localUser: AwarenessUser;

  constructor(options: SyncProviderOptions) {
    this.doc = options.doc;
    this.flowId = options.flowId;
    this.wsUrl = options.wsUrl;
    this.cursorThrottleMs = options.cursorThrottleMs ?? DEFAULT_CURSOR_THROTTLE_MS;

    this.localUser = {
      id: options.user.id,
      name: options.user.name,
      color:
        options.user.color ??
        COLLAB_COLORS[Math.floor(Math.random() * COLLAB_COLORS.length)]!,
      icon: options.user.icon ?? "Cat",
      isSupporter: options.user.isSupporter ?? false,
      clientId: options.doc.clientID,
    };

    this.awareness = new awarenessProtocol.Awareness(options.doc);
    this.awareness.setLocalStateField("user", { ...this.localUser });

    this.provider = new WebsocketProvider(
      // `WebsocketProvider` builds `${serverUrl}/${roomname}` itself, so the
      // room path lives here and the flow id is the room name.
      `${options.wsUrl}/yjs`,
      options.flowId,
      options.doc,
      {
        awareness: this.awareness,
        params: options.authToken ? { token: options.authToken } : {},
        ...(options.WebSocketPolyfill ? { WebSocketPolyfill: options.WebSocketPolyfill } : {}),
      },
    );

    // Our own message type; the provider dispatches by number into this array.
    this.provider.messageHandlers[MESSAGE_ACK] = (_encoder, decoder) => {
      this.emit("ack", decoding.readVarUint(decoder));
    };

    this.provider.on("status", ({ status }: { status: string }) => {
      // "connected" means the socket is up; "synced" is a stronger claim that
      // the `sync` event below makes once step 2 has landed.
      if (status === "connected") this.setState("syncing");
      else if (status === "connecting") this.setState("connecting");
      else this.setState("disconnected");
    });

    this.provider.on("sync", (isSynced: boolean) => {
      if (!isSynced) return;
      this.setState("synced");
      this.emit("synced");
    });

    this.provider.on("connection-error", () => {
      this.emit("error", new Error("WebSocket connection failed"));
    });

    // 4400–4499: the server says retrying will not help. `y-websocket` has
    // already stopped reconnecting by the time this fires.
    this.provider.on("closed", ({ reason }: { code: number; reason: string }) => {
      this.emit("accessDenied", reason || "Access denied");
      this.emit("error", new Error(reason || "Access denied"));
    });

    this.awareness.on("change", this.handleAwarenessChange);
  }

  // --------------------------------------------------------------------------
  // Event Emitter
  // --------------------------------------------------------------------------

  on<K extends keyof SyncProviderEvents>(
    event: K,
    callback: SyncProviderEvents[K],
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    return () => this.off(event, callback);
  }

  off<K extends keyof SyncProviderEvents>(
    event: K,
    callback: SyncProviderEvents[K],
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
  // Connection
  // --------------------------------------------------------------------------

  connect(): void {
    if (this.destroyed) return;
    this.provider.connect();
  }

  disconnect(): void {
    this.provider.disconnect();
  }

  isConnected(): boolean {
    return this.state === "synced" || this.state === "syncing";
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
   * the whole canvas twenty times a second for a cursor nobody draws.
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

  /**
   * Publish the local cursor, coalesced to at most one broadcast per
   * `cursorThrottleMs`.
   *
   * Called from `onMouseMove`, so it runs at pointer-event rate — a hundred
   * or more times a second — and `y-websocket` turns every awareness change
   * into a frame that the server fans out to every other peer. Coordinates are
   * rounded to whole flow units: it trims the JSON the awareness protocol
   * re-encodes on every update, and it makes the "did it actually move?" check
   * below meaningful instead of firing on sub-pixel jitter.
   */
  updateCursor(cursor: { x: number; y: number }): void {
    if (this.destroyed) return;

    const next = { x: Math.round(cursor.x), y: Math.round(cursor.y) };
    const current = this.localUser.cursor;
    if (current && current.x === next.x && current.y === next.y) return;

    this.pendingCursor = next;
    this.schedulePresenceFlush();
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
    this.schedulePresenceFlush();
  }

  /**
   * Selection is user-paced rather than pointer-paced, so it is written
   * straight through — but repeat calls with an identical selection (which
   * ReactFlow emits around a single click) are dropped.
   */
  updateSelectedNodes(nodeIds: string[]): void {
    if (this.destroyed) return;
    const current = this.localUser.selectedNodes;
    if (
      current &&
      current.length === nodeIds.length &&
      current.every((id, i) => id === nodeIds[i])
    ) {
      return;
    }

    this.localUser.selectedNodes = nodeIds;
    this.writeLocalUser();
  }

  /** Leading-plus-trailing throttle shared by cursor and drag updates. */
  private schedulePresenceFlush(): void {
    if (this.presenceTimer !== null) return;

    const elapsed = Date.now() - this.lastPresenceSentAt;
    if (elapsed >= this.cursorThrottleMs) {
      this.flushPresence();
      return;
    }

    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.flushPresence();
    }, this.cursorThrottleMs - elapsed);
  }

  private flushPresence(): void {
    if (this.destroyed) return;

    const cursor = this.pendingCursor;
    const drag = this.pendingDrag;
    this.pendingCursor = null;
    this.pendingDrag = null;
    if (!cursor && !drag) return;

    this.lastPresenceSentAt = Date.now();
    if (cursor) this.localUser.cursor = cursor;
    if (drag) this.localUser.draggingNodes = drag.value;
    this.writeLocalUser();
  }

  /** One write to awareness; `y-websocket` turns it into one frame. */
  private writeLocalUser(): void {
    this.awareness.setLocalStateField("user", { ...this.localUser });
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
        users.set(clientId, { ...(state.user as AwarenessUser), clientId });
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
  // State
  // --------------------------------------------------------------------------

  private setState(state: SyncState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit("stateChange", state);
    }
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.presenceTimer !== null) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    this.pendingCursor = null;
    this.pendingDrag = null;

    this.awareness.off("change", this.handleAwarenessChange);
    // Tears down the socket, the watchdog and the BroadcastChannel, and
    // detaches the doc and awareness handlers it installed.
    this.provider.destroy();
    this.awareness.destroy();

    this.listeners.clear();
    this.usersCache = null;
  }
}
