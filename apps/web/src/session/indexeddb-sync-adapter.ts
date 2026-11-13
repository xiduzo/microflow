import { IndexeddbPersistence } from "y-indexeddb";
import { upgradeLegacyNodes, type FlowDocument } from "@microflow/collab";
import { reportError } from "@/lib/report-error";
import type { SyncAdapter } from "./sync-adapter";

/** Why the local flow could not be loaded from IndexedDB. */
export type LocalPersistenceFailure = "open-failed" | "timeout" | "destroyed";

/**
 * The local flow's store could not be loaded. The message is written for the
 * user (it is shown as-is) and carries no flow content.
 */
export class LocalPersistenceError extends Error {
  override readonly name = "LocalPersistenceError";

  constructor(
    readonly reason: LocalPersistenceFailure,
    options?: { cause?: unknown },
  ) {
    super(MESSAGES[reason], options);
  }
}

const MESSAGES: Record<LocalPersistenceFailure, string> = {
  "open-failed":
    "This browser would not open local storage (IndexedDB) for your flow. Private browsing or blocked site data can cause this.",
  timeout:
    "Local storage (IndexedDB) did not finish loading your flow. Another tab may be holding it open; close other microflow tabs and reload.",
  destroyed: "The local flow was closed before it finished loading.",
};

/** Long enough for a large flow on a slow disk; short enough that a stuck open is not an endless spinner. */
export const DEFAULT_SYNC_TIMEOUT_MS = 15_000;

export type IndexeddbSyncAdapterOptions = {
  /** How long `whenSynced` waits for the stored document before rejecting with `timeout`. */
  syncTimeoutMs?: number;
};

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
 *
 * `whenSynced` always settles: it resolves once the stored document is loaded
 * into `doc`, and rejects with a `LocalPersistenceError` when the database
 * cannot be opened, when loading outlasts `syncTimeoutMs`, or when the adapter
 * is destroyed first. `y-indexeddb` itself only ever emits `synced`, so
 * without this a failed open left every awaiting caller waiting forever.
 */
export class IndexeddbSyncAdapter implements SyncAdapter {
  readonly kind = "local" as const;
  /** Attached once IndexedDB has proven it can open; `null` before that or when it cannot. */
  private persistence: IndexeddbPersistence | null = null;
  private destroyed = false;
  private failure: LocalPersistenceError | null = null;
  private settle: ((failure: LocalPersistenceError | null) => void) | null = null;

  /** Resolves once the stored document has been loaded into `doc`; rejects with a `LocalPersistenceError`. */
  readonly whenSynced: Promise<void>;

  constructor(
    private readonly doc: FlowDocument,
    private readonly storageName = "microflow-local-flow",
    options: IndexeddbSyncAdapterOptions = {},
  ) {
    this.whenSynced = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.settle?.(new LocalPersistenceError("timeout")),
        options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS,
      );
      this.settle = (failure) => {
        this.settle = null;
        clearTimeout(timer);
        if (failure) {
          this.failure = failure;
          reject(failure);
        } else {
          resolve();
        }
      };
    });

    // `y-indexeddb` chains `.then` on its open promise without a catch and
    // only ever emits `synced`: a failed open is an unhandled rejection plus
    // a `whenSynced` that never settles. Probing first turns the common
    // failures (no IndexedDB, private mode, blocked site data) into a clean
    // rejection before the library is involved.
    probeIndexedDb().then(
      () => this.attach(),
      (cause: unknown) => this.settle?.(new LocalPersistenceError("open-failed", { cause })),
    );

    this.whenSynced.catch((error: unknown) => {
      // Learn about real failures even when no caller awaits `whenSynced`
      // (the editor mounts the local session without waiting on it).
      if (error instanceof LocalPersistenceError && error.reason === "destroyed") return;
      reportError(error, { source: "local-persistence" });
    });
  }

  /** The load failure, once `whenSynced` has rejected; `null` while loading or after a successful load. */
  get error(): LocalPersistenceError | null {
    return this.failure;
  }

  /**
   * Hand the doc to `y-indexeddb`. Edits made before this point are not lost:
   * on load the library first stores the doc's full current state, then
   * applies the stored updates on top.
   */
  private attach(): void {
    if (this.destroyed || this.settle === null) return;
    const persistence = new IndexeddbPersistence(this.storageName, this.doc.doc);
    this.persistence = persistence;

    persistence.once("synced", () => {
      // The load boundary, same as the server's room store: a document
      // stored before ADR-0019 is brought onto the nested node shape here,
      // so nothing downstream needs a compatibility branch.
      if (!this.destroyed) upgradeLegacyNodes(this.doc.doc);
      this.settle?.(null);
    });

    // The probe passed but this store can still fail to open (a newer schema
    // version, a corrupt store). Settle on it; the library's own unhandled
    // rejection carries the same cause, which `reportError` then skips.
    persistence._db.catch((cause: unknown) => {
      this.settle?.(new LocalPersistenceError("open-failed", { cause }));
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.settle?.(new LocalPersistenceError("destroyed"));
    // Detaches the doc observer and closes the database handle. Updates
    // already applied are durable; there is no final flush to wait on.
    this.persistence?.destroy().catch(() => {
      // The open failed, so there is no handle to close; already reported.
    });
  }
}

/** A throwaway database: opening it proves IndexedDB works here without touching any flow store. */
const PROBE_DB = "microflow-idb-probe";

/**
 * Resolves when this origin can open an IndexedDB database; rejects with the
 * browser's error otherwise. A blocked open stays pending, which the
 * adapter's timeout turns into a `timeout` failure.
 */
function probeIndexedDb(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      const request = indexedDB.open(PROBE_DB);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    } catch (error) {
      // No `indexedDB` global, or a SecurityError thrown synchronously.
      reject(error);
    }
  });
}
