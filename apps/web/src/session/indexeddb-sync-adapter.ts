import { IndexeddbPersistence } from "y-indexeddb";
import { upgradeLegacyNodes, type FlowDocument } from "@microflow/collab";
import type { SyncAdapter } from "./sync-adapter";

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
        // The load boundary, same as the server's room store: a document
        // stored before ADR-0017 is brought onto the nested node shape here,
        // so nothing downstream needs a compatibility branch.
        if (!this.destroyed) upgradeLegacyNodes(doc.doc);
        resolve();
      });
    });

    this.whenSynced.catch((error) => {
      console.error("[LOCAL-SYNC] IndexedDB persistence failed:", error);
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Detaches the doc observer and closes the database handle. Updates
    // already applied are durable; there is no final flush to wait on.
    void this.persistence.destroy();
  }
}
