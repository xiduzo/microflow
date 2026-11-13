import * as Y from "yjs";
import { FlowDocument, SyncProvider, upgradeLegacyNodes } from "@microflow/collab";
import { IndexeddbSyncAdapter } from "./indexeddb-sync-adapter";
import { readOnlyDocument } from "./read-only-document";
import {
  SessionStatusMachine,
  bindSessionStatus,
  constantSessionStatus,
  initialSessionStatusState,
  localSessionStatus,
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
  // so ctrl-Z cannot unwind into an empty document. The seed is a load
  // boundary like IndexedDB and the room store: a snapshot persisted before
  // ADR-0019 holds plain-object nodes `FlowDocument` cannot read, so it is
  // brought forward here, before anything materialises a node.
  if (options.initialData) {
    Y.applyUpdate(doc.doc, options.initialData);
    upgradeLegacyNodes(doc.doc);
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
      onDestroy();
      sync.destroy();
      doc.destroy();
    },
  };
  writableDocs.set(session, doc);
  return session;
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
