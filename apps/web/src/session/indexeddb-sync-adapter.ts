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
 * Where loading the stored flow stands:
 * - `loading`: not confirmed yet, still within the timeout.
 * - `stalled`: the timeout passed and `whenSynced` rejected with `timeout`,
 *   but persistence keeps trying and moves to `synced` if the load completes.
 * - `synced`: the stored document is loaded and every edit is persisted.
 * - `failed`: IndexedDB could not be opened; edits are not persisted.
 */
export type LocalPersistenceState = "loading" | "stalled" | "synced" | "failed";

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
 * `whenSynced` always settles, so no caller waits forever (`y-indexeddb` only
 * ever emits `synced`). It resolves once the stored document is loaded into
 * `doc`, and rejects with a `LocalPersistenceError` when the database cannot
 * be opened, when loading outlasts `syncTimeoutMs`, or when the adapter is
 * destroyed first.
 *
 * A timeout means "not confirmed yet", not "give up": persistence still
 * attaches and syncs when IndexedDB answers late, and `state`/`error` then
 * move to `synced`/`null`. Only a confirmed failure is reported: an open that
 * fails, or a load still stalled when the adapter is destroyed.
 */
export class IndexeddbSyncAdapter implements SyncAdapter {
  readonly kind = "local" as const;
  /** Attached once IndexedDB has proven it can open; `null` before that or when it cannot. */
  private persistence: IndexeddbPersistence | null = null;
  private destroyed = false;
  private loadState: LocalPersistenceState = "loading";
  private failure: LocalPersistenceError | null = null;
  private readonly listeners = new Set<(state: LocalPersistenceState) => void>();
  private readonly timer: ReturnType<typeof setTimeout>;
  private settle: ((failure: LocalPersistenceError | null) => void) | null = null;

  /** Resolves once the stored document has been loaded into `doc`; rejects with a `LocalPersistenceError`. */
  readonly whenSynced: Promise<void>;

  constructor(
    private readonly doc: FlowDocument,
    private readonly storageName = "microflow-local-flow",
    options: IndexeddbSyncAdapterOptions = {},
  ) {
    this.whenSynced = new Promise<void>((resolve, reject) => {
      this.settle = (failure) => {
        this.settle = null;
        if (failure) reject(failure);
        else resolve();
      };
    });
    // The rejection is for callers that wait; when nobody awaits it, it must
    // not become an unhandled rejection. Reporting is `fail`'s and `destroy`'s job.
    this.whenSynced.catch(() => {});

    this.timer = setTimeout(() => this.stall(), options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS);

    // `y-indexeddb` chains `.then` on its open promise without a catch and
    // only ever emits `synced`: a failed open is an unhandled rejection plus
    // a `whenSynced` that never settles. Probing first turns the common
    // failures (no IndexedDB, private mode, blocked site data) into a clean
    // rejection before the library is involved.
    probeIndexedDb().then(
      () => this.attach(),
      (cause: unknown) => this.fail(new LocalPersistenceError("open-failed", { cause })),
    );
  }

  get state(): LocalPersistenceState {
    return this.loadState;
  }

  /** Why the load is unconfirmed (`stalled`) or failed (`failed`); `null` while loading or once synced. */
  get error(): LocalPersistenceError | null {
    return this.failure;
  }

  /** Called on every `state` change; returns an unsubscribe function. */
  onStateChange(listener: (state: LocalPersistenceState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Hand the doc to `y-indexeddb` whenever the probe answers, including after
   * a timeout. Edits made before this point are not lost: on load the library
   * first stores the doc's full current state, then applies the stored
   * updates on top.
   */
  private attach(): void {
    if (this.destroyed) return;
    const persistence = new IndexeddbPersistence(this.storageName, this.doc.doc);
    this.persistence = persistence;

    persistence.once("synced", () => {
      if (this.destroyed) return;
      // The load boundary, same as the server's room store: a document
      // stored before ADR-0019 is brought onto the nested node shape here,
      // so nothing downstream needs a compatibility branch.
      upgradeLegacyNodes(this.doc.doc);
      this.succeed();
    });

    // The probe passed but this store can still fail to open (a newer schema
    // version, a corrupt store). The library's own unhandled rejection
    // carries the same cause, which `reportError` then skips.
    persistence._db.catch((cause: unknown) => {
      this.fail(new LocalPersistenceError("open-failed", { cause }));
    });
  }

  /** The timeout passed: waiting callers stop waiting, persistence keeps trying. Not reported (yet). */
  private stall(): void {
    if (this.loadState !== "loading") return;
    this.failure = new LocalPersistenceError("timeout");
    this.transition("stalled");
    this.settle?.(this.failure);
  }

  private succeed(): void {
    if (this.loadState === "synced" || this.loadState === "failed") return;
    clearTimeout(this.timer);
    this.failure = null;
    this.transition("synced");
    this.settle?.(null);
  }

  private fail(error: LocalPersistenceError): void {
    if (this.destroyed || this.loadState === "synced" || this.loadState === "failed") return;
    clearTimeout(this.timer);
    this.failure = error;
    this.transition("failed");
    this.settle?.(error);
    // Learn about it even when no caller awaits `whenSynced` (the editor
    // mounts the local session without waiting on it).
    reportError(error, { source: "local-persistence" });
  }

  private transition(state: LocalPersistenceState): void {
    this.loadState = state;
    for (const listener of this.listeners) listener(state);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.timer);
    // A load that stalled and never completed in this adapter's lifetime is a
    // confirmed failure; one closed early within its timeout is not.
    if (this.loadState === "stalled" && this.failure) {
      reportError(this.failure, { source: "local-persistence" });
    }
    this.settle?.(new LocalPersistenceError("destroyed"));
    this.listeners.clear();
    // Detaches the doc observer and closes the database handle. Updates
    // already applied are durable; there is no final flush to wait on.
    this.persistence?.destroy().catch(() => {
      // The open failed, so there is no handle to close; already reported.
    });
  }
}

/** A throwaway database: opening it proves IndexedDB works here without touching any flow store. */
export const PROBE_DB = "microflow-idb-probe";

/**
 * Resolves when this origin can open an IndexedDB database; rejects with the
 * browser's error otherwise. A blocked open stays pending; the adapter's
 * timeout then moves it to `stalled` while the probe keeps waiting.
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
