import { db } from "@microflow/db";
import { flow } from "@microflow/db/schema/flow";
import { eq } from "drizzle-orm";
import { mergeDocumentStates, type RoomStore } from "./room-store";

/**
 * Production `RoomStore`: the Yjs document lives in `flow.ydoc`.
 *
 * The only file in this package that imports the database — `YjsServer`
 * takes the store as a constructor argument, so room lifecycle and
 * persistence policy stay testable without one.
 */
export const drizzleRoomStore: RoomStore = {
  async load(flowId) {
    const record = await db.query.flow.findFirst({ where: eq(flow.id, flowId) });
    return record?.ydoc ? new Uint8Array(record.ydoc) : null;
  },

  /**
   * Merge into the row under a row lock, so a save from another instance
   * (an overlapping deploy) can neither be overwritten nor interleave between
   * our read and our write. A deleted flow has no row and the save is a no-op.
   */
  async save(flowId, state) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ ydoc: flow.ydoc })
        .from(flow)
        .where(eq(flow.id, flowId))
        .for("update");
      if (!row) return;

      const merged = mergeDocumentStates(row.ydoc ? new Uint8Array(row.ydoc) : null, state);
      await tx
        .update(flow)
        .set({ ydoc: Buffer.from(merged), updatedAt: new Date() })
        .where(eq(flow.id, flowId));
    });
  },
};
