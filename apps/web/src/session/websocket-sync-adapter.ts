import * as Y from "yjs";
import { FlowDocument, SyncProvider, type AwarenessUser, type SyncState } from "@microflow/collab";
import type { RemoteSyncAdapter, SyncAdapterEvents } from "./sync-adapter";

export type WebSocketSyncAdapterOptions = {
  doc: FlowDocument;
  flowId: string;
  wsUrl: string;
  user: { id: string; name: string; color?: string; icon?: string; isSupporter?: boolean };
  authToken?: string;
  initialData?: Uint8Array;
};

export class WebSocketSyncAdapter implements RemoteSyncAdapter {
  readonly kind = "remote" as const;
  private readonly provider: SyncProvider;
  private currentUsers: AwarenessUser[] = [];
  private currentError: Error | null = null;
  private destroyed = false;

  constructor(options: WebSocketSyncAdapterOptions) {
    const { doc, initialData, ...rest } = options;
    if (initialData) {
      Y.applyUpdate(doc.doc, initialData);
      doc.clearHistory();
    }
    this.provider = new SyncProvider({ doc: doc.doc, ...rest });
    this.provider.on("awarenessChange", () => {
      this.currentUsers = this.readUsers();
    });
    this.provider.on("error", (err) => {
      this.currentError = err;
    });
    this.provider.on("synced", () => {
      this.currentError = null;
    });
    this.currentUsers = this.readUsers();
  }

  private readUsers(): AwarenessUser[] {
    return Array.from(this.provider.getAwarenessUsers().values());
  }

  get state(): SyncState {
    return this.provider.state;
  }

  get isSynced(): boolean {
    return this.provider.state === "synced";
  }

  get users(): AwarenessUser[] {
    return this.currentUsers;
  }

  get localUser(): AwarenessUser | null {
    return this.provider.localUser;
  }

  get error(): Error | null {
    return this.currentError;
  }

  updateCursor(cursor: { x: number; y: number }): void {
    this.provider.updateCursor(cursor);
  }

  updateSelectedNodes(nodeIds: string[]): void {
    this.provider.updateSelectedNodes(nodeIds);
  }

  reconnect(): void {
    this.provider.disconnect();
    this.provider.connect();
  }

  disconnect(): void {
    this.provider.disconnect();
  }

  on<K extends keyof SyncAdapterEvents>(event: K, cb: SyncAdapterEvents[K]): () => void {
    switch (event) {
      case "state":
        return this.provider.on("stateChange", cb as SyncAdapterEvents["state"]);
      case "awareness":
        return this.provider.on("awarenessChange", (users) => {
          (cb as SyncAdapterEvents["awareness"])(Array.from(users.values()));
        });
      case "synced":
        return this.provider.on("synced", cb as SyncAdapterEvents["synced"]);
      case "error":
        return this.provider.on("error", cb as SyncAdapterEvents["error"]);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.provider.destroy();
  }
}
