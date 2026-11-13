import { describe, expect, test } from "bun:test";
import * as decoding from "lib0/decoding";

import { YjsServer } from "./yjs-server";
import { MemoryRoomStore } from "./room-store";
import { ACCESS_CODES, MESSAGE_ACCESS } from "./protocol";

/**
 * `MESSAGE_ACCESS` is how a client learns what the room will accept from it.
 * Without it a demotion is silent: the room drops the writes, the editor keeps
 * accepting them, and the two documents drift.
 */

async function join(server: YjsServer, userId: string, canWrite: boolean) {
  const received: Uint8Array[] = [];
  await server.join("flow-1", { send: (d) => received.push(d), close: () => {} }, userId, canWrite);
  return {
    accessFrames(): string[] {
      return received.flatMap((frame) => {
        const decoder = decoding.createDecoder(frame);
        if (decoding.readVarUint(decoder) !== MESSAGE_ACCESS) return [];
        return [ACCESS_CODES[decoding.readVarUint(decoder)]!];
      });
    },
  };
}

describe("YjsServer access message", () => {
  test("join states the granted access", async () => {
    const server = new YjsServer({ store: new MemoryRoomStore() });
    const editor = await join(server, "editor", true);
    const viewer = await join(server, "viewer", false);

    expect(editor.accessFrames()).toEqual(["write"]);
    expect(viewer.accessFrames()).toEqual(["read"]);
  });

  test("setAccess tells the affected connection, and only it", async () => {
    const server = new YjsServer({ store: new MemoryRoomStore() });
    const demoted = await join(server, "bob", true);
    const bystander = await join(server, "carol", true);

    server.setAccess("flow-1", "bob", "read");
    server.setAccess("flow-1", "bob", "write");

    expect(demoted.accessFrames()).toEqual(["write", "read", "write"]);
    expect(bystander.accessFrames()).toEqual(["write"]);
  });
});
