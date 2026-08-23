import { db } from "@microflow/db";
import { flow } from "@microflow/db/schema/flow";
import { eq } from "drizzle-orm";
import type { RoomStore } from "./room-store";

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

  async save(flowId, state) {
    await db
      .update(flow)
      .set({ ydoc: Buffer.from(state), updatedAt: new Date() })
      .where(eq(flow.id, flowId));
  },
};
