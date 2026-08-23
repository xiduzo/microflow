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
  /** Replace the persisted state for `flowId`. */
  save(flowId: string, state: Uint8Array): Promise<void>;
};

/**
 * In-memory `RoomStore`. Mirrors the `RecordingSyncAdapter` / `TestIoLoop`
 * discipline: it records what the room asked it to do so tests can assert on
 * persistence without a database.
 */
export class MemoryRoomStore implements RoomStore {
  private readonly states = new Map<string, Uint8Array>();
  /** Every `save` in order — length is the number of persists that happened. */
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
    this.states.set(flowId, state);
    this.saves.push({ flowId, state });
  }
}
