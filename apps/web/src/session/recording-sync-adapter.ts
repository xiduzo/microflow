import * as Y from "yjs";
import type { FlowDocument } from "@microflow/collab";
import type {
  AwarenessUser,
  RemoteSyncAdapter,
  SyncAdapterEvents,
  SyncState,
} from "./sync-adapter";

export type RecordingSyncAdapterOptions = {
  doc: FlowDocument;
  user: { id: string; name: string; color?: string; icon?: string; isSupporter?: boolean };
  initialState?: SyncState;
};

export class RecordingSyncAdapter implements RemoteSyncAdapter {
  readonly kind = "remote" as const;

  readonly appliedUpdates: Uint8Array[] = [];
  readonly awarenessUpdates: { kind: "cursor" | "selection"; payload: unknown }[] = [];
  connectCalls = 0;
  disconnectCalls = 0;
  destroyed = false;

  private _state: SyncState;
  private _users: AwarenessUser[] = [];
  private _localUser: AwarenessUser;
  private _error: Error | null = null;
  private readonly listeners = new Map<keyof SyncAdapterEvents, Set<Function>>();
  private readonly unobserve: () => void;

  constructor(private readonly options: RecordingSyncAdapterOptions) {
    this._state = options.initialState ?? "synced";
    this._localUser = {
      id: options.user.id,
      name: options.user.name,
      color: options.user.color ?? "#000000",
      icon: options.user.icon ?? "Cat",
      isSupporter: options.user.isSupporter ?? false,
      clientId: options.doc.doc.clientID,
    };
    this._users = [this._localUser];

    this.unobserve = options.doc.onAnyChange((update, origin) => {
      if (origin === "remote") return;
      this.appliedUpdates.push(update);
    });
  }

  get state(): SyncState {
    return this._state;
  }

  get isSynced(): boolean {
    return this._state === "synced";
  }

  get users(): AwarenessUser[] {
    return this._users;
  }

  get localUser(): AwarenessUser | null {
    return this._localUser;
  }

  get error(): Error | null {
    return this._error;
  }

  updateCursor(cursor: { x: number; y: number }): void {
    this.awarenessUpdates.push({ kind: "cursor", payload: cursor });
    this._localUser = { ...this._localUser, cursor };
  }

  updateSelectedNodes(nodeIds: string[]): void {
    this.awarenessUpdates.push({ kind: "selection", payload: nodeIds });
    this._localUser = { ...this._localUser, selectedNodes: nodeIds };
  }

  reconnect(): void {
    this.connectCalls++;
    this.setState("connecting");
  }

  disconnect(): void {
    this.disconnectCalls++;
    this.setState("disconnected");
  }

  on<K extends keyof SyncAdapterEvents>(event: K, cb: SyncAdapterEvents[K]): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
    return () => {
      this.listeners.get(event)?.delete(cb);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unobserve();
    this.listeners.clear();
  }

  // ----- Script (test-only) -----

  /** Apply a remote update to the doc — simulates collaborator's edit arriving. */
  injectRemoteUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.options.doc.doc, update, "remote");
  }

  injectAwareness(users: AwarenessUser[]): void {
    this._users = users;
    this.emit("awareness", users);
  }

  injectState(state: SyncState): void {
    this.setState(state);
    if (state === "synced") this.emit("synced");
  }

  injectError(err: Error): void {
    this._error = err;
    this.emit("error", err);
  }

  private setState(state: SyncState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit("state", state);
  }

  private emit<K extends keyof SyncAdapterEvents>(
    event: K,
    ...args: Parameters<SyncAdapterEvents[K]>
  ): void {
    this.listeners.get(event)?.forEach((cb) => (cb as Function)(...args));
  }
}
