import * as Y from "yjs";
import { FlowDocument, SyncProvider } from "@microflow/collab";
import { reportError } from "@/lib/report-error";
import { startHandlePruning, type HandleSets } from "./handle-pruning";
import { IndexeddbSyncAdapter } from "./indexeddb-sync-adapter";
import { readOnlyDocument } from "./read-only-document";
import {
  SessionStatusMachine,
  bindSessionStatus,
  constantSessionStatus,
  initialSessionStatusState,
  localSessionStatus,
  type FlowSessionStatus,
  type SessionStatusStore,
} from "./session-status";
import type { RemoteSyncAdapter, SyncAdapter } from "./sync-adapter";

export type FlowMode = "local" | "cloud";

/**
 * The access level the local user has on this session's flow — mirrors the
 * server's Flow Role. `null` for surfaces where the notion doesn't apply
 * (local flows, previews); those are governed by `readOnly` alone.
 */
export type FlowRole = "viewer" | "editor" | "owner";

export type FlowSession = {
  readonly flowId: string;
  readonly mode: FlowMode;
  /** The local user's Flow Role on a cloud flow; `null` otherwise. */
  readonly role: FlowRole | null;
  /**
   * True when node components must not write back to the doc. Three sources:
   * preview/thumbnail surfaces, a cloud flow the local user only has Viewer
   * access to, and a live access change the room announced (demotion, or
   * access lost) — see `withLiveAccess`. The Yjs room drops a Viewer's writes,
   * so letting the editor accept them locally would silently diverge the two
   * documents.
   *
   * Consumed by `useNodeControls` (suppresses the Leva→Yjs commit effect),
   * `ReactFlowBridge` (suppresses structural writes) and the canvas
   * (disables dragging, connecting and deleting).
   */
  readonly readOnly: boolean;
  readonly doc: FlowDocument;
  readonly sync: SyncAdapter;
  /** Flow Session Status: connection, saving, access. See `session-status.ts`. */
  readonly status: SessionStatusStore;
  destroy(): void;
};

export function createLocalSession(): FlowSession {
  const doc = FlowDocument.createEmpty();
  doc.setMeta({ name: "Local Flow", description: "Local development flow" });
  const sync = new IndexeddbSyncAdapter(doc);
  return makeSession("local", "local", doc, sync, false, null, localSessionStatus(sync));
}

export type CreateCloudSessionOptions = {
  flowId: string;
  wsUrl: string;
  user: { id: string; name: string; color?: string; icon?: string; isSupporter?: boolean };
  /**
   * Bearer token reader, called before every connection attempt so a
   * refreshed token is picked up on reconnect. Desktop only; the web relies
   * on the session cookie.
   */
  getAuthToken?: () => string | undefined;
  /**
   * Ask the auth client to refresh the session after the server rejected it
   * (1008). Awaited before each bounded re-auth attempt. See `SyncProvider`.
   */
  refreshAuth?: () => Promise<unknown>;
  /** A server-side snapshot to seed the doc with before the socket syncs. */
  initialData?: Uint8Array;
  /** The local user's Flow Role, from `flow.get`. Viewers get a read-only session. */
  role?: FlowRole;
};

/**
 * The session never writes flow meta on open. The server seeds `meta.name`
 * when it creates the document and owns it from there; a client writing the
 * row's name back on every open was a second owner whose write raced the
 * seed, generated an update per open, and was dropped for Viewers anyway.
 */
export function createCloudSession(options: CreateCloudSessionOptions): FlowSession {
  const doc = FlowDocument.createEmpty();
  // Seed before the socket syncs, and keep the seed out of the undo history
  // so ctrl-Z cannot unwind into an empty document. A seed persisted before
  // ADR-0019 is deliberately NOT upgraded here: the server upgrades the room
  // when it loads it and syncs that down, and a second, client-side upgrade
  // would race it (two maps per node; the loser's pre-sync edits dropped).
  // `FlowDocument` reads the old shape until the server's upgrade arrives.
  if (options.initialData) {
    Y.applyUpdate(doc.doc, options.initialData);
    doc.clearHistory();
  }
  const provider = new SyncProvider({
    flowId: options.flowId,
    doc: doc.doc,
    wsUrl: options.wsUrl,
    user: options.user,
    authToken: options.getAuthToken,
    refreshAuth: options.refreshAuth,
  });
  // `SyncProvider` satisfies the adapter port directly; the annotation is the
  // compile-time proof.
  const sync: RemoteSyncAdapter = provider;
  const role = options.role ?? null;
  const readOnly = role === "viewer";

  const status = new SessionStatusMachine(initialSessionStatusState({ readOnly }));
  const unbind = bindSessionStatus(status, provider);

  return makeSession("cloud", options.flowId, doc, sync, readOnly, role, status, unbind);
}

/** The writable document behind a session, for `withLiveAccess`. */
const writableDocs = new WeakMap<FlowSession, FlowDocument>();

/** What sessions made from here on prune vanished handles with. See {@link provideHandleSets}. */
let handleSets: HandleSets | null = null;

/**
 * Tell the session vertical which handles a node offers, so that sessions can
 * remove the edges of a handle that vanishes (`startHandlePruning`).
 *
 * The session knows documents and nothing about nodes, and must not import
 * them, so the app's entry point hands this in once, before the first session
 * is made (`main.tsx` passes `nodeHandles`). It is app-wide and not a
 * parameter of each session because every maker of a session has to agree:
 * sessions are shared through the registry, and one made without it (to save
 * a template into the local flow, say) is the same session the editor then
 * opens.
 *
 * A session reads it when it starts pruning. Without it a session repairs
 * dangling edges only, which is a wiring mistake and is reported as one (see
 * `reportMissingHandleSets`). Pass `null` to take it away again (tests).
 */
export function provideHandleSets(of: HandleSets | null): void {
  handleSets = of;
  missingHandleSetsReported = false;
}

let missingHandleSetsReported = false;

/**
 * A writable session is starting and nobody has said what a node's handles
 * are. Nothing else would show it: the session works, and edges at handles a
 * settings change removes simply stay. So it goes to the app's failure surface
 * (`reportError`, ADR-0029), once, not once per session.
 */
function reportMissingHandleSets(): null {
  if (!missingHandleSetsReported) {
    missingHandleSetsReported = true;
    reportError(
      new Error(
        "A writable flow session started before provideHandleSets was called: edges at handles a settings change removes will not be pruned.",
      ),
      { source: "action" },
    );
  }
  return null;
}

export function makeSession(
  mode: FlowMode,
  flowId: string,
  doc: FlowDocument,
  sync: SyncAdapter,
  readOnly: boolean,
  role: FlowRole | null = null,
  status: SessionStatusStore = constantSessionStatus(readOnly),
  onDestroy: () => void = () => {},
): FlowSession {
  let destroyed = false;
  const stopEdgePruning = pruneWhileWritable(doc, status);
  const session: FlowSession = {
    flowId,
    mode,
    role,
    readOnly,
    // One write-guard for every call site that reaches the doc directly.
    doc: readOnly ? readOnlyDocument(doc) : doc,
    sync,
    status,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stopEdgePruning();
      onDestroy();
      sync.destroy();
      doc.destroy();
    },
  };
  writableDocs.set(session, doc);
  return session;
}

/**
 * Whether a change that arrives from outside is a peer editing right now: the
 * session is in sync with its room. In every other state what arrives is the
 * document loading or catching up (a local flow has no peers at all). Handle
 * pruning treats the two differently; see `startHandlePruning`.
 */
function peersAreLive(status: FlowSessionStatus): boolean {
  return status.kind === "connected" || status.kind === "saving" || status.kind === "saved";
}

/**
 * Keep `doc` free of edges that attach to nothing, for as long as this client
 * may write. Two repairs run side by side:
 *
 * - dangling edges: a node delete racing a peer's new edge
 *   (`FlowDocument.startEdgePruning`);
 * - vanished handles: a settings change that takes a handle off a node
 *   (`startHandlePruning`), with the handle sets the app provided
 *   (`provideHandleSets`).
 *
 * Pruning belongs to the session, not the canvas: an Editor's document must
 * repair itself whether or not a canvas is mounted. It follows the live
 * `readOnly` of the session status, so a Viewer never prunes, a demotion or a
 * lost access stops it, and a promotion starts it. Previews are constant
 * read-only and never prune. Returns the stop function for `destroy`.
 */
function pruneWhileWritable(doc: FlowDocument, status: SessionStatusStore): () => void {
  let stop: (() => void) | null = null;
  const follow = () => {
    const writable = !status.getSnapshot().readOnly;
    if (writable && stop === null) {
      const stopEdges = doc.startEdgePruning();
      const stopHandles = handleSets
        ? startHandlePruning(doc, handleSets, {
            isLive: () => peersAreLive(status.getSnapshot()),
            subscribe: (listener) => status.subscribe(listener),
          })
        : reportMissingHandleSets();
      stop = () => {
        stopEdges();
        stopHandles?.();
      };
    } else if (!writable && stop !== null) {
      stop();
      stop = null;
    }
  };
  follow();
  const unsubscribe = status.subscribe(follow);
  return () => {
    unsubscribe();
    stop?.();
    stop = null;
  };
}

/**
 * The session as the editor should see it, given the access the room states
 * right now.
 *
 * A session is built with the role `flow.get` returned at page load. The room
 * can change that live (ADR-0015): a demotion must stop the canvas accepting
 * edits the room will drop, and a promotion should let a Viewer edit without a
 * reload. Returns `session` itself when nothing differs, otherwise a view that
 * shares its doc, sync and status — never destroy the view; the registry owns
 * the original.
 */
export function withLiveAccess(session: FlowSession, readOnly: boolean): FlowSession {
  if (session.readOnly === readOnly) return session;
  const writable = writableDocs.get(session);
  if (!writable) return session;
  let role = session.role;
  if (readOnly && role !== null) role = "viewer";
  if (!readOnly && role === "viewer") role = "editor";
  return {
    ...session,
    role,
    readOnly,
    doc: readOnly ? readOnlyDocument(writable) : writable,
    destroy: () => {},
  };
}
