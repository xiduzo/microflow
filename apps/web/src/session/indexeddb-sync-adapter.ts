import { IndexeddbPersistence } from "y-indexeddb";
import type { FlowDocument } from "@microflow/collab";
import type { SyncAdapter } from "./sync-adapter";

/** The key the previous `localStorage`-backed adapter wrote to. */
const LEGACY_STORAGE_KEY = "microflow-local-flow";

type LegacyPayload = {
  nodes: ReturnType<FlowDocument["getNodes"]>;
  edges: ReturnType<FlowDocument["getEdges"]>;
};

/**
 * Read the flow the old adapter left behind, if any.
 *
 * Deliberately does **not** delete the key. It costs a few KB and it is the
 * only copy of a local user's work; leaving it means a rollback to a previous
 * build still finds their flow.
 */
function readLegacyPayload(): LegacyPayload | null {
  try {
    const stored = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!stored) return null;
    const data = JSON.parse(stored) as Partial<LegacyPayload>;
    const nodes = data.nodes ?? [];
    const edges = data.edges ?? [];
    if (nodes.length === 0 && edges.length === 0) return null;
    return { nodes, edges };
  } catch (error) {
    console.error("[LOCAL-SYNC] Failed to read legacy local flow:", error);
    return null;
  }
}

/**
 * Local persistence for the offline/local flow, backed by `y-indexeddb`.
 *
 * Replaces a hand-rolled `localStorage` adapter that, on **every** document
 * change, serialised the whole flow to JSON and wrote it synchronously — on
 * each keystroke, on the main thread, growing with flow size.
 * `IndexeddbPersistence` stores Yjs updates incrementally instead: no JSON
 * round trip, no whole-document write, and the document's history survives a
 * reload rather than being flattened into a node/edge snapshot.
 *
 * The document name is the storage key, so distinct flows get distinct stores.
 */
export class IndexeddbSyncAdapter implements SyncAdapter {
  readonly kind = "local" as const;
  private readonly persistence: IndexeddbPersistence;
  private destroyed = false;

  /** Resolves once the stored document has been loaded into `doc`. */
  readonly whenSynced: Promise<void>;

  constructor(
    private readonly doc: FlowDocument,
    storageName = "microflow-local-flow",
  ) {
    this.persistence = new IndexeddbPersistence(storageName, doc.doc);

    this.whenSynced = new Promise<void>((resolve) => {
      this.persistence.once("synced", () => {
        this.migrateLegacyPayload();
        resolve();
      });
    });

    this.whenSynced.catch((error) => {
      console.error("[LOCAL-SYNC] IndexedDB persistence failed:", error);
    });
  }

  /**
   * One-time import of the pre-IndexedDB flow.
   *
   * Only runs when IndexedDB came back empty — otherwise the stored document
   * is authoritative and re-seeding would clobber newer work with a stale
   * snapshot. `clearHistory` keeps the import off the undo stack, so a user's
   * first ctrl-Z after upgrading does not erase their flow.
   */
  private migrateLegacyPayload(): void {
    if (this.destroyed) return;
    if (this.doc.getNodeIds().length > 0 || this.doc.getEdgeIds().length > 0) return;

    const legacy = readLegacyPayload();
    if (!legacy) return;

    console.log("[LOCAL-SYNC] Importing local flow from the previous storage format");
    this.doc.setFlowData(legacy.nodes, legacy.edges);
    this.doc.clearHistory();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Detaches the doc observer and closes the database handle. Updates
    // already applied are durable; there is no final flush to wait on.
    void this.persistence.destroy();
  }
}
