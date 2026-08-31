import type { FlowDocument } from "@microflow/collab";
import type { SyncAdapter } from "./sync-adapter";

const LOCAL_FLOW_STORAGE_KEY = "microflow-local-flow";

/**
 * Upper bound on how often the whole flow is serialised to `localStorage`.
 * `setItem` is synchronous and main-thread blocking, so the write rate — not
 * the change rate — is what has to stay bounded.
 */
const WRITE_INTERVAL_MS = 500;

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

/**
 * Mirrors the document into `localStorage`, at most once per
 * `WRITE_INTERVAL_MS`. Leading-edge: the first change of a quiet period is
 * written immediately, further changes inside the window coalesce into one
 * trailing write. `destroy()` flushes synchronously, so an unload never loses
 * the tail of an edit burst.
 *
 * ponytail: whole-flow `JSON.stringify` per write — fine at flow sizes we
 * ship; a per-node delta store is the upgrade path if flows get big.
 */
export class LocalStorageSyncAdapter implements SyncAdapter {
  readonly kind = "local" as const;
  private unobserve: (() => void) | null = null;
  private destroyed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;

  constructor(private readonly doc: FlowDocument) {
    const stored = loadStored();
    if (stored.nodes.length > 0 || stored.edges.length > 0) {
      doc.setFlowData(stored.nodes, stored.edges);
      doc.clearHistory();
    }
    this.unobserve = doc.onAnyChange(() => {
      if (this.destroyed) return;
      this.schedule();
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unobserve?.();
    this.unobserve = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = false;
    this.save();
  }

  private schedule(): void {
    if (this.timer !== null) {
      this.pending = true;
      return;
    }
    this.save();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.destroyed || !this.pending) return;
      this.pending = false;
      this.schedule();
    }, WRITE_INTERVAL_MS);
  }

  private save(): void {
    saveStored({ nodes: this.doc.getNodes(), edges: this.doc.getEdges() });
  }
}
