import type { FlowDocument } from "@microflow/collab";
import type { SyncAdapter } from "./sync-adapter";

const LOCAL_FLOW_STORAGE_KEY = "microflow-local-flow";

type StoredPayload = {
  nodes: ReturnType<FlowDocument["getNodes"]>;
  edges: ReturnType<FlowDocument["getEdges"]>;
};

function loadStored(): StoredPayload {
  try {
    const stored = localStorage.getItem(LOCAL_FLOW_STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored) as Partial<StoredPayload>;
      return { nodes: data.nodes ?? [], edges: data.edges ?? [] };
    }
  } catch (e) {
    console.error("[LOCAL-SYNC] Failed to load local flow:", e);
  }
  return { nodes: [], edges: [] };
}

function saveStored(payload: StoredPayload): void {
  try {
    localStorage.setItem(LOCAL_FLOW_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error("[LOCAL-SYNC] Failed to save local flow:", e);
  }
}

export class LocalStorageSyncAdapter implements SyncAdapter {
  readonly kind = "local" as const;
  private unobserve: (() => void) | null = null;
  private destroyed = false;

  constructor(private readonly doc: FlowDocument) {
    const stored = loadStored();
    if (stored.nodes.length > 0 || stored.edges.length > 0) {
      doc.setFlowData(stored.nodes, stored.edges);
      doc.clearHistory();
    }
    this.unobserve = doc.onAnyChange(() => {
      if (this.destroyed) return;
      saveStored({ nodes: doc.getNodes(), edges: doc.getEdges() });
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unobserve?.();
    this.unobserve = null;
    saveStored({ nodes: this.doc.getNodes(), edges: this.doc.getEdges() });
  }
}
