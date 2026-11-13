import { CLOSE_SERVICE_RESTART, type SyncProviderEvents, type SyncState } from "@microflow/collab";

/**
 * Flow Session Status — the one answer to "can I trust what I see, and will
 * my edits keep?".
 *
 * Before this module the answer was smeared across the transport's `state`,
 * an `error`, two provider events nobody listened to (`ack`, `accessDenied`)
 * and a role read once at page load. The editor showed none of it, so a
 * demoted editor kept typing into edits the room dropped, and an expired
 * token retried forever behind a spinner.
 *
 * The module is a small state machine. Its interface is three things:
 *
 * - `SessionStatusEvent` — what the transport says happened.
 * - `FlowSessionStatus` — the derived snapshot the editor renders.
 * - `SessionStatusStore` — `getSnapshot` / `subscribe`, the shape
 *   `useSyncExternalStore` reads.
 *
 * `reduceSessionStatus` holds all the behaviour and is pure; `bindSessionStatus`
 * is the adapter from a `SyncProvider` to events. Tests drive either seam.
 */

export type SessionStatusKind =
  /** A local flow: saved on this device, nothing to connect to. */
  | "local"
  /** A local flow whose on-device storage failed: edits are not kept. */
  | "local-unsaved"
  /** First connection attempt in progress. */
  | "connecting"
  /** Socket open, sync handshake not finished. */
  | "syncing"
  /** Live, nothing outstanding, no save confirmed yet this session. */
  | "connected"
  /** Live; edits reached the room but are not yet durably stored. */
  | "saving"
  /** Live; the room confirmed everything we sent is stored. */
  | "saved"
  /** Live, but the room accepts no writes from us. */
  | "read-only"
  /** Was connected (or failed to), retrying. Edits are held locally. */
  | "offline"
  /** The server refused us and will keep refusing. Retrying stopped. */
  | "access-lost";

export type FlowSessionStatus = {
  readonly kind: SessionStatusKind;
  /** The canvas must not accept edits. Live: flips on demotion/promotion. */
  readonly readOnly: boolean;
  /**
   * Local edits the room has not received yet — made while offline (or after
   * access was lost). Cloud flows have no local persistence (ADR-0020), so a
   * reload loses these; the number exists so that is visible.
   */
  readonly unsyncedChanges: number;
  /** Persist time from the room's last ack, when one carried a time. */
  readonly lastSavedAt: number | null;
  /** Set only in `access-lost`: why, and the close code that said so. */
  readonly accessLost: { readonly reason: string; readonly code: number } | null;
  /**
   * Offline because the server is restarting (close 1012) — expected, and
   * the transport is already reconnecting. Not an error.
   */
  readonly serverRestarting: boolean;
  /** Set only in `local-unsaved`: why the local flow is not being stored. */
  readonly localError: string | null;
  /**
   * The room's last save failed and it is retrying (`MESSAGE_UNSAVED`
   * "failed"). Edits are held in server memory only until a retry lands.
   */
  readonly saveFailing: boolean;
};

export type SessionStatusEvent =
  | { type: "transport"; state: SyncState }
  | { type: "local-update" }
  | { type: "ack"; at: number }
  /** The room withdrew its ack: changes pending a save, or a failed save. */
  | { type: "unsaved"; reason: "pending" | "failed" }
  | { type: "access"; access: "read" | "write" }
  | { type: "access-denied"; reason: string; code: number }
  /** The server closed the socket and the transport is retrying. */
  | { type: "dropped"; code: number };

/** Everything the reducer remembers; `FlowSessionStatus` is derived from it. */
export type SessionStatusState = {
  readonly transport: SyncState;
  /** Whether the transport has ever reached `synced`, or ever dropped. */
  readonly hasConnectedOrFailed: boolean;
  readonly readOnly: boolean;
  readonly accessLost: FlowSessionStatus["accessLost"];
  /** Close code of the last retryable server close; cleared on sync. */
  readonly lastDropCode: number | null;
  /** Edits made while not synced: not on the server yet. */
  readonly pendingDelivery: number;
  /** Edits on the server, awaiting the room's persistence ack. */
  readonly pendingSave: number;
  /** An ack has cleared `pendingSave` at least once since it last grew. */
  readonly confirmed: boolean;
  /** The room said it holds unsaved changes; cleared by the next ack. */
  readonly roomUnsaved: boolean;
  /** …because a save failed. */
  readonly saveFailing: boolean;
  readonly lastSavedAt: number | null;
};

export function initialSessionStatusState(options: { readOnly: boolean }): SessionStatusState {
  return {
    transport: "connecting",
    hasConnectedOrFailed: false,
    readOnly: options.readOnly,
    accessLost: null,
    lastDropCode: null,
    pendingDelivery: 0,
    pendingSave: 0,
    confirmed: false,
    roomUnsaved: false,
    saveFailing: false,
    lastSavedAt: null,
  };
}

/**
 * The state machine. Pure: same state and event, same result.
 *
 * "Saved" follows the room: it acks only when settled (nothing dirty, no save
 * in flight) and says "unsaved" on join when it is not, or when a save fails.
 * One window remains: an edit of ours still in flight to the server when the
 * room's ack leaves it is cleared by that ack; the room is dirty again, and
 * its next settled ack is the truth, one debounce period later.
 */
export function reduceSessionStatus(
  state: SessionStatusState,
  event: SessionStatusEvent,
): SessionStatusState {
  switch (event.type) {
    case "transport": {
      const next = { ...state, transport: event.state };
      if (event.state === "disconnected") return { ...next, hasConnectedOrFailed: true };
      // A new attempt after a terminal close only happens on an explicit
      // reconnect; show it as connecting, and a repeat refusal sets it again.
      if (event.state === "connecting") return { ...next, accessLost: null };
      if (event.state === "synced") {
        const synced = { ...next, accessLost: null, lastDropCode: null, hasConnectedOrFailed: true };
        // Read-only: the room dropped our half of the handshake (it accepts
        // no writes from us), so edits held while offline are still only
        // here. Keep counting them — "0 unsynced" would be a lie.
        if (state.readOnly) return synced;
        // The handshake exchanged state vectors in both directions, so edits
        // held while offline are on the server now — awaiting persistence.
        const delivered = state.pendingDelivery;
        return {
          ...synced,
          pendingDelivery: 0,
          pendingSave: state.pendingSave + delivered,
          confirmed: delivered > 0 ? false : state.confirmed,
        };
      }
      return next;
    }
    case "local-update":
      if (state.transport === "synced" && state.accessLost === null && !state.readOnly) {
        return { ...state, pendingSave: state.pendingSave + 1, confirmed: false };
      }
      return { ...state, pendingDelivery: state.pendingDelivery + 1 };
    case "ack":
      return {
        ...state,
        pendingSave: 0,
        confirmed: true,
        roomUnsaved: false,
        saveFailing: false,
        lastSavedAt: event.at > 0 ? event.at : state.lastSavedAt,
      };
    case "unsaved":
      return {
        ...state,
        confirmed: false,
        roomUnsaved: true,
        saveFailing: event.reason === "failed",
      };
    case "dropped":
      return { ...state, lastDropCode: event.code };
    case "access":
      return { ...state, readOnly: event.access === "read" };
    case "access-denied":
      return {
        ...state,
        transport: "disconnected",
        hasConnectedOrFailed: true,
        accessLost: { reason: event.reason, code: event.code },
      };
  }
}

export function deriveSessionStatus(state: SessionStatusState): FlowSessionStatus {
  return {
    kind: kindOf(state),
    readOnly: state.readOnly || state.accessLost !== null,
    unsyncedChanges: state.pendingDelivery,
    lastSavedAt: state.lastSavedAt,
    accessLost: state.accessLost,
    serverRestarting:
      state.accessLost === null &&
      state.transport !== "synced" &&
      state.lastDropCode === CLOSE_SERVICE_RESTART,
    saveFailing: state.saveFailing && state.transport === "synced" && !state.readOnly,
    localError: null,
  };
}

function kindOf(state: SessionStatusState): SessionStatusKind {
  if (state.accessLost) return "access-lost";
  switch (state.transport) {
    case "synced":
      if (state.readOnly) return "read-only";
      if (state.pendingSave > 0 || state.roomUnsaved) return "saving";
      return state.confirmed ? "saved" : "connected";
    case "syncing":
      return "syncing";
    case "connecting":
    case "disconnected":
      return state.hasConnectedOrFailed ? "offline" : "connecting";
  }
}

// ----------------------------------------------------------------------------
// Store
// ----------------------------------------------------------------------------

export type SessionStatusStore = {
  getSnapshot(): FlowSessionStatus;
  subscribe(listener: () => void): () => void;
};

/**
 * The reducer behind a subscribable store. Snapshots keep their identity until
 * something observable changes, so `useSyncExternalStore` re-renders only then.
 */
export class SessionStatusMachine implements SessionStatusStore {
  private state: SessionStatusState;
  private snapshot: FlowSessionStatus;
  private readonly listeners = new Set<() => void>();

  constructor(initial: SessionStatusState) {
    this.state = initial;
    this.snapshot = deriveSessionStatus(initial);
  }

  dispatch(event: SessionStatusEvent): void {
    this.state = reduceSessionStatus(this.state, event);
    const next = deriveSessionStatus(this.state);
    if (statusEqual(next, this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  getSnapshot = (): FlowSessionStatus => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

function statusEqual(a: FlowSessionStatus, b: FlowSessionStatus): boolean {
  return (
    a.kind === b.kind &&
    a.readOnly === b.readOnly &&
    a.unsyncedChanges === b.unsyncedChanges &&
    a.lastSavedAt === b.lastSavedAt &&
    a.serverRestarting === b.serverRestarting &&
    a.saveFailing === b.saveFailing &&
    a.accessLost?.reason === b.accessLost?.reason &&
    a.accessLost?.code === b.accessLost?.code
  );
}

const LOCAL_STATUS: Omit<FlowSessionStatus, "readOnly"> = {
  kind: "local",
  unsyncedChanges: 0,
  lastSavedAt: null,
  accessLost: null,
  serverRestarting: false,
  localError: null,
  saveFailing: false,
};

/** A status that never changes: previews, and sessions with no persistence to fail. */
export function constantSessionStatus(readOnly: boolean): SessionStatusStore {
  const snapshot: FlowSessionStatus = { ...LOCAL_STATUS, readOnly };
  return { getSnapshot: () => snapshot, subscribe: () => () => {} };
}

/**
 * The status of a local flow, given its persistence's load promise
 * (`IndexeddbSyncAdapter.whenSynced`).
 *
 * Nobody awaits that promise in the editor — the canvas mounts at once — so
 * a store that cannot open (private browsing, blocked site data, another tab
 * holding it) used to leave the user editing a flow that was never saved, in
 * silence. A rejection here turns the status into `local-unsaved` with the
 * failure's message; editing stays possible, the header says it won't keep.
 * A rejection whose `reason` is `"destroyed"` is a teardown, not a failure.
 */
export function localSessionStatus(whenSynced: Promise<void>): SessionStatusStore {
  let snapshot: FlowSessionStatus = { ...LOCAL_STATUS, readOnly: false };
  const listeners = new Set<() => void>();
  whenSynced.catch((error: unknown) => {
    if ((error as { reason?: unknown } | null)?.reason === "destroyed") return;
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Local storage (IndexedDB) is unavailable.";
    snapshot = { ...snapshot, kind: "local-unsaved", localError: message };
    for (const listener of listeners) listener();
  });
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ----------------------------------------------------------------------------
// Adapter: SyncProvider → events
// ----------------------------------------------------------------------------

type SourceEvents = Pick<
  SyncProviderEvents,
  "state" | "ack" | "unsaved" | "access" | "accessDenied" | "localUpdate" | "dropped"
>;

/** The slice of `SyncProvider` the status needs. A fake satisfies it in tests. */
export type SessionStatusSource = {
  readonly state: SyncState;
  readonly access: "read" | "write" | null;
  on<K extends keyof SourceEvents>(event: K, callback: SourceEvents[K]): () => void;
};

/** Feed a machine from a source. Returns the unsubscribe. */
export function bindSessionStatus(
  machine: SessionStatusMachine,
  source: SessionStatusSource,
): () => void {
  // Catch up: the source may have moved before we subscribed.
  machine.dispatch({ type: "transport", state: source.state });
  if (source.access) machine.dispatch({ type: "access", access: source.access });

  const unsubs = [
    source.on("state", (state) => machine.dispatch({ type: "transport", state })),
    source.on("localUpdate", () => machine.dispatch({ type: "local-update" })),
    source.on("ack", (at) => machine.dispatch({ type: "ack", at })),
    source.on("unsaved", (reason) => machine.dispatch({ type: "unsaved", reason })),
    source.on("dropped", (code) => machine.dispatch({ type: "dropped", code })),
    source.on("access", (access) => machine.dispatch({ type: "access", access })),
    source.on("accessDenied", (reason, code) =>
      machine.dispatch({ type: "access-denied", reason, code }),
    ),
  ];
  return () => unsubs.forEach((unsub) => unsub());
}
