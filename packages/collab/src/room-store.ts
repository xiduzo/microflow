import * as Y from "yjs";

/**
 * Persistence seam for Yjs rooms.
 *
 * `YjsServer` holds rooms, awareness and the debounce policy; where the
 * document actually lives sits behind this interface. Two adapters satisfy
 * it: `drizzleRoomStore` in production (see `drizzle-room-store.ts`, which
 * is the only file in this package that touches the database) and
 * `MemoryRoomStore` in tests.
 */
export type RoomStore = {
  /** The persisted document state, or `null` for a room that has never been saved. */
  load(flowId: string): Promise<Uint8Array | null>;
  /**
   * Merge `state` into the persisted state for `flowId` — never replace it.
   *
   * Two rooms can hold the same flow: the old and new instance overlap during
   * a deploy, and the old one's final save can land after the new one has
   * accepted edits. A replace would erase those edits. A merge cannot: Yjs
   * updates are commutative and idempotent, so the store converges on the
   * union whatever order saves land in. See `mergeDocumentStates`.
   */
  save(flowId: string, state: Uint8Array): Promise<void>;
};

/**
 * The union of two document states, re-encoded through a scratch doc so the
 * result is as compact as a fresh `encodeStateAsUpdate` (deleted content is
 * garbage-collected rather than carried forward from either side).
 */
export function mergeDocumentStates(stored: Uint8Array | null, incoming: Uint8Array): Uint8Array {
  if (!stored || stored.byteLength === 0) return incoming;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, stored);
    Y.applyUpdate(doc, incoming);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * In-memory `RoomStore`. Mirrors the `RecordingSyncAdapter` / `TestIoLoop`
 * discipline: it records what the room asked it to do so tests can assert on
 * persistence without a database. Saves merge, as the production store does.
 */
export class MemoryRoomStore implements RoomStore {
  private readonly states = new Map<string, Uint8Array>();
  /** Every `save` in order, as sent — length is the number of persists that happened. */
  readonly saves: Array<{ flowId: string; state: Uint8Array }> = [];

  constructor(seed?: Record<string, Uint8Array>) {
    for (const [flowId, state] of Object.entries(seed ?? {})) {
      this.states.set(flowId, state);
    }
  }

  async load(flowId: string): Promise<Uint8Array | null> {
    return this.states.get(flowId) ?? null;
  }

  async save(flowId: string, state: Uint8Array): Promise<void> {
    this.states.set(flowId, mergeDocumentStates(this.states.get(flowId) ?? null, state));
    this.saves.push({ flowId, state });
  }
}
